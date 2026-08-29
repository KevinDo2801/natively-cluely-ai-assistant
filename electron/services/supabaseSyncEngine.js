/**
 * supabaseSyncEngine — shared SQLite → Supabase sync engine (CommonJS).
 *
 * Reads Natively's local SQLite database (the schema produced by
 * electron/db/migrations.ts) and upserts the user-owned rows into the Supabase
 * project schema (supabase/migrations/0001_initial_schema.sql).
 *
 * This file is deliberately plain CommonJS with NO Electron and NO TypeScript
 * imports so BOTH consumers can load it:
 *
 *   1. The in-app SupabaseSyncService (Electron main process, bundled by
 *      esbuild) imports it and passes DatabaseManager's live connection.
 *   2. The CLI script scripts/supabase/sync-local-to-supabase.cjs runs under
 *      Electron's Node runtime (`electron scripts/...`) so the repo's
 *      better-sqlite3 (compiled for Electron's ABI) loads, and passes a
 *      connection it opened itself.
 *
 * Types for TypeScript consumers live in supabaseSyncEngine.d.ts.
 *
 * Sync semantics (v1):
 *   - UPSERT by primary key: re-running is idempotent.
 *   - Rows are stamped with the target user's `user_id` (auth.users.id).
 *     The CLI uses the service_role key (bypasses RLS); the in-app service
 *     uses the signed-in user's JWT so RLS enforces ownership.
 *   - Parent tables are pushed before child tables so composite FKs
 *     (parent_id, user_id) are satisfiable.
 *   - Deletions made locally are NOT propagated (push-only). A future
 *     two-way sync can add tombstones.
 *   - float32 embedding BLOBs become pgvector arrays of whatever dimension
 *     they actually hold (768 for gemini-embedding-2 today); the real
 *     dimension is also recorded in `embedding_dims`.
 */

'use strict';

const DEFAULT_BATCH_SIZE = 500;

/**
 * Table push order + the exact local columns mirrored on Supabase.
 * `pk` overrides the default primary key column `id`.
 * `vector: '<col>'` marks a float32 BLOB column to convert to a pgvector
 * array (plus the derived `embedding_dims` column).
 */
const TABLE_DEFS = [
  { table: 'folders', columns: ['id', 'name', 'created_at'] },
  { table: 'user_profile', columns: ['id', 'structured_json', 'compact_persona', 'intro_short', 'intro_interview', 'created_at'] },
  {
    table: 'resume_nodes',
    columns: ['id', 'category', 'title', 'organization', 'start_date', 'end_date', 'duration_months', 'text_content', 'tags', 'embedding'],
    vector: 'embedding',
  },
  { table: 'modes', columns: ['id', 'name', 'template_type', 'custom_context', 'is_active', 'created_at', 'source_contract_json', 'is_builtin'] },
  { table: 'mode_note_sections', columns: ['id', 'mode_id', 'title', 'description', 'sort_order', 'compiled_prompt', 'created_at'] },
  { table: 'mode_reference_files', columns: ['id', 'mode_id', 'file_name', 'content', 'created_at', 'page_count', 'extracted_page_count'] },
  {
    table: 'meetings',
    columns: ['id', 'title', 'start_time', 'duration_ms', 'summary_json', 'created_at', 'calendar_event_id', 'source', 'is_processed', 'summary_status', 'embedding_provider', 'embedding_dimensions', 'embedding_space', 'user_titled', 'is_live', 'folder_id'],
  },
  { table: 'transcripts', columns: ['id', 'meeting_id', 'speaker', 'content', 'timestamp_ms'] },
  { table: 'ai_interactions', columns: ['id', 'meeting_id', 'type', 'timestamp', 'user_query', 'ai_response', 'metadata_json'] },
  {
    table: 'chunks',
    columns: ['id', 'meeting_id', 'chunk_index', 'speaker', 'start_timestamp_ms', 'end_timestamp_ms', 'cleaned_text', 'token_count', 'embedding', 'created_at'],
    vector: 'embedding',
  },
  { table: 'chunk_summaries', columns: ['id', 'meeting_id', 'summary_text', 'embedding', 'created_at'], vector: 'embedding' },
  {
    table: 'knowledge_sources',
    columns: ['id', 'type', 'file_id', 'mode_id', 'file_name', 'source_checksum', 'content_hash', 'created_at', 'indexed_at', 'page_count', 'extracted_page_count', 'index_version', 'embedding_space'],
  },
  { table: 'knowledge_packs', columns: ['id', 'source_id', 'mode_id', 'file_name', 'index_md', 'stats_json', 'pack_version', 'generated_by', 'updated_at'] },
  {
    table: 'knowledge_cards',
    columns: ['id', 'pack_id', 'source_id', 'type', 'title', 'slug', 'concept_id', 'body', 'body_markdown', 'source_pages_json', 'source_sections_json', 'source_quotes_json', 'entities_json', 'tags_json', 'related_card_ids_json', 'confidence', 'generated_from', 'source_checksum', 'user_edited', 'approval_status', 'pii', 'updated_at', 'card_version'],
  },
  { table: 'knowledge_card_versions', columns: ['id', 'card_id', 'card_version', 'title', 'body', 'entities_json', 'tags_json', 'confidence', 'edited_by', 'edit_reason', 'created_at'] },
  { table: 'knowledge_entities', columns: ['id', 'pack_id', 'slug', 'name', 'type', 'aliases_json', 'description', 'source_card_ids_json', 'source_pages_json', 'first_seen_at'] },
  { table: 'knowledge_relations', columns: ['id', 'pack_id', 'subject_id', 'subject_type', 'predicate', 'object_id', 'object_type', 'source_card_ids_json', 'source_pages_json', 'confidence', 'created_at'] },
  { table: 'knowledge_index_versions', columns: ['id', 'source_id', 'pack_id', 'pack_version', 'content_hash', 'embedding_space', 'status', 'error_message', 'created_at', 'updated_at'] },
  { table: 'assistant_claims', pk: 'claim_id', columns: ['claim_id', 'turn_id', 'claim_text', 'source_owner', 'requested_property', 'validation_status', 'evidence_ids_json', 'created_at', 'contradicted_by_claim_id'] },
  { table: 'turn_context_contracts', pk: 'turn_id', columns: ['turn_id', 'surface', 'active_mode_id', 'answer_shape', 'source_owner', 'requested_property', 'allowed_sources_json', 'forbidden_sources_json', 'memory_write_policy_json', 'created_at'] },
];

/** Converts a float32 BLOB (Buffer) into { embedding, embeddingDims }. */
function blobToVector(buf) {
  if (!buf || !(buf.length > 0)) return { embedding: null, embeddingDims: null };
  const n = Math.floor(buf.length / 4);
  if (n === 0 || n * 4 !== buf.length) return { embedding: null, embeddingDims: null };
  const arr = new Float32Array(n);
  for (let i = 0; i < n; i++) arr[i] = buf.readFloatLE(i * 4);
  return { embedding: Array.from(arr), embeddingDims: n };
}

/** Reads one local table into push-ready row objects (user_id stamped later). */
function readLocalRows(db, def) {
  const { table, columns } = def;
  const quoted = columns.map((c) => `"${c}"`).join(', ');
  const rows = db.prepare(`SELECT ${quoted} FROM "${table}"`).all();
  if (!def.vector) return rows;

  const out = [];
  for (const row of rows) {
    const vec = blobToVector(row[def.vector]);
    const mapped = {};
    for (const c of columns) {
      if (c === def.vector) {
        mapped.embedding = vec.embedding;
        mapped.embedding_dims = vec.embeddingDims;
      } else {
        mapped[c] = row[c] === undefined ? null : row[c];
      }
    }
    out.push(mapped);
  }
  return out;
}

/** Push one batch; on batch failure falls back to per-row upserts. */
async function upsertBatch(client, table, rows, pk) {
  const { error } = await client.from(table).upsert(rows, { onConflict: pk });
  if (!error) return { upserted: rows.length, failed: [] };

  // Fallback: isolate the offending row(s) so one bad row can't sink a table.
  let upserted = 0;
  const failed = [];
  for (const row of rows) {
    const res = await client.from(table).upsert(row, { onConflict: pk });
    if (res.error) failed.push({ id: row[pk], error: res.error.message });
    else upserted++;
  }
  return { upserted, failed };
}

/**
 * Push one local table's rows into Supabase for the given user.
 * @returns {{ table: string, rows: number, upserted: number, failed: Array, error: string|null }}
 */
async function syncTable({ db, client, userId, def, onProgress, dryRun, batchSize }) {
  const result = { table: def.table, rows: 0, upserted: 0, failed: [], error: null };
  let rows;
  try {
    rows = readLocalRows(db, def);
  } catch (e) {
    result.error = `read failed: ${e && e.message ? e.message : String(e)}`;
    return result;
  }
  result.rows = rows.length;
  if (!rows.length) return result;

  if (dryRun) {
    onProgress && onProgress({ table: def.table, phase: 'dry-run', rows: rows.length });
    return result;
  }

  const stamp = (row) => Object.assign({}, row, { user_id: userId });
  const pk = def.pk || 'id';
  for (let i = 0; i < rows.length; i += batchSize) {
    const batch = rows.slice(i, i + batchSize).map(stamp);
    onProgress && onProgress({ table: def.table, phase: 'pushing', done: i, total: rows.length });
    const { upserted, failed } = await upsertBatch(client, def.table, batch, pk);
    result.upserted += upserted;
    result.failed.push(...failed);
  }
  return result;
}

/**
 * Run a full local → cloud sync for one user.
 *
 * @param {object} opts
 * @param {object} opts.db       open better-sqlite3 Database
 * @param {object} opts.client   supabase-js client (service_role or user JWT)
 * @param {string} opts.userId   auth.users.id to stamp rows with
 * @param {Function} [opts.onProgress]  ({ table, phase, done, total, rows, error }) => void
 * @param {boolean} [opts.dryRun]       count + report without writing
 * @param {number} [opts.batchSize]     upsert batch size (default 500)
 * @returns {Promise<{ tables: Array, totalRows: number, totalUpserted: number, totalFailed: number }>}
 */
async function syncAll({ db, client, userId, onProgress, dryRun = false, batchSize = DEFAULT_BATCH_SIZE }) {
  if (!userId) throw new Error('syncAll: userId is required');
  const tables = [];
  let totalRows = 0;
  let totalUpserted = 0;
  let totalFailed = 0;

  for (const def of TABLE_DEFS) {
    const result = await syncTable({ db, client, userId, def, onProgress, dryRun, batchSize });
    tables.push(result);
    totalRows += result.rows;
    totalUpserted += result.upserted;
    totalFailed += result.failed.length;
    if (result.error) {
      onProgress && onProgress({ table: def.table, phase: 'error', error: result.error });
    }
  }
  return { tables, totalRows, totalUpserted, totalFailed };
}

module.exports = {
  TABLE_DEFS,
  DEFAULT_BATCH_SIZE,
  blobToVector,
  syncTable,
  syncAll,
};
