/**
 * measure-egress.cjs — measures the exact byte size of the JSON payload the
 * sync engine downloads from Supabase per full reconcile, per table.
 *
 * Mirrors readCloudRows() in electron/services/supabaseSyncEngine.js:
 *   select(columns + updated_at).eq(user_id).range(...)
 * PostgREST returns each row as a JSON object, so the response body size is
 * approximated by JSON.stringify of the selected columns. pgvector columns are
 * stored locally as float32 BLOBs but travel as '[f,f,...]' text — converted
 * here so the measurement reflects the wire format, not the local format.
 *
 * Read-only: opens the DB with SQLITE_OPEN_READONLY.
 *
 * Usage: node scripts/supabase/measure-egress.cjs [path-to-natively.db]
 */

'use strict';

const { DatabaseSync } = require('node:sqlite');
const path = require('node:path');
const os = require('node:os');

const TABLE_DEFS = [
  { table: 'folders', columns: ['id', 'name', 'created_at'] },
  { table: 'user_profile', pk: 'id', columns: ['id', 'structured_json', 'compact_persona', 'intro_short', 'intro_interview', 'created_at'] },
  { table: 'resume_nodes', columns: ['id', 'category', 'title', 'organization', 'start_date', 'end_date', 'duration_months', 'text_content', 'tags', 'embedding'], vector: 'embedding' },
  { table: 'modes', columns: ['id', 'name', 'template_type', 'custom_context', 'is_active', 'created_at', 'source_contract_json', 'is_builtin'] },
  { table: 'mode_note_sections', columns: ['id', 'mode_id', 'title', 'description', 'sort_order', 'compiled_prompt', 'created_at'] },
  { table: 'mode_reference_files', columns: ['id', 'mode_id', 'file_name', 'content', 'created_at', 'page_count', 'extracted_page_count'] },
  { table: 'meetings', columns: ['id', 'title', 'start_time', 'duration_ms', 'summary_json', 'created_at', 'calendar_event_id', 'source', 'is_processed', 'summary_status', 'embedding_provider', 'embedding_dimensions', 'embedding_space', 'user_titled', 'is_live', 'folder_id'] },
  { table: 'transcripts', columns: ['id', 'meeting_id', 'speaker', 'content', 'timestamp_ms'] },
  { table: 'ai_interactions', columns: ['id', 'meeting_id', 'type', 'timestamp', 'user_query', 'ai_response', 'metadata_json'] },
  { table: 'chunks', columns: ['id', 'meeting_id', 'chunk_index', 'speaker', 'start_timestamp_ms', 'end_timestamp_ms', 'cleaned_text', 'token_count', 'embedding', 'created_at'], vector: 'embedding' },
  { table: 'chunk_summaries', columns: ['id', 'meeting_id', 'summary_text', 'embedding', 'created_at'], vector: 'embedding' },
  { table: 'knowledge_sources', columns: ['id', 'type', 'file_id', 'mode_id', 'file_name', 'source_checksum', 'content_hash', 'created_at', 'indexed_at', 'page_count', 'extracted_page_count', 'index_version', 'embedding_space'] },
  { table: 'knowledge_packs', columns: ['id', 'source_id', 'mode_id', 'file_name', 'index_md', 'stats_json', 'pack_version', 'generated_by', 'updated_at'] },
  { table: 'knowledge_cards', columns: ['id', 'pack_id', 'source_id', 'type', 'title', 'slug', 'concept_id', 'body', 'body_markdown', 'source_pages_json', 'source_sections_json', 'source_quotes_json', 'entities_json', 'tags_json', 'related_card_ids_json', 'confidence', 'generated_from', 'source_checksum', 'user_edited', 'approval_status', 'pii', 'updated_at', 'card_version'] },
  { table: 'knowledge_card_versions', columns: ['id', 'card_id', 'card_version', 'title', 'body', 'entities_json', 'tags_json', 'confidence', 'edited_by', 'edit_reason', 'created_at'] },
  { table: 'knowledge_entities', columns: ['id', 'pack_id', 'slug', 'name', 'type', 'aliases_json', 'description', 'source_card_ids_json', 'source_pages_json', 'first_seen_at'] },
  { table: 'knowledge_relations', columns: ['id', 'pack_id', 'subject_id', 'subject_type', 'predicate', 'object_id', 'object_type', 'source_card_ids_json', 'source_pages_json', 'confidence', 'created_at'] },
  { table: 'knowledge_index_versions', columns: ['id', 'source_id', 'pack_id', 'pack_version', 'content_hash', 'embedding_space', 'status', 'error_message', 'created_at', 'updated_at'] },
  { table: 'assistant_claims', pk: 'claim_id', columns: ['claim_id', 'turn_id', 'claim_text', 'source_owner', 'requested_property', 'validation_status', 'evidence_ids_json', 'created_at', 'contradicted_by_claim_id'] },
  { table: 'turn_context_contracts', pk: 'turn_id', columns: ['turn_id', 'surface', 'active_mode_id', 'answer_shape', 'source_owner', 'requested_property', 'allowed_sources_json', 'forbidden_sources_json', 'memory_write_policy_json', 'created_at'] },
];

/**
 * Default local database path, per platform (Natively ships on macOS + Windows;
 * the two use different Electron userData roots). Mirrors the resolver in
 * sync-local-to-supabase.cjs.
 */
function defaultDbPath() {
  if (process.platform === 'win32') {
    return path.join(process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming'), 'natively', 'natively.db');
  }
  if (process.platform === 'darwin') {
    return path.join(os.homedir(), 'Library', 'Application Support', 'natively', 'natively.db');
  }
  // Anything else is not a supported platform for the app, but the script is a
  // diagnostic: resolve the XDG location rather than refusing to run.
  return path.join(process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config'), 'natively', 'natively.db');
}

const dbPath = process.argv[2] || defaultDbPath();

const db = new DatabaseSync(dbPath, { readOnly: true });

/** float32 BLOB → pgvector wire text '[a,b,c]'. */
function blobToVectorText(buf) {
  if (!buf || !buf.length) return null;
  const n = Math.floor(buf.length / 4);
  if (!n || n * 4 !== buf.length) return null;
  const f = new Float32Array(n);
  for (let i = 0; i < n; i++) f[i] = buf.readFloatLE(i * 4);
  return '[' + Array.from(f).join(',') + ']';
}

const results = [];
let grandTotal = 0;
let grandRows = 0;

for (const def of TABLE_DEFS) {
  let rows;
  try {
    const cols = [...def.columns, 'updated_at'].map((c) => `"${c}"`).join(', ');
    rows = db.prepare(`SELECT ${cols} FROM "${def.table}"`).all();
  } catch (e) {
    results.push({ table: def.table, rows: 0, bytes: 0, note: 'unreadable: ' + e.message });
    continue;
  }

  let bytes = 0;
  const colBytes = {};
  const embBytes = { emb: 0 };
  for (const row of rows) {
    const obj = {};
    for (const c of def.columns) {
      let v = row[c];
      if (v instanceof Uint8Array) {
        v = def.vector === c ? blobToVectorText(v) : null;
      }
      obj[c] = v === undefined ? null : v;
      const b = v == null ? 4 : Buffer.byteLength(JSON.stringify(v), 'utf8');
      colBytes[c] = (colBytes[c] || 0) + b;
      if (def.vector === c) embBytes.emb += b;
    }
    obj.updated_at = row.updated_at ?? null;
    bytes += Buffer.byteLength(JSON.stringify(obj), 'utf8');
  }

  grandTotal += bytes;
  grandRows += rows.length;
  results.push({ table: def.table, rows: rows.length, bytes, colBytes, embBytes: embBytes.emb });
}

function mb(b) { return (b / 1024 / 1024).toFixed(2) + ' MB'; }

console.log('DB:', dbPath);
console.log('');
console.log('=== Payload of ONE full cloud read (readCloudRows per table) ===');
console.log('table'.padEnd(30), 'rows'.padStart(8), 'payload'.padStart(12), '  embedding share');
for (const r of results.sort((a, b) => b.bytes - a.bytes)) {
  const emb = r.embBytes ? mb(r.embBytes) : '-';
  console.log(String(r.table).padEnd(30), String(r.rows).padStart(8), mb(r.bytes).padStart(12), ' ', emb, r.note ? ' (' + r.note + ')' : '');
}
console.log(''.padEnd(30, '-'));
console.log('TOTAL'.padEnd(30), String(grandRows).padStart(8), mb(grandTotal).padStart(12));

// Tombstones travel too — readCloudTombstones selects ONLY (row_id, deleted_at),
// so those are the only columns that cost egress (not table_name).
let tombBytes = 0;
let tombRows = 0;
try {
  const t = db.prepare('SELECT row_id, deleted_at FROM sync_tombstones').all();
  tombRows = t.length;
  for (const r of t) tombBytes += Buffer.byteLength(JSON.stringify(r), 'utf8');
} catch { /* none */ }

console.log('');
console.log('=== Tombstones ===');
console.log('rows:', tombRows, ' payload:', mb(tombBytes), ' (read once per table per reconcile)');

// Top columns by size, to show which columns dominate.
console.log('');
console.log('=== Largest columns (all tables combined) ===');
const allCols = {};
for (const r of results) {
  if (!r.colBytes) continue;
  for (const [c, b] of Object.entries(r.colBytes)) allCols[c] = (allCols[c] || 0) + b;
}
for (const [c, b] of Object.entries(allCols).sort((a, b) => b[1] - a[1]).slice(0, 12)) {
  console.log('  ' + c.padEnd(28), mb(b));
}

console.log('');
console.log('=== Projected egress from the CURRENT loops ===');
const perFull = grandTotal;
console.log(`one full ${TABLE_DEFS.length}-table reconcile (syncNow, every 60s):`, mb(perFull));
console.log('  -> per hour  (60x):', mb(perFull * 60));
console.log('  -> per day   (1440x):', mb(perFull * 1440), ' = ', (perFull * 1440 / 1024 / 1024 / 1024).toFixed(2), 'GB');
console.log('  -> per 30d         :', (perFull * 1440 * 30 / 1024 / 1024 / 1024).toFixed(1), 'GB');

// ---------------------------------------------------------------------------
// v35 incremental projection (see electron/services/supabaseSyncEngine.js).
//
// Before v35 a pass downloaded every row of every table (perFull) plus the
// whole tombstone ledger (tombBytes) — the two numbers above. After v35 a pass
// reads only what changed after each table's watermark, so in a steady state
// every delta response is an empty array.
//
// The payload reduction is MEASURED (see the incremental sync tests, which
// assert a steady-state pass downloads zero rows). What remains is HTTP
// envelope overhead, which cannot be measured without hitting the live project:
// ~0.4 KB of response headers per request is used as a conservative estimate and
// is labelled as an estimate below.
// ---------------------------------------------------------------------------
const ENVELOPE_BYTES_PER_RESPONSE = 400; // ESTIMATE, not measured
const TABLES = TABLE_DEFS.length;
const REQUESTS_PER_PASS = TABLES * 2;   // rows delta + tombstone delta per table
const FULL_RESCAN_PER_DAY = 2;          // FULL_RESCAN_INTERVAL_MS = 12h

console.log('');
console.log('=== v35 incremental projection ===');
console.log('steady-state payload per pass (MEASURED, v35):', mb(0), '(every delta response is empty)');
console.log('  requests per pass          :', REQUESTS_PER_PASS, `(${TABLES} tables x rows+tombstones)`);
console.log('  envelope per pass (EST.)   :', mb(REQUESTS_PER_PASS * ENVELOPE_BYTES_PER_RESPONSE));
console.log('  envelope per day (EST.)    :', mb(REQUESTS_PER_PASS * ENVELOPE_BYTES_PER_RESPONSE * 1440));
console.log('periodic full rescan         :', mb((perFull + tombBytes) * FULL_RESCAN_PER_DAY), '/day',
  `(${FULL_RESCAN_PER_DAY}x the full pass above)`);
const newPerDay = (perFull + tombBytes) * FULL_RESCAN_PER_DAY + REQUESTS_PER_PASS * ENVELOPE_BYTES_PER_RESPONSE * 1440;
console.log('  -> v35 ceiling (app open 24/7):', mb(newPerDay), ' = ', (newPerDay / 1024 / 1024 / 1024).toFixed(2), 'GB/day');
console.log('  -> v35 same duty cycle as the observed ~700 MB/day (i.e. ~95 min open):',
  mb((perFull + tombBytes) * FULL_RESCAN_PER_DAY + REQUESTS_PER_PASS * ENVELOPE_BYTES_PER_RESPONSE * 95));

const oldPerDay = perFull * 1440 + tombBytes * 1440;
console.log('');
console.log('old v34 daily ceiling :', (oldPerDay / 1024 / 1024 / 1024).toFixed(2), 'GB/day');
console.log('new v35 daily ceiling :', (newPerDay / 1024 / 1024 / 1024).toFixed(2), 'GB/day');
console.log('reduction             :', (oldPerDay / newPerDay).toFixed(0) + 'x');
