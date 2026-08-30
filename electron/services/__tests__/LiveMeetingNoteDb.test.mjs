// electron/services/__tests__/LiveMeetingNoteDb.test.mjs
//
// LIVE MEETING NOTE (v31): a `meetings` row is created at meeting Start with
// is_live=1 so the note exists immediately and survives a crash/quit
// mid-meeting. While the meeting runs, main.ts flushes the in-memory
// transcript + usage into that row (upsertLiveMeetingSnapshot); at Stop the
// same row is finalized (is_live → 0) and summary/usage are generated into it.
// Orphaned is_live rows (app quit before Stop) are adopted by
// adoptOrphanedLiveMeetings on the next launch and processed by the existing
// unprocessed-meeting recovery.
//
// This test drives an in-memory better-sqlite3 with the EXACT production
// schema slice and the EXACT transaction bodies of
// upsertLiveMeetingSnapshot / adoptOrphanedLiveMeetings (mirroring
// db/DatabaseManager.ts), plus source guards asserting the compiled
// DatabaseManager.js actually contains them.
//
// Run under the Electron ABI (better-sqlite3 is built for Electron):
//   ELECTRON_RUN_AS_NODE=1 ./node_modules/.bin/electron --test <file>
// i.e. `npm run test:services`.

import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Minimal slice of the production schema relevant to live meeting notes
// (db/DatabaseManager.ts migrations v1 + v17 summary_status + v31 is_live).
function makeSchema(db) {
  db.exec(`
    CREATE TABLE meetings (
      id TEXT PRIMARY KEY,
      title TEXT,
      start_time INTEGER,
      duration_ms INTEGER,
      summary_json TEXT,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP,
      calendar_event_id TEXT,
      source TEXT,
      is_processed INTEGER DEFAULT 1,
      summary_status TEXT DEFAULT 'completed',
      is_live INTEGER DEFAULT 0
    );
    CREATE TABLE transcripts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      meeting_id TEXT,
      speaker TEXT,
      content TEXT,
      timestamp_ms INTEGER
    );
    CREATE TABLE ai_interactions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      meeting_id TEXT,
      type TEXT,
      timestamp INTEGER,
      user_query TEXT,
      ai_response TEXT,
      metadata_json TEXT
    );
  `);
}

// Mirrors DatabaseManager.upsertLiveMeetingSnapshot's transaction body
// (db/DatabaseManager.ts) — the id-preserving child rewrite.
function upsertLiveMeetingSnapshot(db, meetingId, transcript, usage) {
  db.transaction(() => {
    rewriteChildren(
      db, meetingId,
      (transcript || []).map((segment) => ({ speaker: segment.speaker ?? null, text: segment.text ?? null, timestamp: segment.timestamp })),
      (usage || []).map((entry) => {
        let metadata = null;
        if (Array.isArray(entry.items)) {
          metadata = JSON.stringify(entry.items);
        } else if (entry.type === 'followup_questions' && Array.isArray(entry.answer)) {
          metadata = JSON.stringify(entry.answer);
        }
        const answerText = Array.isArray(entry.answer) ? null : (entry.answer || null);
        const queryText = entry.question || null;
        return { type: entry.type || 'chat', timestamp: entry.timestamp || Date.now(), userQuery: queryText, aiResponse: answerText, metadata };
      }),
    );
  })();
}

// Mirrors DatabaseManager.rewriteMeetingChildren (id-preserving diff upsert).
function rewriteChildren(db, meetingId, transcript, interactions) {
  const selT = db.prepare('SELECT id, timestamp_ms, speaker, content FROM transcripts WHERE meeting_id = ?');
  const updT = db.prepare('UPDATE transcripts SET speaker = ?, content = ? WHERE id = ?');
  const insT = db.prepare('INSERT INTO transcripts (meeting_id, speaker, content, timestamp_ms) VALUES (?, ?, ?, ?)');
  const delT = db.prepare('DELETE FROM transcripts WHERE id = ?');
  const selI = db.prepare('SELECT id, timestamp, type, user_query, ai_response, metadata_json FROM ai_interactions WHERE meeting_id = ?');
  const updI = db.prepare('UPDATE ai_interactions SET type = ?, user_query = ?, ai_response = ?, metadata_json = ? WHERE id = ?');
  const insI = db.prepare('INSERT INTO ai_interactions (meeting_id, type, timestamp, user_query, ai_response, metadata_json) VALUES (?, ?, ?, ?, ?, ?)');
  const delI = db.prepare('DELETE FROM ai_interactions WHERE id = ?');

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
}

// Mirrors DatabaseManager.adoptOrphanedLiveMeetings (db/DatabaseManager.ts).
function adoptOrphanedLiveMeetings(db, now) {
  return db.prepare(`
    UPDATE meetings
    SET is_live = 0,
        is_processed = 0,
        summary_status = 'queued',
        duration_ms = MAX(1, ? - start_time)
    WHERE is_live = 1
  `).run(now).changes ?? 0;
}

const liveRow = {
  id: 'live-meeting-1',
  title: 'Live meeting',
  startTime: 1_000_000,
  durationMs: 0,
};

function insertLiveRow(db, row = liveRow) {
  db.prepare(`
    INSERT INTO meetings (id, title, start_time, duration_ms, summary_json, is_processed, summary_status, is_live)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(row.id, row.title, row.startTime, row.durationMs, '{}', 0, 'queued', 1);
}

const segments = [
  { speaker: 'interviewer', text: 'Tell me about yourself.', timestamp: 1001 },
  { speaker: 'user', text: 'I am a software engineer.', timestamp: 2002 },
];
const usage = [
  { type: 'chat', timestamp: 1500, question: 'q1', answer: 'a1' },
];

describe('upsertLiveMeetingSnapshot (live note flush)', () => {
  let db;
  beforeEach(() => { db = new Database(':memory:'); makeSchema(db); insertLiveRow(db); });
  afterEach(() => { try { db.close(); } catch { /* noop */ } });

  test('inserts transcript + usage child rows under the live meeting id', () => {
    upsertLiveMeetingSnapshot(db, liveRow.id, segments, usage);
    assert.equal(db.prepare('SELECT COUNT(*) c FROM transcripts WHERE meeting_id = ?').get(liveRow.id).c, 2);
    assert.equal(db.prepare('SELECT COUNT(*) c FROM ai_interactions WHERE meeting_id = ?').get(liveRow.id).c, 1);
  });

  test('re-flushing with the same meeting id does NOT duplicate children (idempotent)', () => {
    upsertLiveMeetingSnapshot(db, liveRow.id, segments, usage);
    upsertLiveMeetingSnapshot(db, liveRow.id, segments, usage);
    assert.equal(db.prepare('SELECT COUNT(*) c FROM transcripts WHERE meeting_id = ?').get(liveRow.id).c, 2,
      'second flush must not double the transcript rows');
    assert.equal(db.prepare('SELECT COUNT(*) c FROM ai_interactions WHERE meeting_id = ?').get(liveRow.id).c, 1);
  });

  test('a flush with a SHRUNKEN transcript shrinks the child set (no stale rows)', () => {
    upsertLiveMeetingSnapshot(db, liveRow.id, segments, usage);
    upsertLiveMeetingSnapshot(db, liveRow.id, [segments[0]], []);
    assert.equal(db.prepare('SELECT COUNT(*) c FROM transcripts WHERE meeting_id = ?').get(liveRow.id).c, 1);
    assert.equal(db.prepare('SELECT COUNT(*) c FROM ai_interactions WHERE meeting_id = ?').get(liveRow.id).c, 0);
  });

  test('children for OTHER meetings are untouched', () => {
    insertLiveRow(db, { ...liveRow, id: 'live-meeting-2' });
    upsertLiveMeetingSnapshot(db, liveRow.id, segments, usage);
    upsertLiveMeetingSnapshot(db, 'live-meeting-2', [segments[0]], []);
    assert.equal(db.prepare('SELECT COUNT(*) c FROM transcripts WHERE meeting_id = ?').get(liveRow.id).c, 2);
  });

  test('followup_questions array answers are stored in metadata_json', () => {
    upsertLiveMeetingSnapshot(db, liveRow.id, [], [
      { type: 'followup_questions', timestamp: 3000, answer: ['q1', 'q2'] },
    ]);
    const row = db.prepare('SELECT ai_response, metadata_json FROM ai_interactions WHERE meeting_id = ?').get(liveRow.id);
    assert.equal(row.ai_response, null);
    assert.deepEqual(JSON.parse(row.metadata_json), ['q1', 'q2']);
  });
});

describe('adoptOrphanedLiveMeetings (crash/quit recovery)', () => {
  let db;
  beforeEach(() => { db = new Database(':memory:'); makeSchema(db); });
  afterEach(() => { try { db.close(); } catch { /* noop */ } });

  test('adopts live rows into normal unprocessed meetings with recomputed duration', () => {
    insertLiveRow(db, { id: 'orphan-1', title: 'Live meeting', startTime: 100_000, durationMs: 0 });
    insertLiveRow(db, { id: 'orphan-2', title: 'Live meeting', startTime: 200_000, durationMs: 0 });
    const now = 300_000;
    const adopted = adoptOrphanedLiveMeetings(db, now);
    assert.equal(adopted, 2);

    const o1 = db.prepare('SELECT is_live, is_processed, summary_status, duration_ms FROM meetings WHERE id = ?').get('orphan-1');
    assert.equal(o1.is_live, 0, 'is_live must be cleared so the row is a normal meeting');
    assert.equal(o1.is_processed, 0, 'must be picked up by getUnprocessedMeetings / recovery');
    assert.equal(o1.summary_status, 'queued', 'must flow through the queued summary pipeline');
    assert.equal(o1.duration_ms, 200_000, 'duration recomputed as now - start_time');

    const o2 = db.prepare('SELECT duration_ms FROM meetings WHERE id = ?').get('orphan-2');
    assert.equal(o2.duration_ms, 100_000);
  });

  test('is idempotent — a second call adopts nothing', () => {
    insertLiveRow(db);
    assert.equal(adoptOrphanedLiveMeetings(db, 5_000_000), 1);
    assert.equal(adoptOrphanedLiveMeetings(db, 6_000_000), 0);
    assert.equal(db.prepare('SELECT COUNT(*) c FROM meetings WHERE is_live = 1').get().c, 0);
  });

  test('duration is clamped to at least 1ms (never zero/negative)', () => {
    insertLiveRow(db, { id: 'orphan-3', title: 'Live meeting', startTime: 5_000_000, durationMs: 0 });
    adoptOrphanedLiveMeetings(db, 1);
    const row = db.prepare('SELECT duration_ms FROM meetings WHERE id = ?').get('orphan-3');
    assert.equal(row.duration_ms, 1);
  });
});

describe('live meeting note source guard (compiled DatabaseManager has the v31 surface)', () => {
  test('compiled DatabaseManager implements the live-note methods', () => {
    const compiled = path.resolve(__dirname, '../../../dist-electron/electron/db/DatabaseManager.js');
    assert.ok(fs.existsSync(compiled), `compiled DatabaseManager.js missing — run build:electron (${compiled})`);
    const src = fs.readFileSync(compiled, 'utf8');
    assert.match(src, /ALTER TABLE meetings ADD COLUMN is_live INTEGER DEFAULT 0/, 'migration v31 must add the is_live column');
    assert.match(src, /upsertLiveMeetingSnapshot/, 'must export the live flush method');
    assert.match(src, /adoptOrphanedLiveMeetings/, 'must export the orphan adoption method');
    assert.match(src, /getLiveMeetings/, 'must export the live-row query');
    assert.match(src, /rewriteMeetingChildren/, 'flush must use the id-preserving child rewrite (idempotency without id churn)');
    assert.doesNotMatch(src, /DELETE FROM transcripts WHERE meeting_id = \?/, 'must NOT bulk-delete transcripts by meeting_id (id churn → tombstone churn)');
  });

  test('the transient JIT scaffold row is excluded from history + recovery', () => {
    const compiled = path.resolve(__dirname, '../../../dist-electron/electron/db/DatabaseManager.js');
    const src = fs.readFileSync(compiled, 'utf8');
    assert.match(src, /live-meeting-current/,
      'must reference the excluded scaffold id constant');
    // History list: the JIT row must not show as a meeting (the live-note row
    // is the user-facing "Live" entry).
    assert.match(src, /WHERE id != \?[\s\S]*?ORDER BY created_at DESC/,
      'getRecentMeetings must exclude the JIT scaffold id');
    // Details: never render the scaffold as a meeting.
    assert.match(src, /id === ['"]live-meeting-current['"]|id === JIT_LIVE_MEETING_ID/,
      'getMeetingDetails must return null for the scaffold id');
    // Recovery: an orphaned scaffold (crash before meeting end) must not be
    // processed as a real chat session.
    assert.match(src, /WHERE is_processed = 0 AND id != \?/,
      'getUnprocessedMeetings must exclude the scaffold id');
  });
});
