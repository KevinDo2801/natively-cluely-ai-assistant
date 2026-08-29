/**
 * Two-way sync between the local Natively SQLite database and Supabase.
 *
 * Runs under Electron's Node runtime so the repo's better-sqlite3 (compiled
 * for Electron's ABI) loads:
 *
 *     npm run supabase:sync                # full two-way (LWW) sync
 *     npm run supabase:sync -- --dry-run   # plan only, no writes
 *     npm run supabase:sync -- --push-only # local wins, no cloud reads
 *     npm run supabase:sync -- --pull-only # cloud wins, no local reads
 *     npm run supabase:sync -- --user-email you@example.com
 *     npm run supabase:sync -- --db-path C:\path\natively.db
 *
 * Required env (from .env, git-ignored):
 *   SUPABASE_URL, SUPABASE_SERVICE_KEY   (service_role — bypasses RLS)
 *   SUPABASE_SYNC_USER_EMAIL             (optional; defaults to the only auth user)
 * Optional env:
 *   NATIVELY_DB_PATH                     (override the local DB path)
 */

'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');

const REPO_ROOT = path.join(__dirname, '..', '..');

// ── CLI args (after the script path in Electron's argv) ────────────────────
function parseArgs(argv) {
  const args = {};
  for (const a of argv) {
    if (a === '--dry-run') args.dryRun = true;
    else if (a === '--push-only') args.direction = 'push';
    else if (a === '--pull-only') args.direction = 'pull';
    else if (a === '--help') args.help = true;
    else if (a.startsWith('--user-email=')) args.userEmail = a.slice('--user-email='.length);
    else if (a.startsWith('--db-path=')) args.dbPath = a.slice('--db-path='.length);
    else if (a.startsWith('--batch=')) args.batch = Number(a.slice('--batch='.length));
  }
  return args;
}

function loadDotEnv() {
  const envPath = path.join(REPO_ROOT, '.env');
  if (!fs.existsSync(envPath)) return;
  for (const line of fs.readFileSync(envPath, 'utf8').split(/\r?\n/)) {
    const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
    if (m) process.env[m[1]] = process.env[m[1]] || m[2].trim();
  }
}

function defaultDbPath() {
  if (process.platform === 'win32') {
    return path.join(process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming'), 'Natively', 'natively.db');
  }
  return path.join(os.homedir(), 'Library', 'Application Support', 'Natively', 'natively.db');
}

async function resolveUserId(client, userEmail) {
  const { data, error } = await client.auth.admin.listUsers({ perPage: 100 });
  if (error) throw new Error(`Could not list auth users: ${error.message}`);
  const users = (data && data.users) || [];
  if (userEmail) {
    const match = users.find((u) => (u.email || '').toLowerCase() === userEmail.toLowerCase());
    if (!match) throw new Error(`No auth user with email "${userEmail}". Registered: ${users.map((u) => u.email).join(', ') || '(none)'}`);
    return match;
  }
  if (users.length === 0) throw new Error('No auth users in the project — sign up in the app first, then re-run.');
  if (users.length > 1) {
    throw new Error(`Multiple auth users (${users.map((u) => u.email).join(', ')}). Pass --user-email=... to pick one.`);
  }
  return users[0];
}

async function main() {
  loadDotEnv();

  const argv = process.argv.slice(1);
  const scriptIdx = argv.findIndex((a) => a.includes('sync-local-to-supabase'));
  const args = parseArgs(scriptIdx >= 0 ? argv.slice(scriptIdx + 1) : argv);

  if (args.help) {
    console.log('Usage: npm run supabase:sync [-- --dry-run] [-- --push-only|--pull-only] [-- --user-email you@example.com] [-- --db-path C:\\path\\natively.db] [-- --batch 500]');
    return 0;
  }

  const url = process.env.SUPABASE_URL;
  const serviceKey = process.env.SUPABASE_SERVICE_KEY;
  if (!url || !serviceKey) {
    throw new Error('Missing SUPABASE_URL / SUPABASE_SERVICE_KEY in .env');
  }

  const dbPath = args.dbPath || process.env.NATIVELY_DB_PATH || defaultDbPath();
  if (!fs.existsSync(dbPath)) {
    throw new Error(`Local database not found: ${dbPath}`);
  }

  // Repo build of better-sqlite3 is compiled for Electron — we run under it.
  const Database = require(path.join(REPO_ROOT, 'node_modules', 'better-sqlite3'));
  const { createClient } = require(path.join(REPO_ROOT, 'node_modules', '@supabase', 'supabase-js'));
  const { syncAll } = require(path.join(REPO_ROOT, 'electron', 'services', 'supabaseSyncEngine.js'));

  const client = createClient(url, serviceKey, {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
  });

  const user = await resolveUserId(client, args.userEmail || process.env.SUPABASE_SYNC_USER_EMAIL);
  console.log(`Target user: ${user.email} (${user.id})`);
  console.log(`Local DB:   ${dbPath}`);
  console.log(`Direction:  ${args.direction || 'both'}${args.dryRun ? ' (DRY RUN — no writes)' : ''}`);

  const db = new Database(dbPath, { fileMustExist: true });
  try {
    const summary = await syncAll({
      db,
      client,
      userId: user.id,
      direction: args.direction || 'both',
      dryRun: !!args.dryRun,
      batchSize: Number.isFinite(args.batch) && args.batch > 0 ? args.batch : undefined,
      onProgress({ table, phase, done, rows, cloudRows, error }) {
        if (phase === 'dry-run') {
          console.log(`  ${table.padEnd(28)} local ${rows} | cloud ${cloudRows}`);
        } else if (phase === 'pushing' && done === 0) {
          process.stdout.write(`  pushing ${table.padEnd(22)} `);
        } else if (phase === 'pushing') {
          process.stdout.write('.');
        } else if (phase === 'error') {
          console.log(`\n  ! ${table}: ${error}`);
        }
      },
    });

    console.log('\n── Summary (↑ pushed, ↓ pulled, ✕ deleted) ─────────────────');
    for (const t of summary.tables) {
      if (t.error) {
        console.log(`  ${t.table.padEnd(28)} ERROR: ${t.error}`);
        continue;
      }
      if (t.rows === 0 && t.cloudRows === 0 && t.pushed === 0 && t.pulled === 0 && t.deletedLocal === 0 && t.deletedCloud === 0) continue;
      console.log(
        `  ${t.table.padEnd(28)} local ${String(t.rows).padStart(5)} | cloud ${String(t.cloudRows).padStart(5)} → ` +
        `↑${t.pushed} ↓${t.pulled} ✕${t.deletedLocal + t.deletedCloud}${t.failed.length ? ` (${t.failed.length} failed)` : ''}`
      );
      for (const f of t.failed.slice(0, 5)) {
        console.log(`      ✗ ${f.id}: ${f.error}`);
      }
    }
    console.log(`  TOTAL: ↑${summary.totalPushed} ↓${summary.totalPulled} ✕${summary.totalDeleted}, ${summary.totalFailed} failed`);
    if (summary.totalFailed > 0) return 1;
    return 0;
  } finally {
    db.close();
  }
}

main()
  .then((code) => {
    // Flush stdout before exiting (Electron may kill the process quickly).
    setTimeout(() => process.exit(code || 0), 100);
  })
  .catch((e) => {
    console.error('\nSync failed:', e && e.message ? e.message : e);
    setTimeout(() => process.exit(1), 100);
  });
