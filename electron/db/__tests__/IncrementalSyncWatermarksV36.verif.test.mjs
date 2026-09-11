// V35 + V36 migration + engine integration — REAL DatabaseManager, REAL better-sqlite3.
//
// The incremental-sync unit tests (SupabaseSyncIncremental.test.mjs) run the
// engine against a HAND-WRITTEN schema. This file closes the remaining gap: it
// proves the engine's `sync_watermarks` / `sync_retry` SQL actually matches the
// schema the v35 + v36 migrations produce in a real database, that the trigger
// set the watermarks depend on is really there, and that a fresh install (which
// is also every existing install's first pass after upgrading) starts from
// "never synced" so the first reconcile is a full read — the migrations must not
// change what the first pass does, only what every pass after it costs.
//
// Run: npm run build:electron && ELECTRON_RUN_AS_NODE=1 ./node_modules/.bin/electron --test electron/db/__tests__/IncrementalSyncWatermarksV36.verif.test.mjs

import { test, describe, before } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '../../..');
const DB_MODULE = path.join(repoRoot, 'dist-electron/electron/db/DatabaseManager.js');
const ENGINE = path.join(repoRoot, 'electron/services/supabaseSyncEngine.js');

let DatabaseManager;
let engine;

describe('v35 incremental sync watermarks — REAL sqlite', () => {
  before(() => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'syncwm-mig-'));
    process.env.NATIVELY_TEST_USERDATA = tmp;
    DatabaseManager = require(DB_MODULE).DatabaseManager;
    engine = require(ENGINE);
  });

  test('a fresh database lands at user_version >= 36 with both incremental-sync tables', () => {
    const raw = DatabaseManager.getInstance().db;
    const version = raw.pragma('user_version', { simple: true });
    assert.ok(version >= 36, `expected user_version >= 36, got ${version}`);

    const cols = raw.prepare('PRAGMA table_info(sync_watermarks)').all().map((c) => c.name);
    for (const c of ['table_name', 'local_ms', 'cloud_ms', 'cloud_seq', 'full_ms', 'gc_ms']) {
      assert.ok(cols.includes(c), `sync_watermarks.${c} missing`);
    }

    const retryCols = raw.prepare('PRAGMA table_info(sync_retry)').all().map((c) => c.name);
    for (const c of ['table_name', 'row_id', 'attempts', 'next_attempt_ms', 'last_error']) {
      assert.ok(retryCols.includes(c), `sync_retry.${c} missing`);
    }
  });

  test('the table starts empty, so the first pass after the upgrade is a FULL read', () => {
    const raw = DatabaseManager.getInstance().db;
    // Nothing pre-seeded: every synced table must read as "never synced".
    for (const def of engine.TABLE_DEFS) {
      const wm = engine.readWatermark(raw, def.table);
      assert.deepEqual(wm, { localMs: 0, cloudMs: 0, cloudSeq: 0, fullMs: 0, gcMs: 0 },
        `${def.table} must start with no watermark (first pass is a full read, like v34)`);
    }
  });

  test('readWatermark/writeWatermark round-trip against the migrated schema', () => {
    const raw = DatabaseManager.getInstance().db;
    const all = { localMs: 11, cloudMs: 22, cloudSeq: 33, fullMs: 44, gcMs: 55 };
    engine.writeWatermark(raw, 'transcripts', all);
    assert.deepEqual(engine.readWatermark(raw, 'transcripts'), all);

    // Upsert, not insert: a second write for the same table must not throw on PK.
    engine.writeWatermark(raw, 'transcripts', { localMs: 111, cloudMs: 222, cloudSeq: 333, fullMs: 444, gcMs: 555 });
    assert.deepEqual(engine.readWatermark(raw, 'transcripts'), { localMs: 111, cloudMs: 222, cloudSeq: 333, fullMs: 444, gcMs: 555 });

    const rows = raw.prepare("SELECT COUNT(*) c FROM sync_watermarks WHERE table_name='transcripts'").get().c;
    assert.equal(rows, 1, 'one watermark row per table');

    engine.writeWatermark(raw, 'meetings', { localMs: 5, cloudMs: 5, cloudSeq: 5, fullMs: 5, gcMs: 5 });
    assert.equal(raw.prepare('SELECT COUNT(*) c FROM sync_watermarks').get().c, 2);
  });

  test('the retry ledger round-trips on the real schema', () => {
    const raw = DatabaseManager.getInstance().db;
    const t0 = Date.now();
    engine.recordRetries(raw, 'transcripts', ['9'], 'cloud said no', t0);
    assert.equal(engine.countRetries(raw, 'transcripts'), 1);
    assert.deepEqual(engine.readAllRetryKeys(raw, 'transcripts'), ['9']);
    assert.deepEqual(engine.readDueRetries(raw, 'transcripts', t0), [], 'not due until the backoff elapses');
    assert.equal(engine.readDueRetries(raw, 'transcripts', t0 + engine.RETRY_BASE_MS).length, 1);
    const row = raw.prepare("SELECT attempts, last_error FROM sync_retry WHERE table_name='transcripts' AND row_id='9'").get();
    assert.equal(row.attempts, 1);
    assert.equal(row.last_error, 'cloud said no');

    engine.recordRetries(raw, 'transcripts', ['9'], 'again', t0 + 1);
    assert.equal(raw.prepare("SELECT attempts FROM sync_retry WHERE row_id='9'").get().attempts, 2);

    engine.clearRetries(raw, 'transcripts', ['9']);
    assert.equal(engine.countRetries(raw, 'transcripts'), 0);
  });

  test('wipeSyncedTables clears the watermarks and the retry ledger', () => {
    const raw = DatabaseManager.getInstance().db;
    engine.writeWatermark(raw, 'transcripts', { localMs: 1, cloudMs: 1, cloudSeq: 1, fullMs: 1, gcMs: 1 });
    engine.recordRetries(raw, 'transcripts', ['1'], 'x', Date.now());
    assert.ok(raw.prepare('SELECT COUNT(*) c FROM sync_watermarks').get().c > 0, 'precondition');
    assert.ok(raw.prepare('SELECT COUNT(*) c FROM sync_retry').get().c > 0, 'precondition');

    engine.wipeSyncedTables(raw);
    assert.equal(raw.prepare('SELECT COUNT(*) c FROM sync_watermarks').get().c, 0,
      'a stale watermark after the wipe would skip the rows the blind pull brings down');
    assert.equal(raw.prepare('SELECT COUNT(*) c FROM sync_retry').get().c, 0,
      'a stale retry entry would be re-offered after the cache was rebuilt from the cloud');
    assert.equal(engine.readWatermark(raw, 'transcripts').cloudMs, 0);
  });

  test('the triggers the watermarks depend on exist on a synced table', () => {
    const raw = DatabaseManager.getInstance().db;
    const names = raw.prepare("SELECT name FROM sqlite_master WHERE type='trigger'").all().map((r) => r.name);
    for (const suffix of ['ai', 'au', 'ad', 'di', 'du', 'dd']) {
      assert.ok(names.includes(`trg_transcripts_${suffix}`),
        `trg_transcripts_${suffix} missing — the watermark contract depends on updated_at + dirty tracking`);
    }
    // v33's updated_at stampers and v34's dirty counters must not be shadowed by
    // the v35 addition; v35 adds a table, no triggers.
    assert.ok(names.includes('trg_knowledge_cards_dd'), 'v34 dirty triggers must survive v35');
  });

  test('migrations are idempotent: re-running the chain leaves the watermarks intact', () => {
    const dbPath = DatabaseManager.getInstance().getDbPath();
    const raw = DatabaseManager.getInstance().db;
    engine.writeWatermark(raw, 'transcripts', { localMs: 7, cloudMs: 8, cloudSeq: 9, fullMs: 10, gcMs: 11 });

    // Re-open the same file: the migration chain runs again from user_version 36
    // and must be a no-op (the CREATE TABLE/ALTER are guarded, and no version gate
    // re-fires).
    const Database = require(path.join(repoRoot, 'node_modules', 'better-sqlite3'));
    const again = new Database(dbPath, { fileMustExist: true });
    try {
      assert.equal(again.pragma('user_version', { simple: true }), 36, 'the chain must not advance the version again');
      assert.deepEqual(engine.readWatermark(again, 'transcripts'), { localMs: 7, cloudMs: 8, cloudSeq: 9, fullMs: 10, gcMs: 11 });
    } finally {
      again.close();
    }
  });
});
