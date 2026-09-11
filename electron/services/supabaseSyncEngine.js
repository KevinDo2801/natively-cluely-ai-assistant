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
 * Sync model (v35 — incremental, two-way, LWW):
 *   - Each table keeps a `sync_watermarks` row (local migration v35) recording
 *     the newest local stamp and the newest cloud stamp it has reconciled. A
 *     pass reads only the cloud rows/tombstones stamped after the cloud
 *     watermark, and it hands the LWW planner only the keys that changed on
 *     either side since the matching watermark. Everything else is provably
 *     already agreed on and is skipped without being read.
 *   - This replaced a full-table reconcile that cost O(database size) per pass.
 *     Measured on this repo's dev database: 2.35 MB of rows + 3.44 MB of
 *     tombstones every 60 seconds (≈8 GB/day) with a single user, which blew
 *     the Supabase free-plan egress quota. Egress scales with database size,
 *     never with the number of users.
 *   - Incremental reads are an OPTIMISATION, never the correctness argument: a
 *     table is still read whole on its first pass after the upgrade and once
 *     per FULL_RESCAN_INTERVAL_MS afterwards, so a watermark that skips a row
 *     (clock skew between machines) heals by itself.
 *
 * Known v2 limitations (documented, not bugs):
 *   - Pulled embeddings land in the chunks/chunk_summaries/resume_nodes BLOB
 *     columns; the local sqlite-vec per-dimension tables are refreshed by the
 *     app's own re-index paths, not by the engine.
 *   - "Clear all data" is a bulk delete — its tombstones propagate, so it now
 *     also clears the cloud copy. That is the intended two-way semantics.
 *   - LWW resolves conflicts on `updated_at`, which is stamped by whichever
 *     machine made the edit. A device whose clock runs far ahead therefore wins
 *     conflicts until its clock is corrected. This is NOT the same problem the
 *     `sync_seq` watermark solves: sync_seq makes *propagation* independent of
 *     clocks, while *who wins* is still the client's own timestamp.
 *     Do not try to fix it by clamping a future-dated write on the server: the
 *     local copy keeps its skewed stamp, so it keeps looking newer than the
 *     clamped cloud value and every pass would push again — a ping-pong loop
 *     that costs more egress than the problem it removes. The honest fixes are a
 *     clock that is right, or a hybrid logical clock; SupabaseSyncService
 *     measures the offset once per session and warns when it matters.
 */

'use strict';

const DEFAULT_BATCH_SIZE = 500;
const TOMBSTONE_TTL_MS = 30 * 24 * 60 * 60 * 1000;

/**
 * Incremental sync (v35). Every cloud read is filtered by a per-table
 * watermark so a reconcile costs O(rows changed since the last pass) instead of
 * O(table size). Measured on this repo's own dev database before the change: a
 * 60s full reconcile pulled 2.35 MB of rows + 3.44 MB of tombstones ≈ 5.8 MB
 * per minute ≈ 8 GB/day with a SINGLE user, which is what blew the Supabase
 * free-plan egress quota. Egress scales with database size, never with users.
 *
 * `FULL_RESCAN_INTERVAL_MS` bounds the worst case: the incremental path is an
 * optimisation, so once per interval each table is read WITHOUT a filter
 * exactly like v34 did. A watermark that ever skips a row (pathological clock
 * skew between machines — the same limitation the LWW resolver already has)
 * therefore heals by itself, at 1/720th of the old cost.
 */
const FULL_RESCAN_INTERVAL_MS = Number(process.env.SUPABASE_SYNC_FULL_RESCAN_MS) || 12 * 60 * 60 * 1000;

/**
 * Clock margins for advancing a watermark. The LOCAL watermark compares stamps
 * written by this machine's clock, so a small margin is enough to cover writes
 * that land while a pass is in flight. The CLOUD watermark compares stamps
 * written by the server and by other devices, so it needs skew headroom: it is
 * set to `passStart - margin`, and anything a skewed clock hides is picked up
 * by the next full rescan.
 */
const LOCAL_WATERMARK_OVERLAP_MS = Number(process.env.SUPABASE_SYNC_LOCAL_OVERLAP_MS) || 5_000;
const CLOUD_WATERMARK_OVERLAP_MS = Number(process.env.SUPABASE_SYNC_CLOUD_OVERLAP_MS) || 5 * 60 * 1000;

/** Tombstone GC cadence. Was: every table on every pass (2 requests each). */
const TOMBSTONE_GC_INTERVAL_MS = Number(process.env.SUPABASE_SYNC_GC_MS) || 60 * 60 * 1000;

/** Keys per `.in()` request when back-filling cloud state for changed keys. */
const KEY_FETCH_CHUNK = 200;

/**
 * Retry backoff for rows whose push failed (see `sync_retry`). The watermark is
 * NOT held back for them any more — a permanently unpushable row used to pin it
 * and degrade every pass back into a wide scan, i.e. straight back into the
 * egress problem this engine exists to avoid. Instead the row is re-offered as a
 * candidate on this schedule, so it is never dropped but also never costs a
 * table scan per second. 30s → 30min, capped.
 */
const RETRY_BASE_MS = Number(process.env.SUPABASE_SYNC_RETRY_BASE_MS) || 30_000;
const RETRY_MAX_MS = Number(process.env.SUPABASE_SYNC_RETRY_MAX_MS) || 30 * 60 * 1000;

/** Retry rows re-offered per table per pass, so one bad table cannot flood a pass. */
const RETRY_BATCH = Number(process.env.SUPABASE_SYNC_RETRY_BATCH) || 200;

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
 *
 * The watermarks are cleared too: after a wipe the local mirror is empty and
 * the following blind pull establishes a fresh baseline, so a stale watermark
 * must not be allowed to skip the rows that pull brings down.
 */
function wipeSyncedTables(db) {
  suspendLocalTriggers(db, () => {
    const wipe = db.transaction(() => {
      for (const def of [...TABLE_DEFS].reverse()) {
        db.exec(`DELETE FROM "${def.table}"`);
      }
      db.exec('DELETE FROM sync_tombstones');
      db.exec('DELETE FROM sync_dirty');
      for (const t of ['sync_watermarks', 'sync_retry']) {
        try {
          db.exec(`DELETE FROM ${t}`);
        } catch (e) {
          if (!/no such table/i.test(String(e && e.message))) throw e;
        }
      }
    });
    wipe();
  });
}

// ---------------------------------------------------------------------------
// Incremental sync watermarks (v35)
// ---------------------------------------------------------------------------

/** True when a table has no usable watermark yet (pre-v35 DB, or first pass). */
function isNeverSynced(ms) {
  return !(Number(ms) > 0);
}

/**
 * Read one table's watermarks. A missing table (pre-v35 DB) and a missing row
 * (never synced) both yield zeros, which makes the incremental path fall back
 * to a full read — so an upgraded install's first pass behaves exactly like
 * v34 and then goes incremental.
 */
function readWatermark(db, table) {
  const zero = { localMs: 0, cloudMs: 0, cloudSeq: 0, fullMs: 0, gcMs: 0 };
  const shape = (row) => ({
    localMs: Number(row.local_ms) || 0,
    cloudMs: Number(row.cloud_ms) || 0,
    cloudSeq: Number(row.cloud_seq) || 0,
    fullMs: Number(row.full_ms) || 0,
    gcMs: Number(row.gc_ms) || 0,
  });
  const select = (cols) => db.prepare(`SELECT ${cols} FROM sync_watermarks WHERE table_name = ?`).get(table);
  try {
    const row = select('local_ms, cloud_ms, cloud_seq, full_ms, gc_ms');
    return row ? shape(row) : zero;
  } catch (e) {
    const msg = String(e && e.message);
    if (/no such table/i.test(msg)) return zero;
    // Pre-v36 database: no `cloud_seq` column. Read the rest rather than failing
    // the whole pass — the engine simply runs without a sequence watermark.
    if (/cloud_seq/i.test(msg) && /column/i.test(msg)) {
      try {
        const row = select('local_ms, cloud_ms, full_ms, gc_ms');
        return row ? shape(row) : zero;
      } catch (e2) {
        if (/no such table/i.test(String(e2 && e2.message))) return zero;
        throw e2;
      }
    }
    throw e;
  }
}

/**
 * Upsert one table's watermarks. Best-effort: a pre-v35 DB simply stays
 * full-rescan, and a pre-v36 DB (no `cloud_seq` column) keeps the timestamp
 * watermark instead of failing the pass.
 */
function writeWatermark(db, table, values) {
  const localMs = Number(values.localMs) || 0;
  const cloudMs = Number(values.cloudMs) || 0;
  const cloudSeq = Number(values.cloudSeq) || 0;
  const fullMs = Number(values.fullMs) || 0;
  const gcMs = Number(values.gcMs) || 0;
  try {
    db.prepare(
      `INSERT INTO sync_watermarks (table_name, local_ms, cloud_ms, cloud_seq, full_ms, gc_ms)
       VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(table_name) DO UPDATE SET
         local_ms  = excluded.local_ms,
         cloud_ms  = excluded.cloud_ms,
         cloud_seq = excluded.cloud_seq,
         full_ms   = excluded.full_ms,
         gc_ms     = excluded.gc_ms`
    ).run(table, localMs, cloudMs, cloudSeq, fullMs, gcMs);
  } catch (e) {
    const msg = String(e && e.message);
    // SQLite phrases a missing column as "has no column named cloud_seq" or
    // "no such column: cloud_seq" depending on the statement — match both.
    if (/cloud_seq/i.test(msg) && /column/i.test(msg)) {
      // Pre-v36 database: keep the timestamp watermark working.
      try {
        db.prepare(
          `INSERT INTO sync_watermarks (table_name, local_ms, cloud_ms, full_ms, gc_ms)
           VALUES (?, ?, ?, ?, ?)
           ON CONFLICT(table_name) DO UPDATE SET
             local_ms = excluded.local_ms,
             cloud_ms = excluded.cloud_ms,
             full_ms  = excluded.full_ms,
             gc_ms    = excluded.gc_ms`
        ).run(table, localMs, cloudMs, fullMs, gcMs);
      } catch (e2) {
        if (!/no such table/i.test(String(e2 && e2.message))) throw e2;
      }
      return;
    }
    if (!/no such table/i.test(String(e && e.message))) throw e;
  }
}

// ---------------------------------------------------------------------------
// Skew-proof cloud watermark: the server-assigned `sync_seq` (migration 0005)
// ---------------------------------------------------------------------------

/**
 * Probe cache for whether the project has migration 0005 applied (the
 * `sync_seq` column + its trigger). `null` = not probed yet.
 *
 * Why a probe at all: this build must work whether or not the operator has run
 * the SQL yet. Without `sync_seq` the engine keeps v35's timestamp watermark
 * (correct, but a writer whose clock lags ours can delay rows until the 12h full
 * rescan); with it, the delta becomes exact and that whole failure mode is gone.
 * One tiny request decides which mode this process runs in, and a failed probe
 * degrades to the timestamp path rather than breaking sync.
 */
let cloudSeqProbe = null;

async function cloudHasSyncSeq(client) {
  if (cloudSeqProbe !== null) return cloudSeqProbe;
  try {
    const { error } = await client
      .from('sync_tombstones')
      .select('sync_seq')
      .limit(1)
      .abortSignal(requestTimeoutSignal());
    // A missing column is reported by PostgREST as an error mentioning it.
    cloudSeqProbe = !error;
    if (error && !/sync_seq/i.test(String(error.message))) {
      console.warn('[supabaseSyncEngine] sync_seq probe inconclusive, using timestamp watermarks:', error.message);
    }
    if (cloudSeqProbe) console.log('[supabaseSyncEngine] incremental sync: sequence watermarks (migration 0005 present)');
    return cloudSeqProbe;
  } catch (e) {
    // Transport failure is not a schema answer — do not cache it.
    console.warn('[supabaseSyncEngine] sync_seq probe failed, using timestamp watermarks:', e && e.message);
    return false;
  }
}

/** Test hook: forget the probe result. */
function __resetSeqProbe() {
  cloudSeqProbe = null;
}

// ---------------------------------------------------------------------------
// Durable per-row retry ledger
// ---------------------------------------------------------------------------

/** Backoff for the Nth failed attempt (30s, 60s, 2m, … capped at RETRY_MAX_MS). */
function retryDelayMs(attempts) {
  const n = Math.max(1, Number(attempts) || 1);
  return Math.min(RETRY_BASE_MS * Math.pow(2, n - 1), RETRY_MAX_MS);
}

/**
 * Row keys for this table whose last push failed and whose backoff has elapsed.
 * Ordered oldest-first so a bounded batch drains fairly.
 */
function readDueRetries(db, table, nowMs, limit = RETRY_BATCH) {
  try {
    return db.prepare(
      `SELECT row_id, attempts FROM sync_retry
        WHERE table_name = ? AND next_attempt_ms <= ?
        ORDER BY next_attempt_ms ASC LIMIT ?`
    ).all(table, nowMs, limit);
  } catch (e) {
    if (!/no such table/i.test(String(e && e.message))) throw e;
    return [];
  }
}

/** Record (or bump) retries for the failed keys of one pass. */
function recordRetries(db, table, keys, error, nowMs) {
  if (!keys || !keys.length) return;
  try {
    const read = db.prepare('SELECT attempts FROM sync_retry WHERE table_name = ? AND row_id = ?');
    const upsert = db.prepare(
      `INSERT INTO sync_retry (table_name, row_id, attempts, next_attempt_ms, last_error, updated_at)
       VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(table_name, row_id) DO UPDATE SET
         attempts        = excluded.attempts,
         next_attempt_ms = excluded.next_attempt_ms,
         last_error      = excluded.last_error,
         updated_at      = excluded.updated_at`
    );
    const nowIso = toIso(nowMs);
    const message = String(error || '').slice(0, 500);
    const tx = db.transaction(() => {
      for (const rowId of keys) {
        const id = String(rowId);
        const prev = read.get(table, id);
        const attempts = (prev ? Number(prev.attempts) : 0) + 1;
        upsert.run(table, id, attempts, nowMs + retryDelayMs(attempts), message, nowIso);
      }
    });
    tx();
  } catch (e) {
    if (!/no such table/i.test(String(e && e.message))) {
      console.warn(`[supabaseSyncEngine] could not record retries for ${table} (non-fatal):`, e && e.message);
    }
  }
}

/** Drop retries that succeeded (or whose local row is gone). */
function clearRetries(db, table, keys) {
  if (!keys || !keys.length) return;
  try {
    const del = db.prepare('DELETE FROM sync_retry WHERE table_name = ? AND row_id = ?');
    const tx = db.transaction(() => { for (const k of keys) del.run(table, String(k)); });
    tx();
  } catch (e) {
    if (!/no such table/i.test(String(e && e.message))) {
      console.warn(`[supabaseSyncEngine] could not clear retries for ${table} (non-fatal):`, e && e.message);
    }
  }
}

/** Every outstanding retry key for a table (used after a blind pull resets state). */
function readAllRetryKeys(db, table) {
  try {
    return db.prepare('SELECT row_id FROM sync_retry WHERE table_name = ?').all(table).map((r) => String(r.row_id));
  } catch (e) {
    if (!/no such table/i.test(String(e && e.message))) throw e;
    return [];
  }
}

/** Outstanding retry count for a table (surfaced in the sync summary). */
function countRetries(db, table) {
  try {
    const row = db.prepare('SELECT COUNT(*) c FROM sync_retry WHERE table_name = ?').get(table);
    return row ? Number(row.c) : 0;
  } catch (e) {
    if (!/no such table/i.test(String(e && e.message))) throw e;
    return 0;
  }
}

/**
 * Decide which row keys can possibly need an action this pass, and cut the four
 * inputs down to just those keys.
 *
 * The correctness argument, stated plainly: a full reconcile only ever acts on
 * a key when at least one side's row or tombstone differs from the other side's
 * (last-write-wins). If neither side stamped a key after that side's watermark,
 * then both sides were already compared and agreed on the previous pass and
 * neither has changed since — so the planner provably has nothing to say about
 * it, and the engine can skip it without reading it.
 *
 * A watermark of 0 means "never reconciled", which makes EVERY key a candidate:
 * that is the first pass after the upgrade, and it is also how the periodic
 * full rescan is expressed — same code path, no special case.
 *
 * Pure (no I/O) so the scoping rule is exhaustively unit-testable.
 *
 * @returns {{
 *   keys: Set<string>,
 *   localRows: Array,      // local rows, filtered to candidates
 *   localTombs: Map,       // local tombstones, filtered to candidates
 *   cloudRows: Array,      // cloud rows from the delta, filtered to candidates
 *   cloudTombs: Map,       // cloud tombstones from the delta, filtered to candidates
 *   missingCloudKeys: string[],  // candidates whose cloud ROW is not in the delta
 *   allCandidates: boolean,      // true when a watermark was 0 (full reconcile)
 * }}
 *
 * `missingCloudKeys` is the subtle half. A key that changed only LOCALLY is a
 * candidate, but its cloud row was unchanged so it is absent from the delta. The
 * planner reads "absent from cloudRows" as "the cloud never had this row" and
 * would push it — which would re-upload the whole table every pass, exactly the
 * bug this change exists to remove. The caller must therefore fetch those keys
 * explicitly. Cloud TOMBSTONES need no such back-fill: a stale marker can never
 * win against a newer row edit (a deletion must be STRICTLY newer), so not
 * loading it can only skip cosmetic tombstone cleanup, never resurrect a row.
 */
/**
 * Decide which row keys can possibly need an action this pass, and cut the four
 * inputs down to just those keys.
 *
 * The correctness argument, stated plainly: a full reconcile only ever acts on
 * a key when at least one side's row or tombstone differs from the other side's
 * (last-write-wins). If neither side stamped a key after that side's watermark,
 * then both sides were already compared and agreed on the previous pass and
 * neither has changed since — so the planner provably has nothing to say about
 * it, and the engine can skip it without reading it.
 *
 * Three inputs widen that set, each for a different reason:
 *   - a watermark of 0 means "never reconciled", making EVERY key a candidate:
 *     the first pass after the upgrade, and how the periodic full rescan is
 *     expressed (same code path, no special case);
 *   - `cloudDeltaIsExact` (sequence mode) means the cloud delta IS the set of
 *     changed cloud rows, so every entry in it is a candidate regardless of its
 *     timestamp — no comparison against a clock at all;
 *   - `extraKeys` are keys carried by the retry ledger: a row whose push failed
 *     is re-offered here instead of holding the watermark back.
 *
 * Pure (no I/O) so the scoping rule is exhaustively unit-testable.
 *
 * @returns {{
 *   keys: Set<string>,
 *   localRows: Array,      // local rows, filtered to candidates
 *   localTombs: Map,       // local tombstones, filtered to candidates
 *   cloudRows: Array,      // cloud rows from the delta, filtered to candidates
 *   cloudTombs: Map,       // cloud tombstones from the delta, filtered to candidates
 *   missingCloudKeys: string[],  // candidates whose cloud ROW is not in the delta
 *   allCandidates: boolean,      // true when a watermark was 0 (full reconcile)
 * }}
 *
 * `missingCloudKeys` is the subtle half. A key that changed only LOCALLY is a
 * candidate, but its cloud row was unchanged so it is absent from the delta. The
 * planner reads "absent from cloudRows" as "the cloud never had this row" and
 * would push it — which would re-upload the whole table every pass, exactly the
 * bug this engine exists to avoid. The caller must therefore fetch those keys
 * explicitly. Cloud TOMBSTONES need no such back-fill: a stale marker can never
 * win against a newer row edit (a deletion must be STRICTLY newer), so not
 * loading it can only skip cosmetic tombstone cleanup, never resurrect a row.
 */
function scopeIncrementalCandidates({
  localRows,
  localTombs,
  cloudRows,
  cloudTombs,
  localSinceMs,
  cloudSinceMs,
  cloudDeltaIsExact = false,
  extraKeys = null,
}) {
  const localAll = isNeverSynced(localSinceMs);
  const cloudAll = isNeverSynced(cloudSinceMs) || cloudDeltaIsExact;

  const keys = new Set();
  for (const r of localRows) {
    if (localAll || r.updatedMs > localSinceMs) keys.add(r._key);
  }
  for (const [k, ms] of localTombs) {
    if (localAll || ms > localSinceMs) keys.add(String(k));
  }
  for (const r of cloudRows) {
    if (cloudAll || r.updatedMs > cloudSinceMs) keys.add(r._key);
  }
  for (const [k, ms] of cloudTombs) {
    if (cloudAll || ms > cloudSinceMs) keys.add(String(k));
  }
  if (extraKeys) {
    for (const k of extraKeys) keys.add(String(k));
  }

  const localRowsOut = localRows.filter((r) => keys.has(r._key));
  const localTombsOut = new Map();
  for (const [k, ms] of localTombs) if (keys.has(String(k))) localTombsOut.set(k, ms);
  const cloudRowsOut = cloudRows.filter((r) => keys.has(r._key));
  const cloudTombsOut = new Map();
  for (const [k, ms] of cloudTombs) if (keys.has(String(k))) cloudTombsOut.set(k, ms);

  const haveCloudRow = new Set(cloudRowsOut.map((r) => r._key));
  const missingCloudKeys = [];
  for (const k of keys) if (!haveCloudRow.has(k)) missingCloudKeys.push(k);

  return {
    keys,
    localRows: localRowsOut,
    localTombs: localTombsOut,
    cloudRows: cloudRowsOut,
    cloudTombs: cloudTombsOut,
    missingCloudKeys,
    allCandidates: localAll && cloudAll,
  };
}

/**
 * Shape one cloud row the way the rest of the engine expects it (pk aliases +
 * parsed LWW timestamp + sequence). Shared by every cloud read so the delta, the
 * key back-fill and the blind pull cannot drift apart.
 */
function decorateCloudRow(r, def) {
  const pk = def.pk || 'id';
  r._pk = pk;
  r._key = String(r[pk]);
  r.updatedMs = toMs(r.updated_at);
  if (r.sync_seq !== undefined) r._seq = Number(r.sync_seq) || 0;
  return r;
}

// ---------------------------------------------------------------------------
// Cloud reads (paginated)
// ---------------------------------------------------------------------------

/**
 * Reads cloud rows, bounded either by the sequence delta (`syncSeq`, exact) or
 * by the timestamp delta (`sinceMs`, tolerant of nothing).
 *
 * Prefer `syncSeq`: the server assigns it from one sequence on every insert and
 * update, so `sync_seq > lastSeq` cannot miss a row no matter what any machine's
 * clock says. `sinceMs` is the v35 fallback for a project that has not had
 * migration 0005 applied — it works, but a writer whose clock lags ours stamps
 * rows below the watermark and those wait for the next full rescan.
 *
 * Both zero/absent means "read everything" (first pass, periodic floor).
 */
async function readCloudRows(client, def, userId, { sinceMs = 0, sinceSeq = 0, selectSeq = false } = {}) {
  const useSeq = Number(sinceSeq) > 0;
  // `selectSeq` without a bound is the FIRST pass (and the periodic full rescan)
  // on a project that has 0005: the read is unfiltered, but the sequence must
  // still come down or the watermark can never be established and every
  // subsequent pass would stay a full read.
  const withSeq = useSeq || selectSeq;
  const cols = [...def.columns, 'updated_at', ...(withSeq ? ['sync_seq'] : [])].join(',');
  const sinceIso = !useSeq && Number(sinceMs) > 0 ? toIso(Number(sinceMs)) : null;
  const rows = [];
  const page = 1000;
  for (let from = 0; ; from += page) {
    let query = client.from(def.table).select(cols).eq('user_id', userId);
    if (useSeq) query = query.gt('sync_seq', Number(sinceSeq));
    else if (sinceIso) query = query.gt('updated_at', sinceIso);
    const { data, error } = await query
      .order(def.pk || 'id', { ascending: true })
      .range(from, from + page - 1)
      .abortSignal(requestTimeoutSignal());
    if (error) throw new Error(`cloud read ${def.table}: ${error.message}`);
    if (!data || !data.length) break;
    for (const r of data) rows.push(decorateCloudRow(r, def));
    if (data.length < page) break;
  }
  return rows;
}

/**
 * Cloud state of specific keys, for the incremental path: a key that changed
 * only locally is not in the cloud delta, but the LWW planner still needs its
 * cloud counterpart to decide who wins. Chunked because `.in()` puts the whole
 * key list in the URL.
 *
 * `slim` fetches ONLY the key and `updated_at` — the planner reads nothing else
 * off a back-filled row, and for a table with a pgvector column that is the
 * difference between ~30 bytes and ~15 KB per key. A slim row that ends up being
 * PULLED is re-fetched in full before it is applied (see syncTable), so the
 * saving can never turn into a row of nulls.
 *
 * Errors propagate: a failed back-fill must fail the pass, not silently degrade
 * into "the cloud is empty", which would push the local table over it.
 */
async function readCloudRowsByKeys(client, def, userId, keys, { slim = false } = {}) {
  if (!keys || !keys.length) return [];
  const pk = def.pk || 'id';
  const pkType = def.pkType || 'text';
  const useSlim = slim && !!def.vector;
  const cols = useSlim ? `${pk},updated_at` : [...def.columns, 'updated_at'].join(',');
  const rows = [];
  for (let i = 0; i < keys.length; i += KEY_FETCH_CHUNK) {
    const chunk = keys
      .slice(i, i + KEY_FETCH_CHUNK)
      .map((k) => (pkType === 'bigint' ? Number(k) : k));
    const { data, error } = await client
      .from(def.table)
      .select(cols)
      .eq('user_id', userId)
      .in(pk, chunk)
      .abortSignal(requestTimeoutSignal());
    if (error) throw new Error(`cloud read by key ${def.table}: ${error.message}`);
    for (const r of data || []) {
      decorateCloudRow(r, def);
      if (useSlim) r._slim = true;
      rows.push(r);
    }
  }
  return rows;
}

/**
 * Reads cloud tombstones, bounded by the sequence delta when available, else by
 * `deleted_at > sinceMs`.
 *
 * This is the single biggest egress win of v35. The local ledger is a mirror of
 * the cloud one, and it only grows: dev database measured 61,390 tombstones
 * (58,235 of them for `transcripts`, from live-meeting STT re-segmentation),
 * 3.44 MB, all of it re-downloaded every 60 seconds because the read was
 * unfiltered. A filtered read makes that ledger size irrelevant to egress.
 */
async function readCloudTombstones(client, table, userId, { sinceMs = 0, sinceSeq = 0, selectSeq = false } = {}) {
  const map = new Map();
  const useSeq = Number(sinceSeq) > 0;
  const withSeq = useSeq || selectSeq;
  const sinceIso = !useSeq && Number(sinceMs) > 0 ? toIso(Number(sinceMs)) : null;
  const page = 1000;
  for (let from = 0; ; from += page) {
    let query = client
      .from('sync_tombstones')
      .select(withSeq ? 'row_id,deleted_at,sync_seq' : 'row_id,deleted_at')
      .eq('user_id', userId)
      .eq('table_name', table);
    if (useSeq) query = query.gt('sync_seq', Number(sinceSeq));
    else if (sinceIso) query = query.gt('deleted_at', sinceIso);
    const { data, error } = await query
      .order('row_id', { ascending: true })
      .range(from, from + page - 1)
      .abortSignal(requestTimeoutSignal());
    if (error) throw new Error(`cloud tombstone read ${table}: ${error.message}`);
    if (!data || !data.length) break;
    for (const r of data) {
      map.set(String(r.row_id), toMs(r.deleted_at));
      if (r.sync_seq !== undefined) {
        const seq = Number(r.sync_seq) || 0;
        if (seq > (map._maxSeq || 0)) map._maxSeq = seq;
      }
    }
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
  // A few table definitions already mirror updated_at explicitly. Keep the
  // INSERT column list unique while still guaranteeing every synced table
  // receives the remote LWW timestamp.
  const cols = [...new Set([...def.columns, 'updated_at'])];
  const updateCols = cols.filter((c) => c !== pk);

  const run = db.transaction(() => {
    const insert = db.prepare(
      `INSERT INTO "${def.table}" (${cols.map((c) => `"${c}"`).join(', ')})
       VALUES (${cols.map(() => '?').join(', ')})
       ON CONFLICT("${pk}") DO UPDATE SET
       ${updateCols.map((c) => `"${c}" = excluded."${c}"`).join(', ')}`
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
    if (res.error) failed.push({ id: row[pk], key: String(row[pk]), error: res.error.message });
    else upserted++;
  }
  return { upserted, failed };
}

/**
 * Apply pushed rows + deletions + tombstones to Supabase.
 *
 * Every failure entry carries `key` (the row key) where one can be determined,
 * because the caller turns those into durable retry-ledger entries. A batch
 * failure without a usable key would be untracked, so the delete and tombstone
 * batches expand their batch into per-key failures — losing the row identity
 * there would mean a deletion that failed to propagate was never retried.
 */
async function applyToCloud(client, def, userId, actions, batchSize, onProgress) {
  const pk = def.pk || 'id';
  const table = def.table;
  let upserted = 0;
  const failed = [];

  for (let i = 0; i < actions.pushRows.length; i += batchSize) {
    const slice = actions.pushRows.slice(i, i + batchSize);
    const batch = slice.map((lr) => ({
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
    const slice = actions.pushDeletes.slice(i, i + batchSize);
    const keys = slice.map((d) => d.pkValue);
    const { error } = await client
      .from(table)
      .delete()
      .in(pk, keys)
      .eq('user_id', userId)
      .abortSignal(requestTimeoutSignal());
    if (error) {
      for (const d of slice) failed.push({ id: d.key, key: String(d.key), error: `delete: ${error.message}` });
    }
  }

  // Batch tombstone upserts — one request per batch, not per row. A single
  // device can accumulate hundreds of thousands of tombstones during a live
  // meeting (segments are rewritten and re-deleted); the old per-row loop
  // made that backlog un-pushable within any sane timeout.
  for (let i = 0; i < actions.tombPush.length; i += batchSize) {
    const slice = actions.tombPush.slice(i, i + batchSize);
    const batch = slice.map((t) => ({
      user_id: userId,
      table_name: t.table,
      row_id: t.rowId,
      deleted_at: toIso(t.deletedAtMs),
    }));
    const { error } = await client
      .from('sync_tombstones')
      .upsert(batch, { onConflict: 'user_id,table_name,row_id' })
      .abortSignal(requestTimeoutSignal());
    if (error) {
      for (const t of slice) failed.push({ id: t.rowId, key: String(t.rowId), error: `tombstone: ${error.message}` });
    }
  }

  // Batch tombstone clears (revivals) by row_id list instead of one per key.
  // A failure here is cosmetic and deliberately NOT retried: a stale cloud
  // tombstone can never win against the newer row edit that revived the row
  // (a deletion must be strictly newer), so it cannot resurrect or erase data.
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

/**
 * Delete tombstones older than the TTL on both sides.
 *
 * Two deliberate changes from v34:
 *   - `localNotBeforeMs` additionally gates the LOCAL delete, so a tombstone
 *     that has not been mirrored yet (deleted_at newer than the local
 *     watermark) is never garbage-collected out from under an unsent deletion.
 *   - Failures are swallowed. GC is hygiene, and a black-holed edge used to
 *     turn a GC request into a whole-table sync error, which the service then
 *     reported as a failed reconcile.
 *
 * The caller gates the cadence (TOMBSTONE_GC_INTERVAL_MS); v34 ran this for
 * every table on every pass, i.e. 21 delete requests per minute forever.
 */
async function gcTombstones(db, client, userId, table, direction, localNotBeforeMs = 0) {
  const cutoffIso = toIso(Date.now() - TOMBSTONE_TTL_MS);
  try {
    db.prepare(
      'DELETE FROM sync_tombstones WHERE table_name = ? AND deleted_at < ? AND deleted_at <= ?'
    ).run(table, cutoffIso, toIso(Number(localNotBeforeMs) || 0));
  } catch (e) {
    if (!/no such table/i.test(String(e && e.message))) {
      console.warn(`[supabaseSyncEngine] local tombstone GC ${table} failed (non-fatal):`, e && e.message);
    }
  }
  if (direction !== 'push') {
    try {
      const { error } = await client
        .from('sync_tombstones')
        .delete()
        .lt('deleted_at', cutoffIso)
        .eq('user_id', userId)
        .eq('table_name', table)
        .abortSignal(requestTimeoutSignal());
      if (error) console.warn(`[supabaseSyncEngine] cloud tombstone GC ${table} failed (non-fatal): ${error.message}`);
    } catch (e) {
      console.warn(`[supabaseSyncEngine] cloud tombstone GC ${table} failed (non-fatal):`, e && e.message);
    }
  }
}

// ---------------------------------------------------------------------------
// Per-table sync
// ---------------------------------------------------------------------------

/**
 * Reconcile one table. `direction`: 'both' | 'push' | 'pull'.
 *
 * `both` is INCREMENTAL: it reads only the cloud rows/tombstones after this
 * table's cloud watermark (a `sync_seq` delta when the project has migration
 * 0005, else a timestamp delta), considers only the keys that changed on either
 * side since the matching watermark plus any key the retry ledger re-offers, and
 * writes only those. `fullRescan` — and a table that has never been synced, and
 * the periodic FULL_RESCAN_INTERVAL_MS floor — bypasses the watermarks and reads
 * the table whole, exactly like v34.
 *
 * @returns {{ table, rows, cloudRows, pushed, pulled, deletedLocal, deletedCloud, tombstonesPushed, tombstonesPulled, candidates, retrying, incremental, failed, error }}
 */
async function syncTable({ db, client, userId, def, direction = 'both', onProgress, dryRun = false, batchSize = DEFAULT_BATCH_SIZE, fullRescan = false }) {
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
    /** Keys this pass actually considered (0 in the steady state). */
    candidates: 0,
    /** Keys re-offered this pass because an earlier push failed. */
    retrying: 0,
    /** False when the pass read the table whole. */
    incremental: false,
    failed: [],
    error: null,
  };
  const table = def.table;
  const passStartMs = Date.now();

  try {
    // Local reads are free (same process, same disk) — the row objects are only
    // used to filter the candidate keys and to feed the planner.
    const localRows = readLocalRows(db, def);
    const localTombs = readLocalTombstones(db, table);
    result.rows = localRows.length;

    const wm = readWatermark(db, table);
    const gcDue = (passStartMs - wm.gcMs) > TOMBSTONE_GC_INTERVAL_MS;

    /**
     * Record the pass outcome and advance the watermarks.
     *
     * The watermark is advanced even when rows failed, because failure tracking
     * lives in `sync_retry` now: a row that could not be pushed is re-offered as
     * a candidate on a backoff schedule instead of pinning the watermark. Holding
     * it back used to mean one unpushable row degraded every subsequent pass into
     * a wide scan — the egress regression this engine exists to remove. The
     * ledger keeps the retry and drops the scan.
     *
     * `readCloud` guards the CLOUD half: a blind push (`direction: 'push'`) never
     * reads the cloud, so advancing the cloud watermark there would make the next
     * pull skip every cloud change made before this moment. The local half is
     * always safe to advance — those rows were just pushed.
     */
    const finishPass = ({ failed = [], attemptedKeys = [], readCloud = false, maxSeq = 0 } = {}) => {
      const failedKeys = [];
      let firstError = '';
      for (const f of failed) {
        if (f && f.key !== undefined && f.key !== null) {
          failedKeys.push(String(f.key));
          if (!firstError) firstError = String(f.error || '');
        }
      }
      const failedSet = new Set(failedKeys);
      const succeeded = attemptedKeys.map(String).filter((k) => !failedSet.has(k));
      clearRetries(db, table, succeeded);
      if (failedKeys.length) recordRetries(db, table, failedKeys, firstError, passStartMs);

      writeWatermark(db, table, {
        // LOCAL watermark: everything local that this pass examined is
        // reconciled; a write landing mid-pass keeps its own newer stamp.
        localMs: Math.max(wm.localMs, passStartMs - LOCAL_WATERMARK_OVERLAP_MS),
        cloudMs: readCloud ? Math.max(wm.cloudMs, passStartMs - CLOUD_WATERMARK_OVERLAP_MS) : wm.cloudMs,
        cloudSeq: readCloud ? Math.max(wm.cloudSeq, Number(maxSeq) || 0) : wm.cloudSeq,
        fullMs: readCloud && isFullRead ? passStartMs : wm.fullMs,
        gcMs: gcDue ? passStartMs : wm.gcMs,
      });
      result.retrying = countRetries(db, table);
    };

    let isFullRead = true; // fixed up below for the incremental paths
    let seqMode = false;

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
        result.failed.push(...cloud.failed);
        finishPass({
          failed: cloud.failed,
          attemptedKeys: [
            ...actions.pushRows.map((r) => r._key),
            ...actions.tombPush.map((t) => t.rowId),
          ],
          readCloud: false,
        });
      }
      if (gcDue) await gcTombstones(db, client, userId, table, direction, wm.localMs);
      return result;
    }

    seqMode = await cloudHasSyncSeq(client);

    // A table is read whole when the caller asks, when it has NO sequence
    // watermark yet, or when the periodic floor is due. Expressed as watermark 0
    // rather than a separate code path: scopeIncrementalCandidates already treats
    // 0 as "every key is a candidate", so a full rescan is the same logic,
    // unfiltered.
    //
    // In sequence mode `cloudSeq === 0` means "no sequence established yet", and
    // the read stays UNFILTERED until one is. That closes the last gap in the
    // skew-proofing: a reader cannot learn the current sequence from a delta that
    // is filtered by a sequence it does not have, so any bound here would be a
    // guess. The cost of the unfiltered read is bounded by the table, and for the
    // one case that would otherwise stay permanently unfiltered — an EMPTY table —
    // it is a single request returning an empty array, i.e. the same cost as the
    // delta it replaces. (An empty table never observes a sequence, so keying
    // this on `cloudMs` instead would leave such a table in timestamp mode for
    // ever, and a row arriving from a device with a lagging clock would be missed
    // until the 12h floor. Measured: that case is worth removing.)
    isFullRead = fullRescan
      || (seqMode ? isNeverSynced(wm.cloudSeq) : isNeverSynced(wm.cloudMs))
      || (passStartMs - wm.fullMs) > FULL_RESCAN_INTERVAL_MS;
    result.incremental = !isFullRead;
    // Sequence watermarks are exact, so they take over whenever they exist; the
    // timestamp watermark is the fallback for a project without migration 0005.
    const seqReady = seqMode && !isFullRead; // implies wm.cloudSeq > 0
    const sinceSeq = seqReady ? wm.cloudSeq : 0;
    const cloudSinceMs = isFullRead ? 0 : wm.cloudMs;
    const localSinceMs = isFullRead ? 0 : wm.localMs;

    const [cloudDelta, cloudTombDelta] = await Promise.all([
      // `selectSeq` keeps the sequence coming down even on an unfiltered read, so
      // the watermark can be established from the very first pass.
      readCloudRows(client, def, userId, { sinceMs: cloudSinceMs, sinceSeq, selectSeq: seqMode }),
      readCloudTombstones(client, table, userId, { sinceMs: cloudSinceMs, sinceSeq, selectSeq: seqMode }),
    ]);

    // Highest sequence observed anywhere in this pass — the new exact watermark.
    let maxSeq = sinceSeq;
    for (const r of cloudDelta) if (r._seq && r._seq > maxSeq) maxSeq = r._seq;
    const tombMaxSeq = cloudTombDelta._maxSeq || 0;
    if (tombMaxSeq > maxSeq) maxSeq = tombMaxSeq;

    if (direction === 'pull') {
      // Blind pull: everything cloud wins (the cloud-first cutover rebuild).
      const actions = {
        pushRows: [],
        pushDeletes: [],
        pullRows: cloudDelta,
        pullDeletes: [],
        tombPush: [],
        tombPull: [...cloudTombDelta.entries()].map(([rowId, ms]) => ({ table, rowId, deletedAtMs: ms })),
        tombCloudClear: [],
      };
      const pkType = def.pkType || 'text';
      for (const [rowId] of cloudTombDelta.entries()) {
        if (localRows.some((r) => r._key === rowId)) {
          actions.pullDeletes.push({ key: rowId, pkValue: pkType === 'bigint' ? Number(rowId) : rowId });
        }
      }
      if (!dryRun) {
        applyToLocal(db, def, actions);
        result.pulled = actions.pullRows.length;
        result.deletedLocal = actions.pullDeletes.length;
        result.tombstonesPulled = actions.tombPull.length;
        // After a blind pull the local cache IS the cloud, so both watermarks
        // can move past this pass and the next one starts incremental.
        clearRetries(db, table, readAllRetryKeys(db, table));
        writeWatermark(db, table, {
          localMs: passStartMs - LOCAL_WATERMARK_OVERLAP_MS,
          cloudMs: passStartMs - CLOUD_WATERMARK_OVERLAP_MS,
          cloudSeq: maxSeq,
          fullMs: passStartMs,
          gcMs: gcDue ? passStartMs : wm.gcMs,
        });
      }
      if (gcDue) await gcTombstones(db, client, userId, table, direction, wm.localMs);
      return result;
    }

    // 'both' — incremental scope, then the same pure LWW resolver as before.
    const dueRetries = isFullRead ? [] : readDueRetries(db, table, passStartMs);
    const retryKeys = dueRetries.map((r) => String(r.row_id));
    // A retry entry whose row is gone locally AND has no local tombstone has
    // nothing left to push — drop it rather than re-offering it forever.
    const retryKeysLive = retryKeys.filter(
      (k) => localRows.some((r) => r._key === k) || localTombs.has(k)
    );
    const retryKeysStale = retryKeys.filter((k) => !retryKeysLive.includes(k));
    if (retryKeysStale.length) clearRetries(db, table, retryKeysStale);
    result.retrying = retryKeysLive.length;

    const scope = scopeIncrementalCandidates({
      localRows,
      localTombs,
      cloudRows: cloudDelta,
      cloudTombs: cloudTombDelta,
      localSinceMs,
      // In sequence mode the delta is exact, so nothing is compared to a clock.
      cloudSinceMs,
      cloudDeltaIsExact: seqMode && !isFullRead,
      extraKeys: retryKeysLive,
    });
    result.candidates = scope.keys.size;

    // Back-fill the cloud state of keys that changed only locally. No-op (and
    // no request) when the candidate set is empty. Slim for tables with a
    // pgvector column: the planner only reads `updatedMs` off these rows, and a
    // full row would drag ~15 KB of vector down per changed key.
    const missingRows = await readCloudRowsByKeys(client, def, userId, scope.missingCloudKeys, {
      slim: !isFullRead,
    });
    const cloudRows = scope.cloudRows.concat(missingRows);
    result.cloudRows = cloudRows.length;

    const actions = planTableSync({
      def,
      localRows: scope.localRows,
      localTombs: scope.localTombs,
      cloudRows,
      cloudTombs: scope.cloudTombs,
    });

    // A slim row can only be used to DECIDE (it carries the key and the LWW
    // stamp the decision needs). If the decision is "pull it", the full row must
    // be fetched first — applying a slim row would write a row of nulls over the
    // local copy. The decision itself cannot change: it is a function of the
    // timestamps, which are identical in both reads.
    if (actions.pullRows.some((r) => r._slim)) {
      const slimKeys = actions.pullRows.filter((r) => r._slim).map((r) => r._key);
      const fullRows = await readCloudRowsByKeys(client, def, userId, slimKeys);
      const byKey = new Map(fullRows.map((r) => [r._key, r]));
      actions.pullRows = actions.pullRows
        .map((r) => (r._slim ? byKey.get(r._key) : r))
        // A slim row whose full row vanished between the two reads (deleted
        // concurrently) is dropped rather than applied as nulls; its tombstone
        // arrives in the next delta.
        .filter(Boolean);
    }

    if (dryRun) {
      onProgress && onProgress({ table, phase: 'dry-run', rows: result.rows, cloudRows: cloudRows.length });
      result.pushed = actions.pushRows.length;
      result.pulled = actions.pullRows.length;
      result.deletedLocal = actions.pullDeletes.length;
      result.deletedCloud = actions.pushDeletes.length;
      result.tombstonesPushed = actions.tombPush.length;
      result.tombstonesPulled = actions.tombPull.length;
      return result;
    }

    // Steady state: nothing changed on either side since the last pass and no
    // retries are due. Two small delta reads, no writes, no planner output —
    // this is the path that used to cost 2.35 MB of rows plus 3.44 MB of
    // tombstones per minute.
    if (!scope.keys.size) {
      finishPass({ readCloud: true, maxSeq });
      if (gcDue) await gcTombstones(db, client, userId, table, direction, wm.localMs);
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

    const attemptedKeys = [
      ...actions.pushRows.map((r) => r._key),
      ...actions.pushDeletes.map((d) => d.key),
      ...actions.tombPush.map((t) => t.rowId),
      ...retryKeysLive,
    ];
    finishPass({ failed: cloud.failed, attemptedKeys, readCloud: true, maxSeq });
    if (gcDue) await gcTombstones(db, client, userId, table, direction, wm.localMs);
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
 * @param {boolean} [opts.fullRescan] ignore every watermark and read each table
 *   whole, exactly like v34. Not needed for correctness — the engine does this
 *   on its own once per FULL_RESCAN_INTERVAL_MS — but the CLI script uses it to
 *   force a complete reconcile on demand.
 * @returns {Promise<{tables: Array, totalRows: number, totalPushed: number, totalPulled: number, totalDeleted: number, totalFailed: number, totalTableErrors: number, totalCandidates: number, incremental: boolean}>}
 */
async function syncAll({ db, client, userId, direction = 'both', onProgress, dryRun = false, batchSize = DEFAULT_BATCH_SIZE, tables = null, deadline = null, fullRescan = false }) {
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
  let totalCandidates = 0;
  let totalRetrying = 0;

  const skipped = (table) => ({
    table, rows: 0, cloudRows: 0, pushed: 0, pulled: 0, deletedLocal: 0, deletedCloud: 0,
    tombstonesPushed: 0, tombstonesPulled: 0, candidates: 0, retrying: 0, incremental: false, failed: [],
    error: 'skipped: global sync deadline exceeded',
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
    const result = await syncTable({ db, client, userId, def, direction, onProgress, dryRun, batchSize, fullRescan });
    resultTables.push(result);
    totalRows += result.rows;
    totalPushed += result.pushed;
    totalPulled += result.pulled;
    totalDeleted += result.deletedLocal + result.deletedCloud;
    totalFailed += result.failed.length;
    totalCandidates += result.candidates || 0;
    totalRetrying += result.retrying || 0;
    if (result.error) {
      totalTableErrors++;
      onProgress && onProgress({ table: def.table, phase: 'error', error: result.error });
    }
  }
  return {
    tables: resultTables,
    totalRows,
    totalPushed,
    totalPulled,
    totalDeleted,
    totalFailed,
    totalTableErrors,
    totalCandidates,
    totalRetrying,
    incremental: resultTables.every((t) => t.incremental),
  };
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
  FULL_RESCAN_INTERVAL_MS,
  TOMBSTONE_GC_INTERVAL_MS,
  LOCAL_WATERMARK_OVERLAP_MS,
  CLOUD_WATERMARK_OVERLAP_MS,
  RETRY_BASE_MS,
  RETRY_MAX_MS,
  toMs,
  toIso,
  blobToVector,
  vectorStringToBlob,
  readLocalRows,
  readLocalTombstones,
  isNeverSynced,
  readWatermark,
  writeWatermark,
  cloudHasSyncSeq,
  __resetSeqProbe,
  scopeIncrementalCandidates,
  retryDelayMs,
  readDueRetries,
  readAllRetryKeys,
  recordRetries,
  clearRetries,
  countRetries,
  readCloudRows,
  readCloudRowsByKeys,
  readCloudTombstones,
  planTableSync,
  applyToLocal,
  syncTable,
  syncAll,
};
