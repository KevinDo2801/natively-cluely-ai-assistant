// Unit tests for the two-way sync conflict planner (pure logic, no I/O).
// Runs under `npm test` (electron --test, repo better-sqlite3 ABI).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const {
  planTableSync,
  expandTables,
  toMs,
  toIso,
  blobToVector,
  vectorStringToBlob,
} = require('../supabaseSyncEngine.js');

const DEF = { table: 'things', pk: 'id', pkType: 'text', columns: ['id', 'name'] };

const mkLocal = (key, updatedMs) => ({ id: key, name: `local-${key}`, _pk: 'id', _key: key, updatedMs });
const mkCloud = (key, updatedMs) => ({ id: key, name: `cloud-${key}`, _pk: 'id', _key: key, updatedMs });

function plan({ local = [], lt = {}, cloud = [], ct = {} }) {
  const localTombs = new Map(Object.entries(lt));
  const cloudTombs = new Map(Object.entries(ct));
  return planTableSync({ def: DEF, localRows: local, localTombs, cloudRows: cloud, cloudTombs });
}

test('local-only row is pushed', () => {
  const a = plan({ local: [mkLocal('x', 100)] });
  assert.equal(a.pushRows.length, 1);
  assert.equal(a.pushRows[0]._key, 'x');
  assert.equal(a.pullRows.length, 0);
});

test('cloud-only row is pulled', () => {
  const a = plan({ cloud: [mkCloud('x', 100)] });
  assert.equal(a.pullRows.length, 1);
  assert.equal(a.pullRows[0]._key, 'x');
  assert.equal(a.pushRows.length, 0);
});

test('both sides, local newer wins (push)', () => {
  const a = plan({ local: [mkLocal('x', 200)], cloud: [mkCloud('x', 100)] });
  assert.equal(a.pushRows.length, 1);
  assert.equal(a.pullRows.length, 0);
});

test('both sides, cloud newer wins (pull)', () => {
  const a = plan({ local: [mkLocal('x', 100)], cloud: [mkCloud('x', 200)] });
  assert.equal(a.pullRows.length, 1);
  assert.equal(a.pushRows.length, 0);
});

test('tie leaves both sides untouched (no ping-pong)', () => {
  const a = plan({ local: [mkLocal('x', 150)], cloud: [mkCloud('x', 150)] });
  assert.equal(a.pushRows.length + a.pullRows.length, 0);
});

test('local deletion newer than cloud edit deletes cloud row', () => {
  const a = plan({ lt: { x: 300 }, cloud: [mkCloud('x', 200)] });
  assert.equal(a.pushDeletes.length, 1);
  assert.equal(a.pushDeletes[0].key, 'x');
  assert.equal(a.tombPush.length, 1);
});

test('cloud deletion newer than local edit deletes local row', () => {
  const a = plan({ local: [mkLocal('x', 200)], ct: { x: 300 } });
  assert.equal(a.pullDeletes.length, 1);
  assert.equal(a.pullDeletes[0].key, 'x');
  assert.equal(a.tombPull.length, 1);
});

test('deletion must be STRICTLY newer: equal timestamps keep the row alive', () => {
  // Cloud tombstone at the same ms as the live local edit does NOT win:
  // the row survives and is revived on cloud (stale marker cleared).
  const a = plan({ local: [mkLocal('x', 250)], ct: { x: 250 } });
  assert.equal(a.pullDeletes.length, 0);
  assert.equal(a.pushRows.length, 1);
  assert.equal(a.tombCloudClear.length, 1);

  // Symmetric: local tombstone at the same ms as the live cloud edit does
  // not win either — the cloud row is pulled back locally.
  const b = plan({ lt: { x: 250 }, cloud: [mkCloud('x', 250)] });
  assert.equal(b.pushDeletes.length, 0);
  assert.equal(b.pullRows.length, 1);
});

test('a live local row with a newer local tombstone is deleted on cloud', () => {
  // Row still physically present locally, but the DELETE trigger marker is newer.
  const a = plan({ local: [mkLocal('x', 100)], lt: { x: 400 }, cloud: [mkCloud('x', 300)] });
  assert.equal(a.pushDeletes.length, 1);
  assert.equal(a.tombPush.length, 1);
});

test('cloud tombstone only (no local state) propagates to local', () => {
  const a = plan({ ct: { x: 500 } });
  assert.equal(a.tombPull.length, 1);
  assert.equal(a.tombPull[0].deletedAtMs, 500);
});

test('local tombstone only (no cloud state) propagates to cloud', () => {
  const a = plan({ lt: { x: 500 } });
  assert.equal(a.tombPush.length, 1);
  assert.equal(a.tombPush[0].deletedAtMs, 500);
});

test('both tombstoned: the newer marker wins', () => {
  const a = plan({ lt: { x: 400 }, ct: { x: 500 } });
  assert.equal(a.tombPull.length, 1);
  assert.equal(a.tombPush.length, 0);
  const b = plan({ lt: { x: 600 }, ct: { x: 500 } });
  assert.equal(b.tombPush.length, 1);
  assert.equal(b.tombPull.length, 0);
});

test('local edit newer than cloud tombstone revives the row on cloud', () => {
  const a = plan({ local: [mkLocal('x', 700)], ct: { x: 500 } });
  assert.equal(a.pushRows.length, 1);
  assert.equal(a.tombCloudClear.length, 1);
  assert.equal(a.tombCloudClear[0], 'x');
});

test('cloud edit newer than local tombstone revives the row locally', () => {
  const a = plan({ lt: { x: 500 }, cloud: [mkCloud('x', 700)] });
  assert.equal(a.pullRows.length, 1);
  assert.equal(a.pullDeletes.length, 0);
});

test('toMs parses SQLite UTC, ISO with offset, and milliseconds', () => {
  assert.equal(toMs('2026-08-29 03:10:31'), Date.UTC(2026, 7, 29, 3, 10, 31));
  assert.equal(toMs('2026-08-29T03:10:31.628Z'), Date.UTC(2026, 7, 29, 3, 10, 31, 628));
  assert.equal(toMs('2026-08-29T05:10:31+02:00'), Date.UTC(2026, 7, 29, 3, 10, 31));
  assert.equal(toMs('2026-08-29T03:10:31.500'), Date.UTC(2026, 7, 29, 3, 10, 31, 500));
  assert.equal(toMs(null), 0);
  assert.equal(toMs(''), 0);
  assert.equal(toMs(1234), 1234);
});

test('toIso round-trips through toMs', () => {
  const ms = Date.UTC(2026, 7, 29, 3, 10, 31, 628);
  assert.equal(toMs(toIso(ms)), ms);
});

test('vector BLOB ↔ pgvector string round-trip', () => {
  const buf = Buffer.alloc(4 * 4);
  buf.writeFloatLE(1.5, 0);
  buf.writeFloatLE(-2.25, 4);
  buf.writeFloatLE(0, 8);
  buf.writeFloatLE(3.75, 12);
  const { embedding, embeddingDims } = blobToVector(buf);
  assert.equal(embeddingDims, 4);
  const asString = `[${embedding.join(',')}]`;
  const back = vectorStringToBlob(asString);
  assert.ok(back);
  assert.deepEqual(back, buf);
  assert.equal(vectorStringToBlob(null), null);
  assert.equal(vectorStringToBlob('[not,a,vector]'), null);
});

// ── Cloud-first helpers ─────────────────────────────────────────────────────

test('expandTables adds FK ancestors transitively', () => {
  // Child → parent → grandparent.
  const got = expandTables(['transcripts']);
  assert.ok(got.has('transcripts'));
  assert.ok(got.has('meetings'));
  assert.ok(got.has('folders'));
  // Grandchild → child → parents (knowledge_card_versions → cards → packs → sources).
  const deep = expandTables(['knowledge_card_versions']);
  assert.ok(deep.has('knowledge_card_versions'));
  assert.ok(deep.has('knowledge_cards'));
  assert.ok(deep.has('knowledge_packs'));
  assert.ok(deep.has('knowledge_sources'));
  assert.ok(deep.has('modes'));
  // No expansion for parents themselves beyond their own ancestors.
  const meeting = expandTables(['meetings']);
  assert.ok(meeting.has('folders'));
  assert.ok(!meeting.has('transcripts'));
});

test('expandTables is idempotent and handles unknown tables', () => {
  const once = expandTables(['chunks', 'ai_interactions']);
  assert.deepEqual([...expandTables([...once])].sort(), [...once].sort());
  const unknown = expandTables(['not_a_table']);
  assert.deepEqual([...unknown], ['not_a_table']);
  assert.deepEqual([...expandTables([])], []);
});
