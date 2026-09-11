'use strict';
const { DatabaseSync } = require('node:sqlite');
const path = require('node:path');
const os = require('node:os');

/** Same platform resolution as measure-egress.cjs (Windows %APPDATA%, macOS Application Support). */
function defaultDbPath() {
  if (process.platform === 'win32') {
    return path.join(process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming'), 'natively', 'natively.db');
  }
  if (process.platform === 'darwin') {
    return path.join(os.homedir(), 'Library', 'Application Support', 'natively', 'natively.db');
  }
  return path.join(process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config'), 'natively', 'natively.db');
}

const db = new DatabaseSync(process.argv[2] || defaultDbPath(), { readOnly: true });
const mb = (b) => (b / 1024 / 1024).toFixed(3) + ' MB';

console.log('=== Tombstones by table (local ledger) ===');
// PostgREST returns one JSON object per tombstone: {"row_id":"…","deleted_at":"…"}
// The fixed envelope is the JSON scaffolding around those two values.
const ENVELOPE = Buffer.byteLength('{"row_id":"","deleted_at":""}', 'utf8');
const byTable = db.prepare(`
  SELECT table_name, COUNT(*) n,
         SUM(LENGTH(row_id)) idlen,
         SUM(LENGTH(deleted_at)) tlen
  FROM sync_tombstones GROUP BY table_name ORDER BY n DESC`).all();
let totalBytes = 0, totalRows = 0;
for (const r of byTable) {
  // NOTE: idlen/tlen are SUMS over the group, so they are added once — not
  // multiplied by n (which double-counts and produced nonsense output before).
  const bytes = r.n * ENVELOPE + r.idlen + r.tlen;
  totalBytes += bytes; totalRows += r.n;
  console.log('  ' + r.table_name.padEnd(28), String(r.n).padStart(7), 'rows', mb(bytes).padStart(10));
}
console.log('  ' + 'TOTAL'.padEnd(28), String(totalRows).padStart(7), 'rows', mb(totalBytes).padStart(10));
console.log('  (this is what v34 re-downloaded on EVERY pass; v35 reads only markers');
console.log('   newer than the table watermark)');

console.log('');
console.log('=== Tombstone age (are they being GCd at 30d TTL?) ===');
const oldest = db.prepare('SELECT MIN(deleted_at) a, MAX(deleted_at) b FROM sync_tombstones').get();
console.log('  oldest:', oldest.a);
console.log('  newest:', oldest.b);

console.log('');
console.log('=== Tombstone growth by day (transcripts) ===');
for (const r of db.prepare(`SELECT substr(deleted_at,1,10) d, COUNT(*) n FROM sync_tombstones
                            WHERE table_name='transcripts' GROUP BY d ORDER BY d DESC LIMIT 14`).all()) {
  console.log('  ' + r.d, String(r.n).padStart(7));
}

console.log('');
console.log('=== Current dirty state (what the 1s write-through loop sees) ===');
try {
  for (const r of db.prepare('SELECT table_name, seq FROM sync_dirty ORDER BY seq DESC').all()) {
    console.log('  ' + r.table_name.padEnd(28), 'seq=' + r.seq);
  }
} catch { console.log('  (none)'); }

console.log('');
console.log('=== Row counts of the big tables ===');
for (const t of ['transcripts', 'meetings', 'chunks', 'chunk_summaries', 'ai_interactions', 'assistant_claims', 'turn_context_contracts']) {
  try { console.log('  ' + t.padEnd(28), db.prepare(`SELECT COUNT(*) n FROM "${t}"`).get().n); } catch {}
}

// Simulate the write-through cost during a live meeting where `transcripts`
// is dirty on every 1s tick: expandTables(transcripts) = {transcripts, meetings}
console.log('');
console.log('=== Write-through cost when `transcripts` is dirty every 1s ===');
const colsT = db.prepare('SELECT id,meeting_id,speaker,content,timestamp_ms,updated_at FROM transcripts').all();
let bT = 0; for (const r of colsT) bT += Buffer.byteLength(JSON.stringify(r), 'utf8');
const colsM = db.prepare('SELECT id,title,start_time,duration_ms,summary_json,created_at,calendar_event_id,source,is_processed,summary_status,embedding_provider,embedding_dimensions,embedding_space,user_titled,is_live,folder_id,updated_at FROM meetings').all();
let bM = 0; for (const r of colsM) bM += Buffer.byteLength(JSON.stringify(r), 'utf8');
const tombT = db.prepare(`SELECT COUNT(*) n, SUM(LENGTH(row_id)+LENGTH(deleted_at)) l FROM sync_tombstones WHERE table_name='transcripts'`).get();
// readCloudTombstones selects only (row_id, deleted_at) — no table_name — and the
// WHERE clause is server-side, so only these two values cost egress.
const bTomb = tombT.n * ENVELOPE + (tombT.l || 0);
const perTick = bT + bM + bTomb;
console.log('  transcripts rows :', mb(bT));
console.log('  meetings rows    :', mb(bM));
console.log('  transcripts tombs:', mb(bTomb), '(' + tombT.n + ' rows)');
console.log('  => per 1s tick   :', mb(perTick));
console.log('  => per minute    :', mb(perTick * 60));
console.log('  => per 1h meeting:', (perTick * 3600 / 1024 / 1024 / 1024).toFixed(2), 'GB');
