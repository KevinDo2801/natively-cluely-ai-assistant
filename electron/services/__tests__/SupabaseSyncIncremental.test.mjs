// Regression + proof tests for the incremental (v35) sync engine.
//
// Incident this exists to prevent: the v2/v3 engine reconciled by reading EVERY
// row of EVERY table from Supabase on every pass. Measured on this repo's own
// dev database that was 2.35 MB of rows + 3.44 MB of tombstones per 60s pass —
// ~5.8 MB/minute, ~8 GB/day while signed in, with a SINGLE user — which blew
// the Supabase free-plan egress quota (6.52 GB used against a 5 GB allowance).
// Egress scaled with database size, never with the number of users.
//
// The essential property under test is therefore an EGRESS property: a pass that
// has nothing to do must not download the database. The fake Supabase client
// below counts the bytes each query returns, so these tests assert the metric
// that actually caused the incident instead of only asserting final row state.
//
// The second, equally important property: incremental reads must not break
// correctness. Remote deletions, local deletions, LWW conflicts and the
// push-failure retry path are all covered, because an optimisation that loses a
// row is not an optimisation.
//
// Run under the Electron ABI (better-sqlite3 is built for Electron):
//   ELECTRON_RUN_AS_NODE=1 ./node_modules/.bin/electron --test <file>

import { afterEach, beforeEach, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import Database from 'better-sqlite3';

const require = createRequire(import.meta.url);
const {
  TABLE_DEFS,
  syncAll,
  syncTable,
  scopeIncrementalCandidates,
  readWatermark,
  writeWatermark,
  isNeverSynced,
  cloudHasSyncSeq,
  __resetSeqProbe,
  retryDelayMs,
  readDueRetries,
  readAllRetryKeys,
  recordRetries,
  clearRetries,
  countRetries,
} = require('../supabaseSyncEngine.js');

const MEETINGS = TABLE_DEFS.find((d) => d.table === 'meetings');
const TRANSCRIPTS = TABLE_DEFS.find((d) => d.table === 'transcripts');
const FOLDERS = TABLE_DEFS.find((d) => d.table === 'folders');
const CHUNKS = TABLE_DEFS.find((d) => d.table === 'chunks');
const SYNCED = [FOLDERS, MEETINGS, TRANSCRIPTS, CHUNKS];

const USER = 'user-1';
const HOUR_AGO_ISO = new Date(Date.now() - 3_600_000).toISOString();

// ---------------------------------------------------------------------------
// Fake Supabase client: a tiny in-memory PostgREST that records the bytes each
// response would have cost on the wire.
// ---------------------------------------------------------------------------

class FakeQuery {
  constructor(cloud, table) {
    this.cloud = cloud;
    this.table = table;
    this.op = 'select';
    this.filters = [];
    this.cols = '*';
    this.payload = null;
    this.onConflict = null;
    this.orderCol = null;
    this.rangeArgs = null;
  }
  select(cols) { this.cols = cols || '*'; return this; }
  upsert(payload, opts) { this.op = 'upsert'; this.payload = payload; this.onConflict = opts && opts.onConflict; return this; }
  delete() { this.op = 'delete'; return this; }
  eq(c, v) { this.filters.push({ t: 'eq', c, v }); return this; }
  neq(c, v) { this.filters.push({ t: 'neq', c, v }); return this; }
  gt(c, v) { this.filters.push({ t: 'gt', c, v }); return this; }
  lt(c, v) { this.filters.push({ t: 'lt', c, v }); return this; }
  in(c, v) { this.filters.push({ t: 'in', c, v }); return this; }
  order(c) { this.orderCol = c; return this; }
  range(a, b) { this.rangeArgs = [a, b]; return this; }
  limit(n) { this.limitN = n; return this; }
  abortSignal() { return this; }
  then(resolve, reject) { return this.cloud.execute(this).then(resolve, reject); }
}

function makeFakeCloud(seed = {}, { syncSeq = true } = {}) {
  const tables = new Map();
  // Mirror of the server-side sequence from migration 0005.
  let seq = 0;
  const nextSeq = () => (seq += 1);
  for (const [name, rows] of Object.entries(seed)) {
    const m = new Map();
    for (const r of rows) {
      const row = { ...r };
      if (syncSeq && row.sync_seq === undefined) row.sync_seq = nextSeq();
      m.set(matchKey(name, row), row);
    }
    tables.set(name, m);
  }
  const stats = { requests: 0, rowsRead: 0, bytesOut: 0, rowsWritten: 0, byTable: {} };
  const log = [];

  // Declared as function statements so the seed loop at the top of this factory
  // can use them before the const bindings below are initialized.
  function conflictColumns(table, onConflict) {
    if (onConflict) return onConflict.split(',').map((s) => s.trim());
    return table === 'sync_tombstones' ? ['user_id', 'table_name', 'row_id'] : ['id'];
  }

  function matchKey(table, row, onConflict) {
    return conflictColumns(table, onConflict).map((c) => String(row[c])).join('\u0000');
  }

  function rowOf(table) {
    if (!tables.has(table)) tables.set(table, new Map());
    return tables.get(table);
  }

  function matches(row, filters) {
    return filters.every((f) => {
      const v = row[f.c];
      if (f.t === 'eq') return String(v) === String(f.v);
      if (f.t === 'neq') return String(v) !== String(f.v);
      if (f.t === 'gt') {
        // `sync_seq` is numeric; `updated_at`/`deleted_at` are ISO-8601, which
        // sorts lexically. Compare numerically when both sides are numbers so
        // seq 10 is correctly treated as greater than seq 9.
        const a = Number(v);
        const b = Number(f.v);
        if (v !== null && v !== '' && Number.isFinite(a) && Number.isFinite(b)) return a > b;
        return String(v) > String(f.v);
      }
      if (f.t === 'lt') {
        const a = Number(v);
        const b = Number(f.v);
        if (v !== null && v !== '' && Number.isFinite(a) && Number.isFinite(b)) return a < b;
        return String(v) < String(f.v);
      }
      if (f.t === 'in') return f.v.map(String).includes(String(v));
      return true;
    });
  }

  const client = {
    from(table) { return new FakeQuery(cloud, table); },
  };

  const cloud = {
    client,
    log,
    stats,
    maxSeq() { return seq; },
    rows(table) { return [...rowOf(table).values()]; },
    get(table, key) { return rowOf(table).get(String(key)); },
    // Like the real BEFORE INSERT OR UPDATE trigger, every write gets a FRESH
    // sequence — the client's value is overwritten. (A test that needs a specific
    // sequence uses `replace` with an explicit `sync_seq`.)
    put(table, row, onConflict) {
      const stored = { ...row };
      if (syncSeq) stored.sync_seq = nextSeq();
      rowOf(table).set(matchKey(table, stored, onConflict), stored);
    },
    /**
     * Replace a table's whole content (test setup that bypasses HTTP). An
     * explicit `sync_seq` is RESPECTED here, which is how tests build a ledger
     * of old markers that the delta must ignore.
     */
    replace(table, rows) {
      const m = new Map();
      for (const r of rows) {
        const row = { ...r };
        if (syncSeq && row.sync_seq === undefined) row.sync_seq = nextSeq();
        m.set(matchKey(table, row), row);
      }
      tables.set(table, m);
    },
    resetStats() {
      stats.requests = 0; stats.rowsRead = 0; stats.bytesOut = 0; stats.rowsWritten = 0; stats.byTable = {};
      log.length = 0;
    },
    /** Query filters recorded for one table + operation. */
    filtersFor(table, op = 'select') {
      return log.filter((e) => e.table === table && e.op === op).map((e) => e.filters);
    },
    /** Column lists requested for one table + operation. */
    colsFor(table, op = 'select') {
      return log.filter((e) => e.table === table && e.op === op).map((e) => e.cols);
    },
    bytes(table) { return (stats.byTable[table] || { bytesOut: 0 }).bytesOut; },

    async execute(q) {
      stats.requests++;
      const entry = { table: q.table, op: q.op, filters: q.filters, cols: q.cols, range: q.rangeArgs };
      log.push(entry);
      const bucket = stats.byTable[q.table] || (stats.byTable[q.table] = { requests: 0, rowsRead: 0, bytesOut: 0 });
      bucket.requests++;

      if (q.op === 'select') {
        // Without migration 0005 the column does not exist: PostgREST answers
        // with an error naming it, which is exactly what the engine's probe
        // keys off to fall back to timestamp watermarks.
        if (!syncSeq && String(q.cols).includes('sync_seq')) {
          return { data: null, error: { message: 'column sync_tombstones.sync_seq does not exist' } };
        }
        let out = [...rowOf(q.table).values()].filter((r) => matches(r, q.filters));
        if (q.orderCol) {
          out.sort((a, b) => (String(a[q.orderCol]) < String(b[q.orderCol]) ? -1 : String(a[q.orderCol]) > String(b[q.orderCol]) ? 1 : 0));
        }
        if (q.rangeArgs) out = out.slice(q.rangeArgs[0], q.rangeArgs[1] + 1);
        if (q.limitN !== undefined) out = out.slice(0, q.limitN);
        if (q.cols !== '*') {
          const keep = q.cols.split(',').map((s) => s.trim());
          out = out.map((r) => {
            const p = {};
            for (const c of keep) p[c] = r[c] === undefined ? null : r[c];
            return p;
          });
        }
        const bytes = Buffer.byteLength(JSON.stringify(out), 'utf8');
        stats.rowsRead += out.length;
        stats.bytesOut += bytes;
        bucket.rowsRead += out.length;
        bucket.bytesOut += bytes;
        return { data: out, error: null };
      }

      if (q.op === 'upsert') {
        const list = Array.isArray(q.payload) ? q.payload : [q.payload];
        for (const r of list) {
          // The BEFORE INSERT OR UPDATE trigger from migration 0005 stamps a
          // fresh sequence on every write, overriding anything the client sent.
          const stored = { ...r };
          if (syncSeq) stored.sync_seq = nextSeq();
          rowOf(q.table).set(matchKey(q.table, stored, q.onConflict), stored);
          stats.rowsWritten++;
        }
        return { error: null };
      }

      if (q.op === 'delete') {
        for (const [k, r] of [...rowOf(q.table).entries()]) {
          if (matches(r, q.filters)) {
            rowOf(q.table).delete(k);
            stats.rowsWritten++;
          }
        }
        return { error: null };
      }

      return { data: null, error: { message: `unsupported op ${q.op}` } };
    },
  };

  return cloud;
}

// ---------------------------------------------------------------------------
// Local SQLite schema: just enough of the v33/v34/v35 shape for the engine.
// ---------------------------------------------------------------------------

function ddlFor(def) {
  const pk = def.pk || 'id';
  const cols = def.columns.map((c) => {
    if (c === pk) {
      return def.pkType === 'bigint'
        ? `"${c}" INTEGER PRIMARY KEY AUTOINCREMENT`
        : `"${c}" TEXT PRIMARY KEY`;
    }
    return `"${c}" TEXT`;
  });
  return `CREATE TABLE "${def.table}" (${cols.join(', ')}, "updated_at" TEXT);`;
}

function makeLocalDb() {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE sync_tombstones (
      table_name TEXT NOT NULL,
      row_id TEXT NOT NULL,
      deleted_at TEXT NOT NULL,
      PRIMARY KEY (table_name, row_id)
    );
    CREATE TABLE sync_dirty (table_name TEXT PRIMARY KEY, seq INTEGER NOT NULL DEFAULT 1);
    CREATE TABLE sync_watermarks (
      table_name TEXT PRIMARY KEY,
      local_ms INTEGER NOT NULL DEFAULT 0,
      cloud_ms INTEGER NOT NULL DEFAULT 0,
      cloud_seq INTEGER NOT NULL DEFAULT 0,
      full_ms  INTEGER NOT NULL DEFAULT 0,
      gc_ms    INTEGER NOT NULL DEFAULT 0
    );
    CREATE TABLE sync_retry (
      table_name TEXT NOT NULL,
      row_id TEXT NOT NULL,
      attempts INTEGER NOT NULL DEFAULT 1,
      next_attempt_ms INTEGER NOT NULL DEFAULT 0,
      last_error TEXT,
      updated_at TEXT NOT NULL DEFAULT '',
      PRIMARY KEY (table_name, row_id)
    );
  `);
  for (const def of SYNCED) {
    db.exec(ddlFor(def));
    const pk = def.pk || 'id';
    db.exec(`
      CREATE TRIGGER trg_${def.table}_ai AFTER INSERT ON "${def.table}" FOR EACH ROW BEGIN
        UPDATE "${def.table}" SET updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
          WHERE "${pk}" = NEW."${pk}" AND NEW.updated_at IS NULL;
        DELETE FROM sync_tombstones WHERE table_name = '${def.table}' AND row_id = CAST(NEW."${pk}" AS TEXT);
      END;
      CREATE TRIGGER trg_${def.table}_au AFTER UPDATE ON "${def.table}" FOR EACH ROW
      WHEN NEW.updated_at IS OLD.updated_at BEGIN
        UPDATE "${def.table}" SET updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE "${pk}" = NEW."${pk}";
      END;
      CREATE TRIGGER trg_${def.table}_ad AFTER DELETE ON "${def.table}" FOR EACH ROW BEGIN
        INSERT OR REPLACE INTO sync_tombstones (table_name, row_id, deleted_at)
        VALUES ('${def.table}', CAST(OLD."${pk}" AS TEXT), strftime('%Y-%m-%dT%H:%M:%fZ','now'));
      END;
    `);
  }
  return db;
}

/** A vector of `dims` float32 values, like a real pgvector embedding. */
function vectorBlob(dims, fill = 0.5) {
  const buf = Buffer.alloc(dims * 4);
  for (let i = 0; i < dims; i++) buf.writeFloatLE(fill, i * 4);
  return buf;
}

/** Both sides in agreement, stamped well outside the watermark overlap window. */
function seedInSync(db) {
  db.prepare(
    `INSERT INTO meetings (id, title, start_time, duration_ms, summary_json, created_at, updated_at)
     VALUES ('m1', 'Weekly sync', 1, 2, '{}', ?, ?)`
  ).run(HOUR_AGO_ISO, HOUR_AGO_ISO);
  const ins = db.prepare(
    `INSERT INTO transcripts (id, meeting_id, speaker, content, timestamp_ms, updated_at)
     VALUES (?, 'm1', 'user', ?, ?, ?)`
  );
  ins.run(1, 'first segment', 1000, HOUR_AGO_ISO);
  ins.run(2, 'second segment', 2000, HOUR_AGO_ISO);
  ins.run(3, 'third segment', 3000, HOUR_AGO_ISO);
}

/**
 * One RAG chunk with a 1536-dim embedding on BOTH sides. Chunks are the table
 * where egress is dominated by the vector, not by the text (~15 KB per row on
 * the wire), which is what the slim back-fill exists to avoid.
 */
const VECTOR_DIMS = 1536;
function seedChunkInSync(db) {
  db.prepare(
    `INSERT INTO chunks (id, meeting_id, chunk_index, speaker, start_timestamp_ms, end_timestamp_ms,
                         cleaned_text, token_count, embedding, created_at, updated_at)
     VALUES (1, 'm1', 0, 'user', 0, 1000, 'a chunk of lecture', 5, ?, ?, ?)`
  ).run(vectorBlob(VECTOR_DIMS), HOUR_AGO_ISO, HOUR_AGO_ISO);
}

function cloudSeedFromLocal(db) {
  const read = (table, cols) => db.prepare(`SELECT ${cols} FROM "${table}"`).all();
  const cols = (def) => [...def.columns, 'updated_at'].map((c) => `"${c}"`).join(', ');
  const shape = (def, rows) => rows.map((r) => {
    const out = { ...r, user_id: USER };
    // pgvector travels as text '[f,f,…]', not as a BLOB.
    if (def.vector && out[def.vector] instanceof Uint8Array) {
      const n = Math.floor(out[def.vector].length / 4);
      const f = new Float32Array(n);
      for (let i = 0; i < n; i++) f[i] = out[def.vector].readFloatLE(i * 4);
      out[def.vector] = `[${Array.from(f).join(',')}]`;
    }
    return out;
  });
  return {
    transcripts: shape(TRANSCRIPTS, read('transcripts', cols(TRANSCRIPTS))),
    meetings: shape(MEETINGS, read('meetings', cols(MEETINGS))),
    chunks: shape(CHUNKS, read('chunks', cols(CHUNKS))),
    folders: [],
    sync_tombstones: [],
  };
}

function runPass(db, cloud, { tables = ['transcripts'], ...extra } = {}) {
  cloud.resetStats();
  return syncAll({
    db,
    client: cloud.client,
    userId: USER,
    tables,
    deadline: Date.now() + 30_000,
    ...extra,
  });
}

// ---------------------------------------------------------------------------
// Pure scoping rules
// ---------------------------------------------------------------------------

const mkLocal = (key, ms) => ({ _key: key, _pk: 'id', updatedMs: ms });
const mkCloud = (key, ms) => ({ _key: key, _pk: 'id', updatedMs: ms });

describe('scopeIncrementalCandidates (pure)', () => {
  test('a never-synced table treats every key as a candidate (first pass = full)', async () => {
    const s = scopeIncrementalCandidates({
      localRows: [mkLocal('a', 10), mkLocal('b', 20)],
      localTombs: new Map([['c', 30]]),
      cloudRows: [mkCloud('d', 40)],
      cloudTombs: new Map([['e', 50]]),
      localSinceMs: 0,
      cloudSinceMs: 0,
    });
    assert.equal(s.allCandidates, true);
    assert.deepEqual([...s.keys].sort(), ['a', 'b', 'c', 'd', 'e']);
    assert.equal(s.localRows.length, 2);
    assert.equal(s.localTombs.size, 1);
    assert.equal(s.cloudRows.length, 1);
    assert.equal(s.cloudTombs.size, 1);
  });

  test('nothing changed since either watermark yields an empty candidate set', async () => {
    const s = scopeIncrementalCandidates({
      localRows: [mkLocal('a', 100), mkLocal('b', 200)],
      localTombs: new Map([['c', 150]]),
      cloudRows: [mkCloud('a', 100), mkCloud('b', 200)],
      cloudTombs: new Map([['c', 150]]),
      localSinceMs: 500,
      cloudSinceMs: 500,
    });
    assert.equal(s.keys.size, 0, 'a steady state must consider nothing — this is the egress win');
    assert.equal(s.localRows.length, 0);
    assert.equal(s.cloudRows.length, 0);
    assert.equal(s.localTombs.size, 0);
    assert.equal(s.cloudTombs.size, 0);
    assert.equal(s.allCandidates, false);
  });

  test('only keys stamped after a watermark are candidates', async () => {
    const s = scopeIncrementalCandidates({
      localRows: [mkLocal('old', 100), mkLocal('new', 900)],
      localTombs: new Map(),
      cloudRows: [mkCloud('old', 100), mkCloud('cloudnew', 800)],
      cloudTombs: new Map(),
      localSinceMs: 500,
      cloudSinceMs: 700,
    });
    assert.deepEqual([...s.keys].sort(), ['cloudnew', 'new']);
    // Unchanged keys must not be handed to the planner: their absence from the
    // inputs is what proves the pass cannot act on them.
    assert.deepEqual(s.localRows.map((r) => r._key), ['new']);
    assert.deepEqual(s.cloudRows.map((r) => r._key), ['cloudnew']);
  });

  test('locally-changed keys are reported as needing a cloud back-fill', async () => {
    const s = scopeIncrementalCandidates({
      localRows: [mkLocal('editedHere', 900)],
      localTombs: new Map(),
      cloudRows: [],
      cloudTombs: new Map(),
      localSinceMs: 500,
      cloudSinceMs: 500,
    });
    assert.deepEqual(s.missingCloudKeys, ['editedHere'],
      'without the back-fill the planner would read "no cloud row" and re-upload the table');

    const withCloud = scopeIncrementalCandidates({
      localRows: [mkLocal('editedHere', 900)],
      localTombs: new Map(),
      cloudRows: [mkCloud('editedHere', 100)],
      cloudTombs: new Map(),
      localSinceMs: 500,
      cloudSinceMs: 500,
    });
    assert.deepEqual(withCloud.missingCloudKeys, [], 'a key already in the delta must not be re-fetched');
  });

  test('a value of exactly the watermark is not a candidate (strictly newer wins)', async () => {
    const s = scopeIncrementalCandidates({
      localRows: [mkLocal('a', 500)],
      localTombs: new Map([['b', 500]]),
      cloudRows: [mkCloud('c', 500)],
      cloudTombs: new Map([['d', 500]]),
      localSinceMs: 500,
      cloudSinceMs: 500,
    });
    assert.equal(s.keys.size, 0);
  });

  test('extraKeys (the retry ledger) are candidates even when nothing else changed', async () => {
    const s = scopeIncrementalCandidates({
      localRows: [mkLocal('stuck', 100)],
      localTombs: new Map(),
      cloudRows: [],
      cloudTombs: new Map(),
      localSinceMs: 500,
      cloudSinceMs: 500,
      extraKeys: ['stuck'],
    });
    assert.deepEqual([...s.keys], ['stuck'],
      'a row whose push failed must be re-offered without re-widening the pass');
    assert.deepEqual(s.localRows.map((r) => r._key), ['stuck']);
    assert.deepEqual(s.missingCloudKeys, ['stuck']);
  });

  test('cloudDeltaIsExact treats every delta entry as changed, regardless of its stamp', async () => {
    const inputs = {
      localRows: [],
      localTombs: new Map(),
      // A row whose updated_at is OLDER than the watermark — exactly the shape a
      // writer with a lagging clock produces. In timestamp mode it is invisible;
      // in sequence mode its presence in the delta is the whole evidence needed.
      cloudRows: [mkCloud('skewed', 100)],
      cloudTombs: new Map([['gone', 50]]),
      localSinceMs: 500,
      cloudSinceMs: 500,
    };
    const timestampMode = scopeIncrementalCandidates(inputs);
    assert.equal(timestampMode.keys.size, 0, 'timestamp mode cannot see a lagging writer (that is the bug)');

    const seqMode = scopeIncrementalCandidates({ ...inputs, cloudDeltaIsExact: true });
    assert.deepEqual([...seqMode.keys].sort(), ['gone', 'skewed'],
      'sequence mode must act on the delta itself, never on a clock comparison');
  });
});

describe('retry ledger (replaces holding the watermark back)', () => {
  let db;
  beforeEach(() => { db = makeLocalDb(); });
  afterEach(() => { try { db.close(); } catch { /* noop */ } });

  test('backoff grows exponentially and is capped', async () => {
    assert.equal(retryDelayMs(1), 30_000);
    assert.equal(retryDelayMs(2), 60_000);
    assert.equal(retryDelayMs(3), 120_000);
    // Capped: a row that can never be pushed must not back off into never being
    // retried, and must not be retried every pass either.
    assert.equal(retryDelayMs(20), 30 * 60 * 1000);
    assert.equal(retryDelayMs(0), 30_000, 'a nonsensical attempt count still yields a sane delay');
  });

  test('record → due → clear round-trip, with attempts accumulating', async () => {
    const t0 = 1_000_000;
    assert.deepEqual(readAllRetryKeys(db, 'transcripts'), []);
    assert.equal(countRetries(db, 'transcripts'), 0);

    recordRetries(db, 'transcripts', ['7', '8'], 'boom', t0);
    assert.equal(countRetries(db, 'transcripts'), 2);
    assert.deepEqual(readAllRetryKeys(db, 'transcripts').sort(), ['7', '8']);
    // Not due yet: the pass must not re-offer them immediately.
    assert.deepEqual(readDueRetries(db, 'transcripts', t0), []);
    assert.equal(readDueRetries(db, 'transcripts', t0 + 29_999).length, 0);
    assert.equal(readDueRetries(db, 'transcripts', t0 + 30_000).length, 2);

    // A second failure doubles the delay.
    const t1 = t0 + 30_000;
    recordRetries(db, 'transcripts', ['7'], 'boom again', t1);
    // At t1+59s only '8' (whose backoff elapsed at t0+30s) is due; '7' now waits
    // until t1+60s.
    assert.deepEqual(readDueRetries(db, 'transcripts', t1 + 59_999).map((r) => r.row_id), ['8']);
    assert.deepEqual(readDueRetries(db, 'transcripts', t1 + 60_000).map((r) => r.row_id).sort(), ['7', '8']);

    clearRetries(db, 'transcripts', ['7', '8']);
    assert.equal(countRetries(db, 'transcripts'), 0);
  });

  test('a database without the ledger degrades to no retries instead of throwing', async () => {
    const bare = new Database(':memory:');
    try {
      assert.deepEqual(readDueRetries(bare, 'transcripts', Date.now()), []);
      assert.deepEqual(readAllRetryKeys(bare, 'transcripts'), []);
      assert.equal(countRetries(bare, 'transcripts'), 0);
      recordRetries(bare, 'transcripts', ['1'], 'boom', Date.now()); // must not throw
      clearRetries(bare, 'transcripts', ['1']); // must not throw
    } finally {
      bare.close();
    }
  });
});

describe('watermark storage', () => {
  let db;
  beforeEach(() => { db = makeLocalDb(); });
  afterEach(() => { try { db.close(); } catch { /* noop */ } });

  test('a missing row reads as never-synced and round-trips', async () => {
    const before = readWatermark(db, 'transcripts');
    assert.deepEqual(before, { localMs: 0, cloudMs: 0, cloudSeq: 0, fullMs: 0, gcMs: 0 });
    assert.equal(isNeverSynced(before.cloudMs), true);
    assert.equal(isNeverSynced(before.cloudSeq), true);
    assert.equal(isNeverSynced(1), false);

    writeWatermark(db, 'transcripts', { localMs: 111, cloudMs: 222, cloudSeq: 333, fullMs: 444, gcMs: 555 });
    assert.deepEqual(readWatermark(db, 'transcripts'), { localMs: 111, cloudMs: 222, cloudSeq: 333, fullMs: 444, gcMs: 555 });

    writeWatermark(db, 'transcripts', { localMs: 999, cloudMs: 222, cloudSeq: 333, fullMs: 444, gcMs: 555 });
    assert.equal(readWatermark(db, 'transcripts').localMs, 999);
  });

  test('a database without sync_watermarks degrades to full-rescan instead of throwing', async () => {
    const bare = new Database(':memory:');
    try {
      assert.deepEqual(readWatermark(bare, 'transcripts'), { localMs: 0, cloudMs: 0, cloudSeq: 0, fullMs: 0, gcMs: 0 });
      writeWatermark(bare, 'transcripts', { localMs: 1, cloudMs: 1, cloudSeq: 1, fullMs: 1, gcMs: 1 }); // must not throw
    } finally {
      bare.close();
    }
  });

  test('a pre-v36 sync_watermarks (no cloud_seq column) still stores the other marks', async () => {
    const old = new Database(':memory:');
    try {
      old.exec(`CREATE TABLE sync_watermarks (
        table_name TEXT PRIMARY KEY, local_ms INTEGER NOT NULL DEFAULT 0,
        cloud_ms INTEGER NOT NULL DEFAULT 0, full_ms INTEGER NOT NULL DEFAULT 0,
        gc_ms INTEGER NOT NULL DEFAULT 0)`);
      writeWatermark(old, 'transcripts', { localMs: 7, cloudMs: 8, cloudSeq: 9, fullMs: 10, gcMs: 11 });
      const row = old.prepare("SELECT * FROM sync_watermarks WHERE table_name='transcripts'").get();
      assert.equal(row.local_ms, 7);
      assert.equal(row.cloud_ms, 8);
      assert.equal(row.full_ms, 10);
      assert.equal(row.gc_ms, 11);
      assert.equal(readWatermark(old, 'transcripts').cloudSeq, 0, 'the missing column reads as "no sequence watermark"');
    } finally {
      old.close();
    }
  });
});

// ---------------------------------------------------------------------------
// End-to-end incremental behaviour against the fake cloud
// ---------------------------------------------------------------------------

describe('incremental sync egress', () => {
  let db;
  let cloud;

  beforeEach(() => {
    // The `sync_seq` probe is cached per process, so every test that swaps in a
    // different fake project must forget the previous answer.
    __resetSeqProbe();
    db = makeLocalDb();
    seedInSync(db);
    cloud = makeFakeCloud(cloudSeedFromLocal(db));
  });
  afterEach(() => {
    try { db.close(); } catch { /* noop */ }
    __resetSeqProbe();
  });

  test('the first pass reads everything, and every pass after it reads almost nothing', async () => {
    const first = await runPass(db, cloud);
    assert.equal(first.totalTableErrors, 0, JSON.stringify(first.tables));
    assert.equal(first.tables.every((t) => t.incremental === false), true,
      'a table with no watermark must be read whole');
    const fullBytes = cloud.stats.bytesOut;
    const fullRows = cloud.stats.rowsRead;
    assert.ok(fullRows >= 4, `expected the whole table to be read, got ${fullRows} rows`);

    // Watermarks are now recorded, so the next pass can be filtered.
    assert.ok(readWatermark(db, 'transcripts').cloudMs > 0);
    assert.ok(readWatermark(db, 'transcripts').fullMs > 0);
    assert.ok(readWatermark(db, 'transcripts').cloudSeq > 0,
      'with migration 0005 present the exact sequence watermark must be recorded');

    const second = await runPass(db, cloud);
    assert.equal(second.totalTableErrors, 0, JSON.stringify(second.tables));
    assert.equal(
      second.tables.filter((t) => t.rows > 0).every((t) => t.incremental === true),
      true,
      'every table that has rows must be reconciled incrementally',
    );
    assert.equal(second.totalCandidates, 0, 'nothing changed, so nothing may be considered');
    assert.equal(cloud.stats.rowsRead, 0, 'a steady-state pass must download zero rows');
    assert.equal(cloud.stats.rowsWritten, 0, 'a steady-state pass must write nothing');

    // An EMPTY table has no sequence to learn, so it keeps reading unfiltered —
    // deliberately: keying on a timestamp instead would leave a row that arrives
    // from a lagging clock invisible until the 12h floor. The price is one
    // request returning an empty array, i.e. the same cost as the delta it
    // replaces, which the total-byte assertion below already covers.
    const empty = second.tables.filter((t) => t.rows === 0);
    assert.ok(empty.length > 0, 'precondition: the seed has an empty table (folders)');
    assert.ok(empty.every((t) => t.incremental === false));

    // The SUMMARY, however, must not be dragged to "full" by those free reads:
    // the flag exists to say "no real table is being re-scanned", and a schema
    // with any unused table would otherwise never show it.
    assert.equal(second.incremental, true,
      'a pass where no table WITH ROWS was read whole must report incremental');
    assert.ok(second.fullRescans > 0, 'the free empty-table reads are still counted, just not as a signal');

    // Sequence mode: the delta is filtered on sync_seq, NOT on any timestamp, so
    // the result cannot depend on whose clock stamped the rows.
    assert.ok(
      cloud.filtersFor('transcripts').some((f) => f.some((x) => x.t === 'gt' && x.c === 'sync_seq')),
      'the row delta must filter on sync_seq when the server assigns it',
    );
    assert.ok(
      cloud.filtersFor('sync_tombstones').some((f) => f.some((x) => x.t === 'gt' && x.c === 'sync_seq')),
      'the tombstone delta must filter on sync_seq',
    );
    assert.ok(
      !cloud.filtersFor('transcripts').some((f) => f.some((x) => x.t === 'gt' && x.c === 'updated_at')),
      'no clock-based predicate may remain once the sequence is available',
    );

    assert.ok(cloud.stats.bytesOut < fullBytes / 20,
      `steady-state egress must collapse: full=${fullBytes}B steady=${cloud.stats.bytesOut}B`);
  });

  test('one edited row uploads one row, not the table', async () => {
    await runPass(db, cloud); // establish watermarks

    db.prepare("UPDATE transcripts SET content = 'second segment, corrected' WHERE id = 2").run();

    const pass = await runPass(db, cloud);
    assert.equal(pass.totalPushed, 1, 'exactly the edited row is pushed');
    assert.equal(pass.tables.find((t) => t.table === 'transcripts').candidates, 1);
    assert.equal(cloud.get('transcripts', '2').content, 'second segment, corrected');
    assert.equal(cloud.get('transcripts', '1').content, 'first segment', 'untouched rows must not be re-uploaded');
    assert.ok(cloud.stats.bytesOut < 5_000, `only the delta should come down, got ${cloud.stats.bytesOut}B`);

    // And the pass is idempotent: a repeat moves nothing.
    const repeat = await runPass(db, cloud);
    assert.equal(repeat.totalPushed + repeat.totalPulled + repeat.totalDeleted, 0);
  });

  test('a large cloud tombstone ledger does not inflate the per-pass read', async () => {
    await runPass(db, cloud); // establish watermarks

    // The incident shape, on the CLOUD side this time: tens of thousands of old
    // deletion markers (live-meeting STT re-segmentation churn) that v34
    // re-downloaded in full on every single pass. This project's dev database
    // held 58,235 of them for `transcripts` alone — 3.27 MB per pass.
    const old = HOUR_AGO_ISO;
    const ledger = [];
    // Explicit OLD sequences: on the cloud these markers were written long ago,
    // which is exactly why the delta must not return them.
    for (let i = 1_000; i < 3_000; i++) {
      ledger.push({ user_id: USER, table_name: 'transcripts', row_id: String(i), deleted_at: old, sync_seq: 1 });
    }
    for (let i = 1; i < 501; i++) {
      ledger.push({ user_id: USER, table_name: 'chunks', row_id: String(i), deleted_at: old, sync_seq: 1 });
    }
    // One genuinely new marker, the only thing that should ever come down.
    ledger.push({
      user_id: USER, table_name: 'transcripts', row_id: '50',
      deleted_at: new Date().toISOString(), sync_seq: 10_000,
    });
    cloud.replace('sync_tombstones', ledger);

    const pass = await runPass(db, cloud);
    assert.equal(pass.totalTableErrors, 0, JSON.stringify(pass.tables));
    assert.equal(cloud.stats.byTable.sync_tombstones.rowsRead, 1,
      `only the new marker may be read, got ${cloud.stats.byTable.sync_tombstones.rowsRead} of ${ledger.length}`);
    assert.ok(cloud.stats.bytesOut < 2_000, `tombstone egress must collapse, got ${cloud.stats.bytesOut}B`);
  });

  test('the cloud tombstone delta still discovers a deletion made elsewhere', async () => {
    await runPass(db, cloud); // establish watermarks

    // Another device deleted transcript 2: cloud row gone, fresh marker present.
    cloud.replace('transcripts', cloud.rows('transcripts').filter((r) => String(r.id) !== '2'));
    cloud.put('sync_tombstones', {
      user_id: USER, table_name: 'transcripts', row_id: '2', deleted_at: new Date().toISOString(),
    });

    const pass = await runPass(db, cloud);
    assert.equal(pass.totalTableErrors, 0, JSON.stringify(pass.tables));
    const t = pass.tables.find((x) => x.table === 'transcripts');
    assert.equal(t.deletedLocal, 1, 'the remote deletion must still propagate under the watermark');
    assert.equal(db.prepare('SELECT COUNT(*) c FROM transcripts WHERE id = 2').get().c, 0);
    assert.equal(db.prepare('SELECT COUNT(*) c FROM transcripts').get().c, 2);
  });

  test('a local deletion propagates as a row delete plus its tombstone', async () => {
    await runPass(db, cloud); // establish watermarks

    const pass0 = await runPass(db, cloud);
    assert.equal(pass0.totalDeleted, 0);

    db.prepare('DELETE FROM transcripts WHERE id = 3').run();
    const pass = await runPass(db, cloud);
    const t = pass.tables.find((x) => x.table === 'transcripts');
    assert.equal(t.deletedCloud, 1);
    assert.equal(t.tombstonesPushed, 1);
    assert.equal(cloud.get('transcripts', '3'), undefined, 'the cloud row must be gone');
    assert.ok(cloud.get('sync_tombstones', `${USER}\u0000transcripts\u00003`), 'the cloud marker must exist');
  });

  test('a newer cloud edit wins locally (LWW preserved by the incremental path)', async () => {
    await runPass(db, cloud); // establish watermarks

    const newer = new Date().toISOString();
    cloud.put('transcripts', {
      ...cloud.rows('transcripts').find((r) => String(r.id) === '1'),
      content: 'cloud rewrote this',
      updated_at: newer,
    });

    const pass = await runPass(db, cloud);
    assert.equal(pass.totalPulled, 1);
    assert.equal(db.prepare('SELECT content FROM transcripts WHERE id = 1').get().content, 'cloud rewrote this');
    assert.equal(pass.totalPushed, 0, 'the losing local copy must not be pushed back');
  });

  test('the periodic floor reads the table whole even with fresh watermarks', async () => {
    runPass(db, cloud);
    assert.equal(cloud.stats.rowsRead, 0, 'precondition: the incremental path is quiet');

    // Age the full-rescan marker past the interval.
    db.prepare(
      'UPDATE sync_watermarks SET full_ms = 0, cloud_ms = ? WHERE table_name = ?'
    ).run(Date.now() - 999, 'transcripts');

    const pass = await runPass(db, cloud);
    const t = pass.tables.find((x) => x.table === 'transcripts');
    assert.equal(t.incremental, false, 'the periodic floor must fall back to a full read');
    assert.ok(cloud.stats.rowsRead >= 4);
  });

  test('fullRescan: true forces the unfiltered read on demand', async () => {
    await runPass(db, cloud);
    const pass = await runPass(db, cloud, { fullRescan: true });
    assert.equal(pass.tables.every((t) => t.incremental === false), true);
    assert.ok(cloud.stats.rowsRead >= 4);
  });

  test('a failed push advances the watermark and lands in the retry ledger instead', async () => {
    await runPass(db, cloud); // establish watermarks
    const localMsBefore = readWatermark(db, 'transcripts').localMs;

    db.prepare("UPDATE transcripts SET content = 'needs a retry' WHERE id = 2").run();

    // Reject EVERY upsert attempt for this table during the pass — the engine
    // falls back to one request per row when a batch fails, so a stub that only
    // failed the batch would be masked by the successful per-row retry.
    const realFrom = cloud.client.from.bind(cloud.client);
    const failing = { abortSignal: () => ({ then: (res) => res({ error: { message: 'simulated failure' } }) }) };
    let rejectUpserts = true;
    cloud.client.from = (table) => {
      const q = realFrom(table);
      if (table === 'transcripts') {
        const realUpsert = q.upsert.bind(q);
        q.upsert = (payload, opts) => (rejectUpserts ? failing : realUpsert(payload, opts));
      }
      return q;
    };

    const failed = await runPass(db, cloud);
    assert.equal(failed.totalFailed, 1, 'the failure must be reported');
    assert.equal(cloud.get('transcripts', '2').content, 'second segment', 'the cloud copy is still stale');

    // The whole point of the ledger: the watermark MOVED ON. v35 held the LOCAL
    // watermark at the failed row's stamp, which turned one unpushable row into a
    // permanent wide-scan per pass — straight back into the egress problem.
    const wmAfterFailure = readWatermark(db, 'transcripts');
    assert.ok(wmAfterFailure.localMs > localMsBefore, 'the watermark must not be held back by a failed row');
    const t = failed.tables.find((x) => x.table === 'transcripts');
    assert.equal(t.retrying, 1, 'the failed row must be tracked in the ledger');
    assert.deepEqual(readAllRetryKeys(db, 'transcripts'), ['2']);

    // And with nothing else changed, a pass a moment later — past the local
    // overlap window, so the row is no longer a candidate on its own merit —
    // reads nothing and does NOT re-push: the failed row costs a retry, not a
    // table scan per tick.
    rejectUpserts = false;
    cloud.client.from = realFrom;
    db.prepare('UPDATE sync_watermarks SET local_ms = ? WHERE table_name = ?').run(Date.now() + 1_000, 'transcripts');
    const tooSoon = await runPass(db, cloud);
    assert.equal(tooSoon.totalPushed, 0, 'the backoff must actually hold the retry back');
    assert.equal(cloud.stats.rowsRead, 0, 'a retry that is not due yet must not cause any read');

    // Once due, the row is re-offered and the stale ledger entry is cleared.
    db.prepare('UPDATE sync_retry SET next_attempt_ms = 0 WHERE table_name = ?').run('transcripts');
    const retried = await runPass(db, cloud);
    assert.equal(retried.totalPushed, 1, 'a row that failed to push must be retried once due');
    assert.equal(cloud.get('transcripts', '2').content, 'needs a retry');
    assert.equal(countRetries(db, 'transcripts'), 0, 'a successful retry must clear its ledger entry');
  });

  test('a retry entry for a row that no longer exists locally is dropped', async () => {
    await runPass(db, cloud);
    // Local deletion is the normal path — the tombstone covers it, so a ledger
    // entry for the vanished row would otherwise be re-offered for ever.
    db.prepare('DELETE FROM transcripts WHERE id = 3').run();
    recordRetries(db, 'transcripts', ['3'], 'stale', Date.now() - 60_000);
    const removed = await runPass(db, cloud);
    assert.equal(removed.totalTableErrors, 0, JSON.stringify(removed.tables));
    assert.equal(countRetries(db, 'transcripts'), 0, 'the ledger entry must be pruned');
  });
});

// ---------------------------------------------------------------------------
// Risk #1: a timestamp watermark cannot survive clock skew. Sequence watermarks
// (cloud migration 0005) can, and here is the proof plus the fallback.
// ---------------------------------------------------------------------------

describe('sequence watermarks (migration 0005)', () => {
  let db;
  let cloud;

  beforeEach(() => {
    __resetSeqProbe();
    db = makeLocalDb();
    seedInSync(db);
    cloud = makeFakeCloud(cloudSeedFromLocal(db));
  });
  afterEach(() => {
    try { db.close(); } catch { /* noop */ }
    __resetSeqProbe();
  });

  test('the probe reports whether the project has the column', async () => {
    assert.equal(await cloudHasSyncSeq(cloud.client), true);
    __resetSeqProbe();
    const legacy = makeFakeCloud({ sync_tombstones: [] }, { syncSeq: false });
    assert.equal(await cloudHasSyncSeq(legacy.client), false);
  });

  test('a row written by a lagging clock is DELAYED in timestamp mode and found in sequence mode', async () => {
    // Two identical worlds, differing only in whether 0005 is applied.
    const build = (opts) => {
      const d = makeLocalDb();
      seedInSync(d);
      return { db: d, cloud: makeFakeCloud(cloudSeedFromLocal(d), opts) };
    };

    // A writer whose clock runs 30 minutes behind stamps the row 30 minutes in
    // the past. It is still a genuine edit, and it is NEWER than the local copy
    // (an hour old) — so last-write-wins must apply it.
    const skewStamp = new Date(Date.now() - 30 * 60_000).toISOString();
    const applySkewedWrite = (c) => {
      const row = c.rows('transcripts').find((r) => String(r.id) === '1');
      c.put('transcripts', { ...row, content: 'written by a lagging clock', updated_at: skewStamp });
    };

    // --- timestamp mode (no 0005): the row falls BELOW the watermark ---------
    const legacy = build({ syncSeq: false });
    try {
      __resetSeqProbe(); // the probe is cached per process; this world has no 0005
      await runPass(legacy.db, legacy.cloud); // pass 1: full read, watermark set
      applySkewedWrite(legacy.cloud);
      const p = await runPass(legacy.db, legacy.cloud);
      assert.equal(p.totalPulled, 0, 'timestamp mode cannot see a lagging writer — this is the v35 limitation');
      assert.equal(
        legacy.db.prepare('SELECT content FROM transcripts WHERE id = 1').get().content,
        'first segment',
        'the skewed edit stays invisible until the 12h full rescan',
      );
    } finally {
      legacy.db.close();
    }

    // --- sequence mode (0005 applied): the delta is exact -------------------
    const modern = build();
    try {
      __resetSeqProbe(); // forget the legacy answer — this world HAS 0005
      await runPass(modern.db, modern.cloud);
      applySkewedWrite(modern.cloud);
      const p = await runPass(modern.db, modern.cloud);
      assert.equal(p.totalTableErrors, 0, JSON.stringify(p.tables));
      assert.equal(p.totalPulled, 1, 'the sequence delta must find the row whatever the clock said');
      assert.equal(
        modern.db.prepare('SELECT content FROM transcripts WHERE id = 1').get().content,
        'written by a lagging clock',
      );
    } finally {
      modern.db.close();
    }
  });

  test('without 0005 the engine still reconciles, on timestamp watermarks', async () => {
    const legacy = makeFakeCloud(cloudSeedFromLocal(db), { syncSeq: false });
    const first = await runPass(db, legacy);
    assert.equal(first.totalTableErrors, 0, JSON.stringify(first.tables));

    const steady = await runPass(db, legacy);
    assert.equal(steady.totalCandidates, 0);
    assert.equal(legacy.stats.rowsRead, 0, 'the timestamp path must also reach zero egress');
    assert.ok(
      legacy.filtersFor('transcripts').some((f) => f.some((x) => x.t === 'gt' && x.c === 'updated_at')),
      'the fallback must filter on updated_at',
    );
    assert.ok(
      !legacy.filtersFor('transcripts').some((f) => f.some((x) => x.t === 'gt' && x.c === 'sync_seq')),
      'it must not filter on a column the project does not have',
    );

    // Push and pull still work end to end on the fallback path.
    db.prepare("UPDATE transcripts SET content = 'edited offline' WHERE id = 3").run();
    const after = await runPass(db, legacy);
    assert.equal(after.totalPushed, 1);
    assert.equal(legacy.get('transcripts', '3').content, 'edited offline');
  });
});

// ---------------------------------------------------------------------------
// Risk #3: a pgvector column is ~15 KB per row on the wire. The back-fill only
// needs the key and the LWW stamp, so it must not drag the vector down — and a
// back-filled row that ends up being pulled must still arrive complete.
// ---------------------------------------------------------------------------

describe('slim back-fill for tables with a vector column', () => {
  let db;
  let cloud;

  beforeEach(() => {
    __resetSeqProbe();
    db = makeLocalDb();
    seedInSync(db);
    seedChunkInSync(db);
    cloud = makeFakeCloud(cloudSeedFromLocal(db));
  });
  afterEach(() => {
    try { db.close(); } catch { /* noop */ }
    __resetSeqProbe();
  });

  test('the back-fill omits the vector, and a pulled slim row is re-fetched complete', async () => {
    await runPass(db, cloud, { tables: ['chunks'] }); // establish watermarks

    // Make the cloud copy NEWER than the local one but keep its sequence OLD, so
    // it is deliberately NOT part of the cloud delta: the key then reaches the
    // planner only through the back-fill. Mark the key as a due retry so it is a
    // candidate even though the local stamp is old. That is exactly the shape
    // that exercises the slim back-fill, and it can be won by the cloud.
    const cloudChunk = cloud.rows('chunks').find((r) => String(r.id) === '1');
    cloud.replace('chunks', [{
      ...cloudChunk,
      cleaned_text: 'cloud rewrote this chunk',
      updated_at: new Date(Date.now() - 30 * 60_000).toISOString(),
      sync_seq: 1, // older than the watermark → invisible to the delta
    }]);
    recordRetries(db, 'chunks', ['1'], 'forced retry', Date.now() - 60_000);

    const pass = await runPass(db, cloud, { tables: ['chunks'] });
    assert.equal(pass.totalTableErrors, 0, JSON.stringify(pass.tables));
    const t = pass.tables.find((x) => x.table === 'chunks');
    assert.equal(t.pulled, 1, 'the cloud copy is newer, so it must be pulled');

    // The back-fill must have been slim (no embedding), and the refetch full.
    const cols = cloud.colsFor('chunks');
    assert.ok(
      cols.some((c) => c === 'id,updated_at'),
      `a back-fill must ask only for the key + stamp, saw: ${JSON.stringify(cols)}`,
    );
    assert.ok(
      cols.some((c) => String(c).includes('embedding')),
      'the row that was actually pulled must be re-fetched WITH its vector',
    );

    // The pull landed complete: text from the cloud AND the 1536-dim vector,
    // not a slim row written over the local copy as nulls.
    const local = db.prepare('SELECT cleaned_text, length(embedding) AS len FROM chunks WHERE id = 1').get();
    assert.equal(local.cleaned_text, 'cloud rewrote this chunk');
    assert.equal(local.len, VECTOR_DIMS * 4, 'the embedding column must survive the slim round-trip');
  });

  test('an untouched vector row is never re-downloaded, and a steady pass asks for nothing', async () => {
    const first = await runPass(db, cloud, { tables: ['chunks'] });
    assert.equal(first.totalTableErrors, 0, JSON.stringify(first.tables));
    const fullBytes = cloud.stats.bytesOut;
    assert.ok(fullBytes > 5_000, `a full read must actually carry the vector, got ${fullBytes}B`);

    const steady = await runPass(db, cloud, { tables: ['chunks'] });
    assert.equal(cloud.stats.rowsRead, 0);
    assert.equal(cloud.stats.rowsWritten, 0);
    assert.ok(cloud.stats.bytesOut < fullBytes / 50,
      `steady egress must collapse: full=${fullBytes}B steady=${cloud.stats.bytesOut}B`);
  });
});
