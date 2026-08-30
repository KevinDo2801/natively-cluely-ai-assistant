// electron/db/__tests__/LiveFlushTombstoneChurn.test.mjs
//
// Regression pin for the 2026-08-30 "12 table errors" sync incident.
//
// Root cause: DatabaseManager.saveMeeting / upsertLiveMeetingSnapshot used a
// "DELETE all children by meeting_id, then re-INSERT with fresh autoincrement
// ids" idempotency pattern. With the v33 tombstone DELETE trigger, every such
// rewrite recorded a tombstone for every OLD id (the re-insert's new id never
// cleared it), so a live-meeting flush every LIVE_NOTE_FLUSH_MS accumulated one
// tombstone per segment per flush — ~250k over a long meeting — which the
// two-way sync loop could not push through.
//
// The fix rekeys child rows by their stable per-meeting timestamp, so unchanged
// segments keep their id (no delete, no tombstone), new segments insert, and only
// genuinely removed segments delete (and therefore record a tombstone).
//
// This test drives an in-memory better-sqlite3 with the v33 tombstone triggers
// and the id-preserving diff upsert, asserting that a re-flush produces NO
// tombstones while a real removal still produces exactly one.
//
// Run under the Electron ABI (better-sqlite3 is built for Electron):
//   ELECTRON_RUN_AS_NODE=1 ./node_modules/.bin/electron --test <file>

import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';

function makeSchema(db) {
  db.exec(`
    CREATE TABLE transcripts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      meeting_id TEXT,
      speaker TEXT,
      content TEXT,
      timestamp_ms INTEGER,
      updated_at TEXT
    );
    CREATE TABLE ai_interactions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      meeting_id TEXT,
      type TEXT,
      timestamp INTEGER,
      user_query TEXT,
      ai_response TEXT,
      metadata_json TEXT,
      updated_at TEXT
    );
    CREATE TABLE sync_tombstones (
      table_name TEXT NOT NULL,
      row_id TEXT NOT NULL,
      deleted_at TEXT NOT NULL DEFAULT '2026-08-30T00:00:00.000Z',
      PRIMARY KEY (table_name, row_id)
    );

    -- v33 DELETE trigger: record a deletion marker for every removed row.
    CREATE TRIGGER trg_transcripts_ad AFTER DELETE ON transcripts FOR EACH ROW
    BEGIN
      INSERT OR REPLACE INTO sync_tombstones (table_name, row_id, deleted_at)
      VALUES ('transcripts', CAST(OLD.id AS TEXT), '2026-08-30T00:00:00.000Z');
    END;
    CREATE TRIGGER trg_ai_interactions_ad AFTER DELETE ON ai_interactions FOR EACH ROW
    BEGIN
      INSERT OR REPLACE INTO sync_tombstones (table_name, row_id, deleted_at)
      VALUES ('ai_interactions', CAST(OLD.id AS TEXT), '2026-08-30T00:00:00.000Z');
    END;

    -- v33 INSERT trigger: a same-id re-insert (INSERT OR REPLACE) clears the marker.
    CREATE TRIGGER trg_transcripts_ai AFTER INSERT ON transcripts FOR EACH ROW
    BEGIN
      DELETE FROM sync_tombstones WHERE table_name = 'transcripts' AND row_id = CAST(NEW.id AS TEXT);
    END;
    CREATE TRIGGER trg_ai_interactions_ai AFTER INSERT ON ai_interactions FOR EACH ROW
    BEGIN
      DELETE FROM sync_tombstones WHERE table_name = 'ai_interactions' AND row_id = CAST(NEW.id AS TEXT);
    END;
  `);
}

// Id-preserving diff upsert (mirrors DatabaseManager.rewriteMeetingChildren).
function rewriteChildren(db, meetingId, transcript, interactions) {
  const selT = db.prepare('SELECT id, timestamp_ms, speaker, content FROM transcripts WHERE meeting_id = ?');
  const updT = db.prepare('UPDATE transcripts SET speaker = ?, content = ? WHERE id = ?');
  const insT = db.prepare('INSERT INTO transcripts (meeting_id, speaker, content, timestamp_ms) VALUES (?, ?, ?, ?)');
  const delT = db.prepare('DELETE FROM transcripts WHERE id = ?');
  const selI = db.prepare('SELECT id, timestamp, type, user_query, ai_response, metadata_json FROM ai_interactions WHERE meeting_id = ?');
  const updI = db.prepare('UPDATE ai_interactions SET type = ?, user_query = ?, ai_response = ?, metadata_json = ? WHERE id = ?');
  const insI = db.prepare('INSERT INTO ai_interactions (meeting_id, type, timestamp, user_query, ai_response, metadata_json) VALUES (?, ?, ?, ?, ?, ?)');
  const delI = db.prepare('DELETE FROM ai_interactions WHERE id = ?');

  db.transaction(() => {
    const tMap = new Map();
    for (const r of selT.all(meetingId)) tMap.set(r.timestamp_ms, { id: r.id, speaker: r.speaker, content: r.content });
    const seenT = new Set();
    for (const seg of transcript) {
      seenT.add(seg.timestamp);
      const ex = tMap.get(seg.timestamp);
      if (ex) {
        if (ex.speaker !== seg.speaker || ex.content !== seg.text) updT.run(seg.speaker, seg.text, ex.id);
      } else {
        insT.run(meetingId, seg.speaker, seg.text, seg.timestamp);
      }
    }
    for (const [ts, ex] of tMap) if (!seenT.has(ts)) delT.run(ex.id);

    const iMap = new Map();
    for (const r of selI.all(meetingId)) iMap.set(r.timestamp, { id: r.id, type: r.type, userQuery: r.user_query, aiResponse: r.ai_response, metadata: r.metadata_json });
    const seenI = new Set();
    for (const e of interactions) {
      seenI.add(e.timestamp);
      const ex = iMap.get(e.timestamp);
      if (ex) {
        if (ex.type !== e.type || ex.userQuery !== e.userQuery || ex.aiResponse !== e.aiResponse || ex.metadata !== e.metadata) updI.run(e.type, e.userQuery, e.aiResponse, e.metadata, ex.id);
      } else {
        insI.run(meetingId, e.type, e.timestamp, e.userQuery, e.aiResponse, e.metadata);
      }
    }
    for (const [ts, ex] of iMap) if (!seenI.has(ts)) delI.run(ex.id);
  })();
}

const segments = [
  { speaker: 'interviewer', text: 'Tell me about yourself.', timestamp: 1001 },
  { speaker: 'user', text: 'I am a software engineer.', timestamp: 2002 },
  { speaker: 'user', text: 'I worked on distributed systems.', timestamp: 3003 },
];
const interactions = [{ type: 'chat', timestamp: 1500, userQuery: 'q1', aiResponse: 'a1', metadata: null }];

describe('live flush tombstone churn (2026-08-30 regression)', () => {
  let db;
  beforeEach(() => { db = new Database(':memory:'); makeSchema(db); });
  afterEach(() => { try { db.close(); } catch { /* noop */ } });

  test('re-flushing the SAME snapshot does NOT create tombstones', () => {
    // Simulate a live meeting flushing the same growing transcript repeatedly.
    for (let i = 0; i < 5; i++) {
      rewriteChildren(db, 'meeting-1', segments, interactions);
    }
    const tomb = db.prepare('SELECT COUNT(*) c FROM sync_tombstones').get().c;
    assert.equal(tomb, 0, 'an id-preserving re-flush must record zero tombstones');

    // And the rows are stable (ids are NOT churned across flushes).
    const ids = db.prepare('SELECT id FROM transcripts WHERE meeting_id = ? ORDER BY id').all('meeting-1').map(r => r.id);
    assert.equal(ids.length, 3);
    assert.ok(ids[0] === 1 && ids[1] === 2 && ids[2] === 3, `ids must stay 1,2,3 across flushes, got ${ids.join(',')}`);
  });

  test('appending NEW segments inserts without tombstones and preserves prior ids', () => {
    rewriteChildren(db, 'meeting-1', segments.slice(0, 1), interactions);
    rewriteChildren(db, 'meeting-1', segments.slice(0, 2), interactions);
    rewriteChildren(db, 'meeting-1', segments, interactions);

    const ids = db.prepare('SELECT id FROM transcripts WHERE meeting_id = ? ORDER BY id').all('meeting-1').map(r => r.id);
    assert.deepEqual(ids, [1, 2, 3], 'appends must keep growing ids without deleting prior rows');
    assert.equal(db.prepare('SELECT COUNT(*) c FROM sync_tombstones').get().c, 0);
  });

  test('a genuinely REMOVED segment still records exactly one tombstone', () => {
    rewriteChildren(db, 'meeting-1', segments, interactions);
    // The middle segment disappears (e.g. STT re-segmentation).
    rewriteChildren(db, 'meeting-1', [segments[0], segments[2]], interactions);

    const tomb = db.prepare('SELECT table_name, row_id FROM sync_tombstones').all();
    assert.equal(tomb.length, 1, 'a real deletion must still propagate one tombstone');
    assert.equal(tomb[0].table_name, 'transcripts');
    assert.equal(tomb[0].row_id, '2', 'the removed segment id (2) must be tombstoned');
  });
});
