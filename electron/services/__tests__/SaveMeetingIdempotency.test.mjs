// electron/services/__tests__/SaveMeetingIdempotency.test.mjs
//
// HIGH (audit finding #1) — DatabaseManager.saveMeeting must be IDEMPOTENT for a
// given meeting id. The real flow saves a meeting TWICE under the same id:
//   1. MeetingPersistence.stopMeeting() writes a placeholder snapshot,
//   2. MeetingPersistence.processAndSaveMeeting() writes the final record.
// The meetings row uses INSERT OR REPLACE, but transcripts / ai_interactions are
// append-only with autoincrement ids, so without a DELETE-before-insert the second
// save DOUBLED every child row. Recovery / RAG reprocessing then read duplicated
// transcripts.
//
// This test drives an in-memory better-sqlite3 with the EXACT production schema and
// the EXACT saveMeeting transaction body (mirroring DatabaseManager.saveMeeting,
// including the DELETE-first idempotency fix). A second test guards against
// regression by asserting the compiled DatabaseManager.js actually clears children
// before inserting them.
//
// Run under the Electron ABI (better-sqlite3 is built for Electron):
//   ELECTRON_RUN_AS_NODE=1 ./node_modules/.bin/electron --test <file>
// i.e. `npm run test:electron` (or test:services under the same ABI).

import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Minimal slice of the production schema relevant to saveMeeting (DatabaseManager
// runMigrations v1). Mirrors db/DatabaseManager.ts:191-222.
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

// Mirrors DatabaseManager.saveMeeting's transaction body, INCLUDING the
// id-preserving child rewrite (rewriteMeetingChildren, db/DatabaseManager.ts)
// that replaced the old DELETE-all + re-insert approach (which churned
// autoincrement ids and, with the v33 tombstone trigger, generated ~250k
// tombstones during a long live meeting).
function saveMeeting(db, meeting, startTimeMs, durationMs) {
  const insertMeeting = db.prepare(`
    INSERT OR REPLACE INTO meetings (id, title, start_time, duration_ms, summary_json, created_at, calendar_event_id, source, is_processed, summary_status, is_live)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const summaryJson = JSON.stringify({ legacySummary: meeting.summary, detailedSummary: meeting.detailedSummary });

  const tx = db.transaction(() => {
    insertMeeting.run(
      meeting.id, meeting.title, startTimeMs, durationMs, summaryJson,
      meeting.date, meeting.calendarEventId || null, meeting.source || 'manual',
      meeting.isProcessed ? 1 : 0,
      meeting.summaryStatus || (meeting.isProcessed ? 'completed' : 'queued'),
      meeting.isLive ? 1 : 0,
    );
    rewriteChildren(
      db, meeting.id,
      (meeting.transcript || []).map((seg) => ({ speaker: seg.speaker ?? null, text: seg.text ?? null, timestamp: seg.timestamp })),
      (meeting.usage || []).map((u) => ({
        type: u.type,
        timestamp: u.timestamp,
        userQuery: u.question || null,
        aiResponse: Array.isArray(u.answer) ? null : (u.answer || null),
        metadata: u.items ? JSON.stringify(u.items) : null,
      })),
    );
  });
  tx();
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

const placeholder = {
  id: 'meeting-A',
  title: 'Processing...',
  date: '2026-06-16T00:00:00.000Z',
  summary: '',
  transcript: [
    { speaker: 'interviewer', text: 'Tell me about yourself.', timestamp: 1000 },
    { speaker: 'user', text: 'I am a software engineer.', timestamp: 2000 },
  ],
  usage: [
    { type: 'chat', timestamp: 1500, question: 'q1', answer: 'a1' },
  ],
  isProcessed: false,
};

const finalRecord = {
  ...placeholder,
  title: 'Intro chat',
  summary: 'A short intro.',
  isProcessed: true,
};

describe('saveMeeting idempotency (audit finding #1)', () => {
  let db;
  beforeEach(() => { db = new Database(':memory:'); makeSchema(db); });
  afterEach(() => { try { db.close(); } catch { /* noop */ } });

  test('saving the same meeting twice does NOT duplicate transcript rows', () => {
    saveMeeting(db, placeholder, placeholder.transcript[0].timestamp, 5000); // placeholder save
    saveMeeting(db, finalRecord, finalRecord.transcript[0].timestamp, 5000); // final save (same id)

    const tCount = db.prepare('SELECT COUNT(*) c FROM transcripts WHERE meeting_id = ?').get('meeting-A').c;
    assert.equal(tCount, 2, 'should hold exactly the 2 transcript segments, not 4');

    const iCount = db.prepare('SELECT COUNT(*) c FROM ai_interactions WHERE meeting_id = ?').get('meeting-A').c;
    assert.equal(iCount, 1, 'should hold exactly the 1 interaction, not 2');

    const mCount = db.prepare('SELECT COUNT(*) c FROM meetings WHERE id = ?').get('meeting-A').c;
    assert.equal(mCount, 1, 'INSERT OR REPLACE keeps exactly one meeting row');

    // The final record's metadata wins (INSERT OR REPLACE).
    const row = db.prepare('SELECT title, is_processed FROM meetings WHERE id = ?').get('meeting-A');
    assert.equal(row.title, 'Intro chat');
    assert.equal(row.is_processed, 1);
  });

  test('re-saving with fewer children shrinks the child set (no stale rows)', () => {
    saveMeeting(db, placeholder, 1000, 5000);
    const trimmed = { ...finalRecord, transcript: [placeholder.transcript[0]], usage: [] };
    saveMeeting(db, trimmed, 1000, 5000);

    assert.equal(db.prepare('SELECT COUNT(*) c FROM transcripts WHERE meeting_id = ?').get('meeting-A').c, 1);
    assert.equal(db.prepare('SELECT COUNT(*) c FROM ai_interactions WHERE meeting_id = ?').get('meeting-A').c, 0);
  });

  test('children for OTHER meetings are untouched by a re-save', () => {
    saveMeeting(db, { ...placeholder, id: 'meeting-B' }, 1000, 5000);
    saveMeeting(db, placeholder, 1000, 5000);
    saveMeeting(db, finalRecord, 1000, 5000); // re-save A only

    assert.equal(db.prepare('SELECT COUNT(*) c FROM transcripts WHERE meeting_id = ?').get('meeting-B').c, 2,
      'meeting B child rows must be untouched by re-saving meeting A');
  });

  test('live → final transition keeps the id and clears the is_live flag (v31)', () => {
    // The live note row was created at Start with is_live=1; the Stop-side
    // placeholder + final saves reuse the SAME id, so the row is finalized in
    // place and must stop being "live" while children stay exactly-once.
    saveMeeting(db, { ...placeholder, isLive: true }, 1000, 0); // created at Start
    saveMeeting(db, placeholder, 1000, 5000); // placeholder at Stop (same id, isLive falsy)
    saveMeeting(db, finalRecord, 1000, 5000); // final at Stop (same id)

    const row = db.prepare('SELECT title, is_processed, is_live FROM meetings WHERE id = ?').get('meeting-A');
    assert.equal(row.is_live, 0, 'final save must clear the live flag');
    assert.equal(row.is_processed, 1);
    assert.equal(row.title, 'Intro chat');
    assert.equal(db.prepare('SELECT COUNT(*) c FROM transcripts WHERE meeting_id = ?').get('meeting-A').c, 2,
      'children must not be duplicated across live → placeholder → final saves');
  });
});

describe('saveMeeting source guard (compiled code uses the id-preserving child rewrite)', () => {
  test('compiled DatabaseManager rewrites children without churning ids/tombstones', () => {
    const compiled = path.resolve(__dirname, '../../../dist-electron/electron/db/DatabaseManager.js');
    assert.ok(fs.existsSync(compiled), `compiled DatabaseManager.js missing — run build:electron (${compiled})`);
    const src = fs.readFileSync(compiled, 'utf8');
    assert.match(src, /rewriteMeetingChildren/, 'must use the id-preserving child rewrite');
    assert.match(src, /DELETE FROM transcripts WHERE id = \?/, 'must delete stale transcripts by id (not meeting_id)');
    assert.doesNotMatch(src, /DELETE FROM transcripts WHERE meeting_id = \?/, 'must NOT bulk-delete transcripts by meeting_id (id churn → tombstone churn)');
    assert.doesNotMatch(src, /DELETE FROM ai_interactions WHERE meeting_id = \?/, 'must NOT bulk-delete interactions by meeting_id');
  });
});
