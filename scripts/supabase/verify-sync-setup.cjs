/**
 * verify-sync-setup.cjs — one command that answers "is the egress fix actually
 * in place and actually working?", for both halves of the system.
 *
 *   CLOUD  — did migrations 0004 (delta indexes), 0005 (sync_seq) and 0006
 *            (server-side deletion tombstones) apply, and is the sequence really
 *            wired up?
 *   LOCAL  — did the desktop database migrate to v36, are the watermarks
 *            populated, is the sequence watermark live, and is anything stuck in
 *            the retry ledger?
 *   PROXY  — the REST request count for the billing period. Egress itself is NOT
 *            exposed by the Management API (verified: /usage, /usage.api-egress
 *            and /usage.egress all 404), so this is the API-measurable signal
 *            that moves with it: v34 needed ~60 paged requests to re-read the
 *            transcripts tombstone ledger alone, every pass, and the new engine
 *            needs one. Read the authoritative GB figure in the dashboard:
 *            Organization → Usage → Egress.
 *
 * Read-only on both sides. Usage:
 *   node scripts/supabase/verify-sync-setup.cjs [path-to-natively.db]
 */

'use strict';

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

// ── env (git-ignored) ───────────────────────────────────────────────────────
const envPath = path.join(__dirname, '..', '..', '.env');
if (fs.existsSync(envPath)) {
  for (const line of fs.readFileSync(envPath, 'utf8').split(/\r?\n/)) {
    const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
    if (m && m[1].startsWith('SUPABASE_')) process.env[m[1]] = m[2].trim();
  }
}
const token = process.env.SUPABASE_MCP_TOKEN;
const ref = process.env.SUPABASE_PROJECT_REF
  || (process.env.SUPABASE_URL || '').match(/^https:\/\/([^.]+)\.supabase\.co/)?.[1];

/** Same platform resolution as the other diagnostics. */
function defaultDbPath() {
  if (process.platform === 'win32') {
    return path.join(process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming'), 'natively', 'natively.db');
  }
  if (process.platform === 'darwin') {
    return path.join(os.homedir(), 'Library', 'Application Support', 'natively', 'natively.db');
  }
  return path.join(process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config'), 'natively', 'natively.db');
}

const EXPECTED_TABLES = 20; // synced business tables (sync_tombstones is extra)
let failures = 0;
const fail = (msg) => { failures++; console.log(`  FAIL  ${msg}`); };
const pass = (msg) => console.log(`  ok    ${msg}`);

async function managementApi(pathname) {
  const res = await fetch(`https://api.supabase.com/v1/projects/${ref}/${pathname}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`${pathname} -> ${res.status}: ${text.slice(0, 300)}`);
  return JSON.parse(text);
}

async function sql(query) {
  const res = await fetch(`https://api.supabase.com/v1/projects/${ref}/database/query`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ query }),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`SQL failed (${res.status}): ${text.slice(0, 500)}`);
  return JSON.parse(text);
}

// ── cloud ───────────────────────────────────────────────────────────────────
async function checkCloud() {
  console.log('\n=== CLOUD (project ' + ref + ') ===');
  if (!token || !ref) {
    fail('SUPABASE_MCP_TOKEN / project ref missing in .env — cannot verify the cloud half');
    return;
  }

  const [cols] = await sql(`
    select count(*)::int as n from information_schema.columns
     where table_schema='public' and column_name='sync_seq'`);
  const [trigs] = await sql(`
    select count(*)::int as n from pg_trigger g
      join pg_class c on c.oid=g.tgrelid join pg_namespace n on n.oid=c.relnamespace
     where n.nspname='public' and not g.tgisinternal and g.tgname like 'trg\\_%\\_sync_seq'`);
  const [delTrigs] = await sql(`
    select count(*)::int as n from pg_trigger g
      join pg_class c on c.oid=g.tgrelid join pg_namespace n on n.oid=c.relnamespace
     where n.nspname='public' and not g.tgisinternal and g.tgname like 'trg\\_%\\_del_tombstone'`);
  const [idx] = await sql(`
    select
      count(*) filter (where indexname like '%\\_user\\_updated\\_at')::int as updated_at_idx,
      count(*) filter (where indexname like '%\\_user\\_seq')::int          as seq_idx,
      count(*) filter (where indexname like '%\\_user\\_table\\_seq')::int  as tomb_seq_idx
      from pg_indexes where schemaname='public'`);
  const [secdef] = await sql(`
    select p.prosecdef from pg_proc p join pg_namespace n on n.oid=p.pronamespace
     where n.nspname='public' and p.proname='sync_touch_seq'`);

  console.log(`  0005 sync_seq: ${cols.n} column(s), ${trigs.n} trigger(s)`);
  if (cols.n >= EXPECTED_TABLES + 1 && trigs.n === cols.n) {
    pass(`0005 applied — every sync_seq column is maintained by its own trigger`);
  } else if (cols.n === 0) {
    fail('0005 NOT applied — the engine falls back to timestamp watermarks (correct, but a lagging clock can delay rows up to the 12h rescan)');
  } else {
    fail(`0005 PARTIALLY applied — ${cols.n} column(s) vs ${trigs.n} trigger(s); the app would read a sequence that never advances`);
  }

  if (secdef === undefined) {
    fail('0005: public.sync_touch_seq() is missing');
  } else if (!secdef.prosecdef) {
    fail('0005: sync_touch_seq() is not SECURITY DEFINER — a missing sequence grant would break every write');
  } else {
    pass('0005: sync_touch_seq() is SECURITY DEFINER (no dependency on caller grants)');
  }

  console.log(`  0006 delete tombstones: ${delTrigs.n} trigger(s)`);
  if (delTrigs.n >= EXPECTED_TABLES) {
    pass('0006 applied — rows deleted on the server (dashboard/SQL/cascade) now propagate instead of being pushed back');
  } else if (delTrigs.n === 0) {
    fail('0006 NOT applied — a row deleted in the dashboard will be resurrected by the next sync');
  } else {
    fail(`0006 PARTIALLY applied — ${delTrigs.n}/${EXPECTED_TABLES} triggers`);
  }

  console.log(`  0004 delta indexes: updated_at=${idx.updated_at_idx}, seq=${idx.seq_idx}, tombstone_seq=${idx.tomb_seq_idx}`);
  if (idx.seq_idx >= EXPECTED_TABLES && idx.tomb_seq_idx >= 1) {
    pass('0004/0005 indexes present — deltas are index range scans, not sequential scans');
  } else {
    fail('delta indexes missing — the filtered reads would be sequential scans');
  }

  if (cols.n > 0) {
    const [seq] = await sql('select last_value::bigint as v from public.sync_seq');
    console.log(`  sync_seq current value: ${seq.v}`);
    if (Number(seq.v) > 0) pass('the sequence has advanced — writes are being stamped');
    else fail('the sequence is still 0 — nothing has been written since 0005 applied');
  }
}

// ── request-count proxy ─────────────────────────────────────────────────────
async function checkProxy() {
  console.log('\n=== EGRESS PROXY (REST request count, billing period) ===');
  try {
    const usage = await managementApi('analytics/endpoints/usage.api-requests-count');
    const count = usage?.result?.[0]?.count;
    console.log(`  total REST requests this period: ${count}`);
    console.log('  (v34 paged the transcripts tombstone ledger alone into ~59 requests per pass;');
    console.log('   the new engine needs 1. This number should stop climbing so fast.)');
  } catch (e) {
    fail(`could not read request counts: ${e.message}`);
  }
  console.log('  Authoritative egress GB is NOT exposed by the API — read it at:');
  console.log('    Supabase dashboard → Organization → Usage → Egress');
}

// ── local ───────────────────────────────────────────────────────────────────
function checkLocal(dbPath) {
  console.log('\n=== LOCAL DATABASE ===');
  console.log(`  ${dbPath}`);
  if (!fs.existsSync(dbPath)) {
    fail('local database not found — start the app once so it migrates, or pass the path');
    return;
  }

  let DatabaseSync;
  try {
    ({ DatabaseSync } = require('node:sqlite'));
  } catch {
    fail('this Node build has no node:sqlite — run with Node >= 22.5');
    return;
  }

  const db = new DatabaseSync(dbPath, { readOnly: true });
  try {
    const version = db.prepare('PRAGMA user_version').get().user_version;
    console.log(`  schema user_version: ${version}`);
    if (version >= 36) pass('local database is at v36 (watermarks + retry ledger)');
    else if (version >= 35) fail(`at v35 — the retry ledger (v36) is missing; start the app once`);
    else fail(`at v${version} — the incremental engine (v35/v36) is not in this database yet; start the app once`);

    const has = (t) => !!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(t);
    for (const t of ['sync_watermarks', 'sync_retry', 'sync_tombstones', 'sync_dirty']) {
      if (!has(t)) fail(`table ${t} is missing`);
    }

    if (has('sync_watermarks')) {
      const rows = db.prepare('SELECT * FROM sync_watermarks ORDER BY table_name').all();
      if (!rows.length) {
        fail('sync_watermarks is EMPTY — the app has not completed a sync pass yet (sign in, then look again)');
      } else {
        const withSeq = rows.filter((r) => Number(r.cloud_seq) > 0);
        const withMs = rows.filter((r) => Number(r.cloud_ms) > 0);
        console.log(`  watermarks: ${rows.length} table(s), ${withSeq.length} with a sequence watermark, ${withMs.length} with a timestamp watermark`);
        if (withSeq.length) {
          pass('sequence watermarks ARE live — deltas are clock-independent and exact');
        } else {
          fail('no sequence watermark yet — either 0005 is not applied, or no sync pass has completed');
        }
        for (const r of rows.slice(0, 6)) {
          console.log(`    ${String(r.table_name).padEnd(26)} local_ms=${r.local_ms} cloud_ms=${r.cloud_ms} cloud_seq=${r.cloud_seq} full_ms=${r.full_ms}`);
        }
        if (rows.length > 6) console.log(`    … ${rows.length - 6} more`);
      }
    }

    if (has('sync_retry')) {
      const stuck = db.prepare('SELECT table_name, row_id, attempts, last_error FROM sync_retry LIMIT 20').all();
      const total = db.prepare('SELECT COUNT(*) c FROM sync_retry').get().c;
      if (total === 0) {
        pass('retry ledger is empty — nothing is stuck');
      } else {
        console.log(`  retry ledger: ${total} row(s) waiting out a backoff`);
        for (const r of stuck) {
          console.log(`    ${String(r.table_name).padEnd(22)} id=${r.row_id} attempts=${r.attempts} ${String(r.last_error || '').slice(0, 80)}`);
        }
      }
    }

    if (has('sync_tombstones')) {
      const t = db.prepare('SELECT COUNT(*) c FROM sync_tombstones').get().c;
      console.log(`  tombstone ledger: ${t} row(s) — no longer a per-pass cost, only new markers are read`);
    }

    if (has('sync_dirty')) {
      const dirty = db.prepare('SELECT table_name, seq FROM sync_dirty').all();
      console.log(`  dirty tables right now: ${dirty.length ? dirty.map((d) => `${d.table_name}(${d.seq})`).join(', ') : 'none'}`);
    }
  } finally {
    db.close();
  }
}

(async () => {
  const dbPath = process.argv[2] || defaultDbPath();
  console.log('Natively sync setup verification');
  await checkCloud();
  await checkProxy();
  checkLocal(dbPath);
  console.log('');
  if (failures === 0) {
    console.log('RESULT: all checks passed.');
    process.exitCode = 0;
  } else {
    console.log(`RESULT: ${failures} check(s) failed — see FAIL lines above.`);
    process.exitCode = 1;
  }
})().catch((e) => {
  console.error('\nverification aborted:', e && e.message ? e.message : e);
  process.exit(2);
});
