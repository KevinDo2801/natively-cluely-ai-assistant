/**
 * supabaseSyncEngine — shared SQLite ⇄ Supabase two-way sync engine (CommonJS).
 *
 * Reads Natively's local SQLite database (electron/db/migrations.ts) and the
 * Supabase project schema (supabase/migrations/0001 + 0002), then reconciles
 * the two sides with last-write-wins per row.
 *
 * This file is deliberately plain CommonJS with NO Electron and NO TypeScript
 * imports so BOTH consumers can load it:
 *
 *   1. The in-app SupabaseSyncService (Electron main process, bundled by
 *      esbuild) imports it and passes DatabaseManager's live connection.
 *   2. The CLI script scripts/supabase/sync-local-to-supabase.cjs runs under
 *      Electron's Node runtime (`electron scripts/...`) so the repo's
 *      better-sqlite3 (compiled for Electron's ABI) loads.
 *
 * Types for TypeScript consumers live in supabaseSyncEngine.d.ts.
 *
 * Sync model (v2 — two-way, LWW):
 *   - Every row carries `updated_at` on BOTH sides (local triggers stamp
 *     millisecond-precision ISO-8601 on INSERT/UPDATE — see migrations.ts
 *     v32→v33; cloud columns were added by migration 0002).
 *   - Deletions propagate through `sync_tombstones` tables on both sides
 *     (local DELETE triggers record them automatically; the engine mirrors
 *     markers across and hard-deletes rows).
 *   - Per key, the newest event wins: the newest row edit or the newest
 *     deletion. A deletion must be STRICTLY newer than the last edit to win
 *     (conservative — a stray tombstone can never erase a live edit).
 *     Timestamp ties leave both sides untouched.
 *   - When a side pulls a row or tombstone, the remote timestamp is preserved
 *     verbatim so the next sync is a no-op (no ping-pong).
 *   - Tombstones older than TOMBSTONE_TTL_MS are garbage-collected on both
 *     sides (30 days is far longer than the 5-minute sync interval).
 *   - Clock skew between devices is NOT solved beyond LWW; a machine with a
 *     clock far in the future wins conflicts until it is corrected.
 *
 * Known v2 limitations (documented, not bugs):
 *   - Pulled embeddings land in the chunks/chunk_summaries/resume_nodes BLOB
 *     columns; the local sqlite-vec per-dimension tables are refreshed by the
 *     app's own re-index paths, not by the engine.
 *   - "Clear all data" is a bulk delete — its tombstones propagate, so it now
 *     also clears the cloud copy. That is the intended two-way semantics.
 */

'use strict';

const DEFAULT_BATCH_SIZE = 500;
const TOMBSTONE_TTL_MS = 30 * 24 * 60 * 60 * 1000;

/**
 * Per-request bound for PostgREST calls. Supabase's edge can black-hole
 * individual requests (observed: a connection that never settles while the
 * same host answers other requests); without a bound one hung read freezes
 * the whole sync loop forever. Generous on purpose — large upsert batches
 * need headroom. Override with SUPABASE_SYNC_REQUEST_TIMEOUT_MS.
 */
const CLOUD_REQUEST_TIMEOUT_MS = Number(process.env.SUPABASE_SYNC_REQUEST_TIMEOUT_MS) || 30_000;

/** Fresh abort signal for one PostgREST request. */
function requestTimeoutSignal() {
  return AbortSignal.timeout(CLOUD_REQUEST_TIMEOUT_MS);
}

/**
 * Table order + the exact local columns mirrored on Supabase.
 * `pk` overrides the default primary-key column `id`.
 * `pkType: 'bigint'` marks INTEGER autoincrement primary keys (needed to type
 * tombstone-driven cloud DELETEs correctly).
 * `vector: '<col>'` marks a float32 BLOB column ↔ pgvector array conversion.
 */
const TABLE_DEFS = [
  { table: 'folders', columns: ['id', 'name', 'created_at'] },
  { table: 'user_profile', pkType: 'bigint', columns: ['id', 'structured_json', 'compact_persona', 'intro_short', 'intro_interview', 'created_at'] },
  {
    table: 'resume_nodes',
    pkType: 'bigint',
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
  { table: 'transcripts', pkType: 'bigint', columns: ['id', 'meeting_id', 'speaker', 'content', 'timestamp_ms'] },
  { table: 'ai_interactions', pkType: 'bigint', columns: ['id', 'meeting_id', 'type', 'timestamp', 'user_query', 'ai_response', 'metadata_json'] },
  {
    table: 'chunks',
    pkType: 'bigint',
    columns: ['id', 'meeting_id', 'chunk_index', 'speaker', 'start_timestamp_ms', 'end_timestamp_ms', 'cleaned_text', 'token_count', 'embedding', 'created_at'],
    vector: 'embedding',
  },
  { table: 'chunk_summaries', pkType: 'bigint', columns: ['id', 'meeting_id', 'summary_text', 'embedding', 'created_at'], vector: 'embedding' },
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

/**
 * Local/cloud foreign-key parents per table. A dirty-driven sync of a child
 * table must also reconcile its parents first (in TABLE_DEFS order), because
 * both the local SQLite (PRAGMA foreign_keys=ON) and the Supabase composite
 * FKs reject child rows whose parents do not exist yet on that side.
 */
const FK_PARENTS = {
  transcripts: ['meetings'],
  ai_interactions: ['meetings'],
  chunks: ['meetings'],
  chunk_summaries: ['meetings'],
  meetings: ['folders'],
  mode_note_sections: ['modes'],
  mode_reference_files: ['modes'],
  knowledge_sources: ['mode_reference_files', 'modes'],
  knowledge_packs: ['knowledge_sources', 'modes'],
  knowledge_cards: ['knowledge_packs', 'knowledge_sources'],
  knowledge_entities: ['knowledge_packs'],
  knowledge_relations: ['knowledge_packs'],
  knowledge_card_versions: ['knowledge_cards'],
  knowledge_index_versions: ['knowledge_sources'],
};

/** Transitive closure of FK_PARENTS for the given table names (pure). */
function expandTables(tables) {
  const wanted = new Set(tables);
  const queue = [...tables];
  while (queue.length) {
    const t = queue.shift();
    for (const p of FK_PARENTS[t] || []) {
      if (!wanted.has(p)) {
        wanted.add(p);
        queue.push(p);
      }
    }
  }
  return wanted;
}

// ---------------------------------------------------------------------------
// Timestamp helpers
// ---------------------------------------------------------------------------

/**
 * Normalize a timestamp to epoch ms. Accepts ISO-8601 ('…T…Z', offsets),
 * PostgREST timestamptz strings, and SQLite's UTC 'YYYY-MM-DD HH:MM:SS[.sss]'
 * (which JS Date would otherwise parse as LOCAL time — this treats it as UTC,
 * matching SQLite CURRENT_TIMESTAMP semantics). Unparseable → 0.
 */
function toMs(v) {
  if (v == null || v === '') return 0;
  if (typeof v === 'number') return Number.isFinite(v) ? v : 0;
  if (v instanceof Date) return v.getTime();
  const s = String(v).trim();
  const m = s.match(/^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,6}))?(Z|[+-]\d{2}:?\d{2})?$/);
  if (m) {
    const frac = (m[7] || '').padEnd(3, '0').slice(0, 3);
    const ms = Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6], +frac);
    const tz = m[8];
    if (tz && tz !== 'Z') {
      const sign = tz[0] === '-' ? -1 : 1;
      const hh = +tz.slice(1, 3);
      const mm = +tz.slice(tz.length === 6 ? 4 : 3, tz.length === 6 ? 6 : 5) || 0;
      return ms - sign * (hh * 3600 + mm * 60) * 1000;
    }
    return ms;
  }
  const t = Date.parse(s);
  return Number.isNaN(t) ? 0 : t;
}

/** Epoch ms → ISO-8601 UTC string (the canonical form the engine writes). */
function toIso(ms) {
  return new Date(ms).toISOString();
}

// ---------------------------------------------------------------------------
// Vector conversions (local BLOB ↔ pgvector)
// ---------------------------------------------------------------------------

/** float32 BLOB (Buffer) → { embedding: number[] | null, embeddingDims }. */
function blobToVector(buf) {
  if (!buf || !(buf.length > 0)) return { embedding: null, embeddingDims: null };
  const n = Math.floor(buf.length / 4);
  if (n === 0 || n * 4 !== buf.length) return { embedding: null, embeddingDims: null };
  const arr = new Float32Array(n);
  for (let i = 0; i < n; i++) arr[i] = buf.readFloatLE(i * 4);
  return { embedding: Array.from(arr), embeddingDims: n };
}

/** pgvector string '[1.2,3.4,…]' → float32 BLOB (Buffer) or null. */
function vectorStringToBlob(s) {
  if (typeof s !== 'string') return null;
  const inner = s.trim().replace(/^\[|\]$/g, '');
  if (!inner) return null;
  const parts = inner.split(',');
  const floats = new Float32Array(parts.length);
  for (let i = 0; i < parts.length; i++) {
    const v = Number(parts[i]);
    if (!Number.isFinite(v)) return null;
    floats[i] = v;
  }
  const buf = Buffer.alloc(floats.length * 4);
  for (let i = 0; i < floats.length; i++) buf.writeFloatLE(floats[i], i * 4);
  return buf;
}

// ---------------------------------------------------------------------------
// Local reads
// ---------------------------------------------------------------------------

/** Reads one local table into row objects with updatedMs (vector converted). */
function readLocalRows(db, def) {
  const { table, columns, pk } = def;
  const quoted = [...columns, 'updated_at'].map((c) => `"${c}"`).join(', ');
  const rows = db.prepare(`SELECT ${quoted} FROM "${table}"`).all();
  const out = [];
  for (const row of rows) {
    const mapped = {};
    for (const c of columns) {
      if (def.vector && c === def.vector) {
        const vec = blobToVector(row[c]);
        mapped.embedding = vec.embedding;
        mapped.embedding_dims = vec.embeddingDims;
      } else {
        mapped[c] = row[c] === undefined ? null : row[c];
      }
    }
    mapped._pk = pk || 'id';
    mapped._key = String(row[pk || 'id']);
    mapped.updatedMs = toMs(row.updated_at);
    out.push(mapped);
  }
  return out;
}

/** Reads local tombstones for one table → Map<rowIdKey, ms>. */
function readLocalTombstones(db, table) {
  const map = new Map();
  try {
    for (const r of db.prepare(
      `SELECT row_id, deleted_at FROM sync_tombstones WHERE table_name = ?`
    ).all(table)) {
      map.set(String(r.row_id), toMs(r.deleted_at));
    }
  } catch (e) {
    // Table missing (pre-v33 DB not yet migrated) — treat as no tombstones.
    if (!/no such table/i.test(String(e && e.message))) throw e;
  }
  return map;
}

// ---------------------------------------------------------------------------
// Cloud-first helpers (write-through dirty tracking + cutover wipe)
// ---------------------------------------------------------------------------

/**
 * Dirty tables with their current monotonic seq (bumped by the v34 triggers
 * on every insert/update/delete). The sync loop captures the seq before
 * syncing and clears only up to it, so writes landing mid-sync stay dirty.
 * Returns [] when the table does not exist yet (pre-v34 DB).
 */
function readDirtyTables(db) {
  try {
    return db.prepare('SELECT table_name, seq FROM sync_dirty').all();
  } catch (e) {
    if (!/no such table/i.test(String(e && e.message))) throw e;
    return [];
  }
}

/**
 * Clear a dirty flag only if it was NOT bumped again since the sync started
 * (race-free: seqs captured before the sync are compared against the current
 * value). A missing row is already clean.
 */
function clearDirtyTableUpTo(db, table, seq) {
  try {
    db.prepare('DELETE FROM sync_dirty WHERE table_name = ? AND seq <= ?').run(table, seq);
  } catch (e) {
    if (!/no such table/i.test(String(e && e.message))) throw e;
  }
}

/** Clear every dirty flag (used right after the cutover wipe + pull). */
function clearAllDirty(db) {
  try {
    db.prepare('DELETE FROM sync_dirty').run();
  } catch (e) {
    if (!/no such table/i.test(String(e && e.message))) throw e;
  }
}

/**
 * Run `fn` with all trg_* triggers temporarily dropped, then recreate them
 * from sqlite_master. Used by the cutover wipe: a plain DELETE would fire the
 * v33 tombstone triggers and turn the wipe into a mass "delete everything on
 * the cloud too" — the wipe must be invisible to change tracking.
 * `fn` may return a promise; either way the triggers are restored first.
 */
function suspendLocalTriggers(db, fn) {
  const rows = db.prepare(`SELECT name, sql FROM sqlite_master WHERE type = 'trigger' AND name LIKE 'trg_%'`).all();
  for (const r of rows) db.exec(`DROP TRIGGER IF EXISTS "${r.name}"`);
  let result;
  try {
    result = fn();
  } finally {
    for (const r of rows) db.exec(r.sql);
  }
  return result;
}

/**
 * Wipe every synced business table + all sync change tracking, with triggers
 * suspended so the wipe records no tombstones and no dirty marks. Deletion
 * order is TABLE_DEFS reversed (children before parents) so the FK cascade
 * clears local-only derived tables (mode_reference_chunks, knowledge_documents)
 * exactly like deleting their cloud parents would.
 */
function wipeSyncedTables(db) {
  suspendLocalTriggers(db, () => {
    const wipe = db.transaction(() => {
      for (const def of [...TABLE_DEFS].reverse()) {
        db.exec(`DELETE FROM "${def.table}"`);
      }
      db.exec('DELETE FROM sync_tombstones');
      db.exec('DELETE FROM sync_dirty');
    });
    wipe();
  });
}

// ---------------------------------------------------------------------------
// Cloud reads (paginated)
// ---------------------------------------------------------------------------

async function readCloudRows(client, def, userId) {
  const cols = [...def.columns, 'updated_at'].join(',');
  const rows = [];
  const page = 1000;
  for (let from = 0; ; from += page) {
    const { data, error } = await client
      .from(def.table)
      .select(cols)
      .eq('user_id', userId)
      .order(def.pk || 'id', { ascending: true })
      .range(from, from + page - 1)
      .abortSignal(requestTimeoutSignal());
    if (error) throw new Error(`cloud read ${def.table}: ${error.message}`);
    if (!data || !data.length) break;
    for (const r of data) {
      r._pk = def.pk || 'id';
      r._key = String(r[def.pk || 'id']);
      r.updatedMs = toMs(r.updated_at);
      rows.push(r);
    }
    if (data.length < page) break;
  }
  return rows;
}

async function readCloudTombstones(client, table, userId) {
  const map = new Map();
  const page = 1000;
  for (let from = 0; ; from += page) {
    const { data, error } = await client
      .from('sync_tombstones')
      .select('row_id,deleted_at')
      .eq('user_id', userId)
      .eq('table_name', table)
      .order('row_id', { ascending: true })
      .range(from, from + page - 1)
      .abortSignal(requestTimeoutSignal());
    if (error) throw new Error(`cloud tombstone read ${table}: ${error.message}`);
    if (!data || !data.length) break;
    for (const r of data) map.set(String(r.row_id), toMs(r.deleted_at));
    if (data.length < page) break;
  }
  return map;
}

// ---------------------------------------------------------------------------
// Pure conflict-resolution planner (unit-tested)
// ---------------------------------------------------------------------------

/**
 * Decide, per row key, which side must change. Pure function of the four
 * inputs — no I/O — so it can be unit-tested exhaustively.
 *
 * Local/cloud state per key is the NEWEST of { row edit, deletion marker };
 * a deletion wins only when STRICTLY newer than the row edit.
 *
 * @returns {{
 *   pushRows: Array,   // local rows to upsert to cloud (row objects)
 *   pushDeletes: Array<{key, pkValue}>,  // cloud rows to delete
 *   pullRows: Array,   // cloud rows to upsert locally (row objects)
 *   pullDeletes: Array<{key, pkValue}>,  // local rows to delete
 *   tombPush: Array<{table, rowId, deletedAtMs}>,   // tombstones → cloud
 *   tombPull: Array<{table, rowId, deletedAtMs}>,   // tombstones → local
 *   tombCloudClear: Array<string> // tombstone keys to remove from cloud (revival)
 * }}
 */
function planTableSync({ def, localRows, localTombs, cloudRows, cloudTombs }) {
  const pk = def.pk || 'id';
  const pkType = def.pkType || 'text';

  const localByKey = new Map();
  for (const r of localRows) localByKey.set(r._key, r);
  const cloudByKey = new Map();
  for (const r of cloudRows) cloudByKey.set(r._key, r);

  const actions = {
    pushRows: [],
    pushDeletes: [],
    pullRows: [],
    pullDeletes: [],
    tombPush: [],
    tombPull: [],
    tombCloudClear: [],
  };

  const keys = new Set([
    ...localByKey.keys(),
    ...cloudByKey.keys(),
    ...localTombs.keys(),
    ...cloudTombs.keys(),
  ]);

  const pkValueFor = (key) => (pkType === 'bigint' ? Number(key) : key);
  const table = def.table;

  for (const key of keys) {
    const lr = localByKey.get(key);
    const cr = cloudByKey.get(key);
    const lt = localTombs.get(key); // ms | undefined
    const ct = cloudTombs.get(key); // ms | undefined

    const localEditMs = lr ? lr.updatedMs : -Infinity;
    const cloudEditMs = cr ? cr.updatedMs : -Infinity;
    const localDelMs = typeof lt === 'number' ? lt : -Infinity;
    const cloudDelMs = typeof ct === 'number' ? ct : -Infinity;

    // A side's state is the newest of {row edit, deletion marker}. A deletion
    // wins only when STRICTLY newer than the edit; the row may still exist
    // physically (pending propagation), so "deleted" is judged on timestamps,
    // not on row absence.
    const localAlive = !!lr && localEditMs >= localDelMs;
    const localDeleted = localDelMs > localEditMs;
    const cloudAlive = !!cr && cloudEditMs >= cloudDelMs;
    const cloudDeleted = cloudDelMs > cloudEditMs;

    if (localAlive && cloudAlive) {
      if (localEditMs > cloudEditMs) actions.pushRows.push(lr);
      else if (cloudEditMs > localEditMs) actions.pullRows.push(cr);
      // tie → no-op (avoids ping-pong)
    } else if (localAlive) {
      // Cloud row absent or tombstoned.
      if (cloudDeleted && cloudDelMs > localEditMs) {
        // Cloud deletion is newer than the local edit — local loses the row.
        actions.pullDeletes.push({ key, pkValue: pkValueFor(key) });
        actions.tombPull.push({ table, rowId: key, deletedAtMs: cloudDelMs });
      } else {
        // Local edit wins (or cloud never had the row) — push it.
        actions.pushRows.push(lr);
        if (cloudDeleted) actions.tombCloudClear.push(key); // revival: drop the stale marker
      }
    } else if (cloudAlive) {
      if (localDeleted && localDelMs > cloudEditMs) {
        // Local deletion is newer than the cloud edit — cloud loses the row.
        actions.pushDeletes.push({ key, pkValue: pkValueFor(key) });
        actions.tombPush.push({ table, rowId: key, deletedAtMs: localDelMs });
      } else {
        // Cloud edit wins — pull it (and the local tombstone, if any, is
        // cleared by the local INSERT trigger on apply).
        actions.pullRows.push(cr);
      }
    } else {
      // No live row on either side — reconcile the deletion markers.
      if (localDeleted && cloudDeleted) {
        if (localDelMs > cloudDelMs) actions.tombPush.push({ table, rowId: key, deletedAtMs: localDelMs });
        else if (cloudDelMs > localDelMs) actions.tombPull.push({ table, rowId: key, deletedAtMs: cloudDelMs });
      } else if (localDeleted) {
        actions.tombPush.push({ table, rowId: key, deletedAtMs: localDelMs });
      } else if (cloudDeleted) {
        actions.tombPull.push({ table, rowId: key, deletedAtMs: cloudDelMs });
      }
    }
  }

  return actions;
}

// ---------------------------------------------------------------------------
// Executors
// ---------------------------------------------------------------------------

function timestampColumnsOf(def) {
  return def.columns.filter((c) => /_at$/.test(c));
}

/** Cloud row → local row values (vector string → BLOB, timestamps → ISO-Z). */
function cloudRowToLocalValues(cr, def) {
  const values = {};
  const tsCols = new Set(timestampColumnsOf(def));
  for (const c of def.columns) {
    const v = cr[c];
    if (def.vector && c === def.vector) {
      const blob = vectorStringToBlob(v);
      values.embedding = blob;
      values.embedding_dims = blob ? Math.floor(blob.length / 4) : (cr.embedding_dims ?? null);
    } else if (tsCols.has(c) && typeof v === 'string') {
      const ms = toMs(v);
      values[c] = ms ? toIso(ms) : v;
    } else {
      values[c] = v === undefined ? null : v;
    }
  }
  return values;
}

/** Local row → cloud row values (vectors already arrays, timestamps → ISO-Z). */
function localRowToCloudValues(lr, def) {
  const values = {};
  const tsCols = new Set(timestampColumnsOf(def));
  for (const c of def.columns) {
    const v = lr[c];
    if (tsCols.has(c) && (typeof v === 'string' || typeof v === 'number')) {
      const ms = toMs(v);
      values[c] = ms ? toIso(ms) : v;
    } else {
      values[c] = v === undefined ? null : v;
    }
  }
  return values;
}

/** Apply pulled rows + deletions + tombstones to the local SQLite. */
function applyToLocal(db, def, actions) {
  const pk = def.pk || 'id';
  const cols = [...def.columns, 'updated_at'];

  const run = db.transaction(() => {
    const insert = db.prepare(
      `INSERT OR REPLACE INTO ${def.table} (${cols.map((c) => `"${c}"`).join(', ')})
       VALUES (${cols.map(() => '?').join(', ')})`
    );
    for (const cr of actions.pullRows) {
      const values = cloudRowToLocalValues(cr, def);
      insert.run(...cols.map((c) => (c === 'updated_at' ? toIso(cr.updatedMs) : values[c])));
    }

    const del = db.prepare(`DELETE FROM ${def.table} WHERE ${pk} = ?`);
    for (const d of actions.pullDeletes) del.run(d.pkValue);

    const tomb = db.prepare(
      `INSERT OR REPLACE INTO sync_tombstones (table_name, row_id, deleted_at) VALUES (?, ?, ?)`
    );
    for (const t of actions.tombPull) tomb.run(t.table, t.rowId, toIso(t.deletedAtMs));
  });
  run();
}

async function upsertCloudBatch(client, table, rows, pk) {
  const { error } = await client.from(table).upsert(rows, { onConflict: pk }).abortSignal(requestTimeoutSignal());
  if (!error) return { upserted: rows.length, failed: [] };
  let upserted = 0;
  const failed = [];
  for (const row of rows) {
    const res = await client.from(table).upsert(row, { onConflict: pk }).abortSignal(requestTimeoutSignal());
    if (res.error) failed.push({ id: row[pk], error: res.error.message });
    else upserted++;
  }
  return { upserted, failed };
}

/** Apply pushed rows + deletions + tombstones to Supabase. */
async function applyToCloud(client, def, userId, actions, batchSize, onProgress) {
  const pk = def.pk || 'id';
  const table = def.table;
  let upserted = 0;
  const failed = [];

  for (let i = 0; i < actions.pushRows.length; i += batchSize) {
    const batch = actions.pushRows.slice(i, i + batchSize).map((lr) => ({
      ...localRowToCloudValues(lr, def),
      updated_at: toIso(lr.updatedMs),
      user_id: userId,
    }));
    onProgress && onProgress({ table, phase: 'pushing', done: i, total: actions.pushRows.length });
    const res = await upsertCloudBatch(client, table, batch, pk);
    upserted += res.upserted;
    failed.push(...res.failed);
  }

  // Batch row deletions by PK list instead of one request per row.
  for (let i = 0; i < actions.pushDeletes.length; i += batchSize) {
    const keys = actions.pushDeletes.slice(i, i + batchSize).map((d) => d.pkValue);
    const { error } = await client
      .from(table)
      .delete()
      .in(pk, keys)
      .eq('user_id', userId)
      .abortSignal(requestTimeoutSignal());
    if (error) failed.push({ id: `del:${table}:${i}`, error: `delete: ${error.message}` });
  }

  // Batch tombstone upserts — one request per batch, not per row. A single
  // device can accumulate hundreds of thousands of tombstones during a live
  // meeting (segments are rewritten and re-deleted); the old per-row loop
  // made that backlog un-pushable within any sane timeout.
  for (let i = 0; i < actions.tombPush.length; i += batchSize) {
    const batch = actions.tombPush.slice(i, i + batchSize).map((t) => ({
      user_id: userId,
      table_name: t.table,
      row_id: t.rowId,
      deleted_at: toIso(t.deletedAtMs),
    }));
    const { error } = await client
      .from('sync_tombstones')
      .upsert(batch, { onConflict: 'user_id,table_name,row_id' })
      .abortSignal(requestTimeoutSignal());
    if (error) failed.push({ id: `tomb:${table}:${i}`, error: `tombstone batch: ${error.message}` });
  }

  // Batch tombstone clears (revivals) by row_id list instead of one per key.
  for (let i = 0; i < actions.tombCloudClear.length; i += batchSize) {
    const keys = actions.tombCloudClear.slice(i, i + batchSize);
    const { error } = await client
      .from('sync_tombstones')
      .delete()
      .eq('user_id', userId)
      .eq('table_name', table)
      .in('row_id', keys)
      .abortSignal(requestTimeoutSignal());
    if (error) failed.push({ id: `tombClear:${table}:${i}`, error: `tombstone clear: ${error.message}` });
  }

  return { upserted, failed };
}

/** Delete tombstones older than the TTL on both sides. */
async function gcTombstones(db, client, userId, table, direction) {
  const cutoffMs = Date.now() - TOMBSTONE_TTL_MS;
  const cutoffIso = toIso(cutoffMs);
  try {
    db.prepare('DELETE FROM sync_tombstones WHERE table_name = ? AND deleted_at < ?').run(table, cutoffIso);
  } catch (e) {
    if (!/no such table/i.test(String(e && e.message))) throw e;
  }
  if (direction !== 'push') {
    await client
      .from('sync_tombstones')
      .delete()
      .lt('deleted_at', cutoffIso)
      .eq('user_id', userId)
      .eq('table_name', table)
      .abortSignal(requestTimeoutSignal());
  }
}

// ---------------------------------------------------------------------------
// Per-table sync
// ---------------------------------------------------------------------------

/**
 * Reconcile one table. `direction`: 'both' | 'push' | 'pull'.
 * @returns {{ table, rows, cloudRows, pushed, pulled, deletedLocal, deletedCloud, tombstonesPushed, tombstonesPulled, failed, error }}
 */
async function syncTable({ db, client, userId, def, direction = 'both', onProgress, dryRun = false, batchSize = DEFAULT_BATCH_SIZE }) {
  const result = {
    table: def.table,
    rows: 0,
    cloudRows: 0,
    pushed: 0,
    pulled: 0,
    deletedLocal: 0,
    deletedCloud: 0,
    tombstonesPushed: 0,
    tombstonesPulled: 0,
    failed: [],
    error: null,
  };
  const table = def.table;

  try {
    const localRows = readLocalRows(db, def);
    const localTombs = readLocalTombstones(db, table);
    result.rows = localRows.length;

    if (direction === 'push') {
      // Blind push: everything local wins (no cloud reads at all).
      const actions = {
        pushRows: localRows,
        pushDeletes: [],
        pullRows: [],
        pullDeletes: [],
        tombPush: [...localTombs.entries()].map(([rowId, ms]) => ({ table, rowId, deletedAtMs: ms })),
        tombPull: [],
        tombCloudClear: [],
      };
      if (!dryRun) {
        const cloud = await applyToCloud(client, def, userId, actions, batchSize, onProgress);
        result.pushed = cloud.upserted;
        result.deletedCloud = 0;
        result.tombstonesPushed = actions.tombPush.length;
        result.failed.push(...cloud.failed);
      }
      await gcTombstones(db, client, userId, table, direction);
      return result;
    }

    const cloudRows = await readCloudRows(client, def, userId);
    const cloudTombs = await readCloudTombstones(client, table, userId);
    result.cloudRows = cloudRows.length;

    if (direction === 'pull') {
      // Blind pull: everything cloud wins.
      const actions = {
        pushRows: [],
        pushDeletes: [],
        pullRows: cloudRows,
        pullDeletes: [],
        tombPush: [],
        tombPull: [...cloudTombs.entries()].map(([rowId, ms]) => ({ table, rowId, deletedAtMs: ms })),
        tombCloudClear: [],
      };
      const pk = def.pk || 'id';
      const pkType = def.pkType || 'text';
      for (const [rowId, ms] of cloudTombs.entries()) {
        if (localRows.some((r) => r._key === rowId)) {
          actions.pullDeletes.push({ key: rowId, pkValue: pkType === 'bigint' ? Number(rowId) : rowId });
        }
      }
      if (!dryRun) {
        applyToLocal(db, def, actions);
        result.pulled = actions.pullRows.length;
        result.deletedLocal = actions.pullDeletes.length;
        result.tombstonesPulled = actions.tombPull.length;
      }
      await gcTombstones(db, client, userId, table, direction);
      return result;
    }

    // 'both' — plan with the pure LWW resolver, then apply both directions.
    const actions = planTableSync({ def, localRows, localTombs, cloudRows, cloudTombs });

    if (dryRun) {
      onProgress && onProgress({ table, phase: 'dry-run', rows: localRows.length, cloudRows: cloudRows.length });
      result.pushed = actions.pushRows.length;
      result.pulled = actions.pullRows.length;
      result.deletedLocal = actions.pullDeletes.length;
      result.deletedCloud = actions.pushDeletes.length;
      result.tombstonesPushed = actions.tombPush.length;
      result.tombstonesPulled = actions.tombPull.length;
      return result;
    }

    applyToLocal(db, def, actions);
    const cloud = await applyToCloud(client, def, userId, actions, batchSize, onProgress);
    result.pushed = cloud.upserted;
    result.pulled = actions.pullRows.length;
    result.deletedLocal = actions.pullDeletes.length;
    result.deletedCloud = actions.pushDeletes.length;
    result.tombstonesPushed = actions.tombPush.length;
    result.tombstonesPulled = actions.tombPull.length;
    result.failed.push(...cloud.failed);

    await gcTombstones(db, client, userId, table, direction);
    return result;
  } catch (e) {
    result.error = e && e.message ? e.message : String(e);
    return result;
  }
}

// ---------------------------------------------------------------------------
// Full sync
// ---------------------------------------------------------------------------

/**
 * Reconcile every synced table for one user.
 *
 * @param {object} opts
 * @param {object} opts.db       open better-sqlite3 Database (must be migrated ≥ v33)
 * @param {object} opts.client   supabase-js client (service_role or user JWT)
 * @param {string} opts.userId   auth.users.id
 * @param {('both'|'push'|'pull')} [opts.direction]
 * @param {Function} [opts.onProgress]
 * @param {boolean} [opts.dryRun]
 * @param {number} [opts.batchSize]
 * @param {string[]} [opts.tables] only reconcile these tables (expanded with
 *   their FK ancestors, iterated in TABLE_DEFS order — used by the in-app
 *   write-through loop to push just the tables a local write dirtied)
 * @param {number} [opts.deadline] epoch-ms cap for the WHOLE reconciliation.
 *   When exceeded, the remaining tables are skipped (counted as table errors)
 *   so a flaky edge cannot pin the UI in "syncing" for minutes. Each table is
 *   still individually bounded by CLOUD_REQUEST_TIMEOUT_MS.
 * @returns {Promise<{tables: Array, totalRows: number, totalPushed: number, totalPulled: number, totalDeleted: number, totalFailed: number, totalTableErrors: number}>}
 */
async function syncAll({ db, client, userId, direction = 'both', onProgress, dryRun = false, batchSize = DEFAULT_BATCH_SIZE, tables = null, deadline = null }) {
  if (!userId) throw new Error('syncAll: userId is required');
  let defs = TABLE_DEFS;
  if (Array.isArray(tables) && tables.length) {
    const wanted = expandTables(tables);
    defs = TABLE_DEFS.filter((d) => wanted.has(d.table));
  }
  const resultTables = [];
  let totalRows = 0;
  let totalPushed = 0;
  let totalPulled = 0;
  let totalDeleted = 0;
  let totalFailed = 0;
  let totalTableErrors = 0;

  const skipped = (table) => ({
    table, rows: 0, cloudRows: 0, pushed: 0, pulled: 0, deletedLocal: 0, deletedCloud: 0,
    tombstonesPushed: 0, tombstonesPulled: 0, failed: [], error: 'skipped: global sync deadline exceeded',
  });

  for (let i = 0; i < defs.length; i++) {
    const def = defs[i];
    if (deadline && Date.now() > deadline) {
      // Stop reconciling: the remaining tables are marked as errors so the
      // caller reports a failed sync (and retries on the next cycle) instead
      // of leaving the loop running for minutes against a black-holed edge.
      for (let j = i; j < defs.length; j++) {
        resultTables.push(skipped(defs[j].table));
        totalTableErrors++;
        onProgress && onProgress({ table: defs[j].table, phase: 'error', error: 'skipped: global sync deadline exceeded' });
      }
      break;
    }
    const result = await syncTable({ db, client, userId, def, direction, onProgress, dryRun, batchSize });
    resultTables.push(result);
    totalRows += result.rows;
    totalPushed += result.pushed;
    totalPulled += result.pulled;
    totalDeleted += result.deletedLocal + result.deletedCloud;
    totalFailed += result.failed.length;
    if (result.error) {
      totalTableErrors++;
      onProgress && onProgress({ table: def.table, phase: 'error', error: result.error });
    }
  }
  return { tables: resultTables, totalRows, totalPushed, totalPulled, totalDeleted, totalFailed, totalTableErrors };
}

module.exports = {
  TABLE_DEFS,
  FK_PARENTS,
  expandTables,
  readDirtyTables,
  clearDirtyTableUpTo,
  clearAllDirty,
  suspendLocalTriggers,
  wipeSyncedTables,
  CLOUD_REQUEST_TIMEOUT_MS,
  DEFAULT_BATCH_SIZE,
  TOMBSTONE_TTL_MS,
  toMs,
  toIso,
  blobToVector,
  vectorStringToBlob,
  readLocalRows,
  readLocalTombstones,
  planTableSync,
  syncTable,
  syncAll,
};
