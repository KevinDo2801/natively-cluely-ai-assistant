// electron/rag/__tests__/ChunkReprocessTombstoneChurn.test.mjs
//
// Regression pin for the chunks half of the 2026-08-30 sync incident.
//
// VectorStore.deleteChunksForMeeting used to DELETE all chunk rows for a meeting
// and saveChunks re-INSERTed them with fresh autoincrement ids. With the v33
// tombstone DELETE trigger, every reprocess recorded a tombstone per chunk (id
// churn). The fix keys chunks by (meeting_id, chunk_index): saveChunks reuses the
// existing id for a matching chunk_index, deleteChunksForMeeting(keepRows: true)
// only resets embeddings, and saveSummary uses ON CONFLICT DO UPDATE (meeting_id
// is UNIQUE) instead of INSERT OR REPLACE.
//
// Mirrors VectorStore.saveChunks / deleteChunksForMeeting / saveSummary.
// Run under the Electron ABI: ELECTRON_RUN_AS_NODE=1 electron --test <file>

import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';

function makeSchema(db) {
  db.exec(`
    CREATE TABLE chunks (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      meeting_id TEXT NOT NULL,
      chunk_index INTEGER NOT NULL,
      speaker TEXT,
      start_timestamp_ms INTEGER,
      end_timestamp_ms INTEGER,
      cleaned_text TEXT NOT NULL,
      token_count INTEGER NOT NULL,
      embedding BLOB,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT
    );
    CREATE TABLE chunk_summaries (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      meeting_id TEXT NOT NULL UNIQUE,
      summary_text TEXT NOT NULL,
      embedding BLOB,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT
    );
    CREATE TABLE sync_tombstones (
      table_name TEXT NOT NULL,
      row_id TEXT NOT NULL,
      deleted_at TEXT NOT NULL DEFAULT '2026-08-30T00:00:00.000Z',
      PRIMARY KEY (table_name, row_id)
    );
    CREATE TRIGGER trg_chunks_ad AFTER DELETE ON chunks FOR EACH ROW
    BEGIN INSERT OR REPLACE INTO sync_tombstones (table_name, row_id, deleted_at) VALUES ('chunks', CAST(OLD.id AS TEXT), '2026-08-30T00:00:00.000Z'); END;
    CREATE TRIGGER trg_chunks_ai AFTER INSERT ON chunks FOR EACH ROW
    BEGIN DELETE FROM sync_tombstones WHERE table_name = 'chunks' AND row_id = CAST(NEW.id AS TEXT); END;
    CREATE TRIGGER trg_chunk_summaries_ad AFTER DELETE ON chunk_summaries FOR EACH ROW
    BEGIN INSERT OR REPLACE INTO sync_tombstones (table_name, row_id, deleted_at) VALUES ('chunk_summaries', CAST(OLD.id AS TEXT), '2026-08-30T00:00:00.000Z'); END;
    CREATE TRIGGER trg_chunk_summaries_ai AFTER INSERT ON chunk_summaries FOR EACH ROW
    BEGIN DELETE FROM sync_tombstones WHERE table_name = 'chunk_summaries' AND row_id = CAST(NEW.id AS TEXT); END;
  `);
}

// Mirrors VectorStore.saveChunks (id-preserving diff upsert).
function saveChunks(db, chunks) {
  const select = db.prepare('SELECT id, chunk_index FROM chunks WHERE meeting_id = ?');
  const update = db.prepare('UPDATE chunks SET speaker = ?, start_timestamp_ms = ?, end_timestamp_ms = ?, cleaned_text = ?, token_count = ? WHERE id = ?');
  const insert = db.prepare('INSERT INTO chunks (meeting_id, chunk_index, speaker, start_timestamp_ms, end_timestamp_ms, cleaned_text, token_count) VALUES (?, ?, ?, ?, ?, ?, ?)');
  const deleteStale = db.prepare('DELETE FROM chunks WHERE id = ?');
  const ids = [];
  db.transaction(() => {
    const byMeeting = new Map();
    for (const c of chunks) {
      const l = byMeeting.get(c.meetingId) || [];
      l.push(c);
      byMeeting.set(c.meetingId, l);
    }
    for (const [meetingId, list] of byMeeting) {
      const idByIndex = new Map();
      for (const r of select.all(meetingId)) idByIndex.set(r.chunk_index, r.id);
      const seen = new Set();
      for (const c of list) {
        seen.add(c.chunkIndex);
        const existingId = idByIndex.get(c.chunkIndex);
        if (existingId !== undefined) {
          update.run(c.speaker, c.startMs, c.endMs, c.text, c.tokenCount, existingId);
          ids.push(existingId);
        } else {
          ids.push(insert.run(c.meetingId, c.chunkIndex, c.speaker, c.startMs, c.endMs, c.text, c.tokenCount).lastInsertRowid);
        }
      }
      for (const [index, id] of idByIndex) if (!seen.has(index)) deleteStale.run(id);
    }
  })();
  return ids;
}

// Mirrors VectorStore.deleteChunksForMeeting (keepRows resets embeddings only).
function deleteChunksForMeeting(db, meetingId, keepRows) {
  if (keepRows) db.prepare('UPDATE chunks SET embedding = NULL WHERE meeting_id = ?').run(meetingId);
  else db.prepare('DELETE FROM chunks WHERE meeting_id = ?').run(meetingId);
}

// Mirrors VectorStore.saveSummary (ON CONFLICT DO UPDATE).
function saveSummary(db, meetingId, summaryText) {
  db.prepare(`
    INSERT INTO chunk_summaries (meeting_id, summary_text) VALUES (?, ?)
    ON CONFLICT(meeting_id) DO UPDATE SET summary_text = excluded.summary_text, embedding = NULL
  `).run(meetingId, summaryText);
}

const mk = (meetingId, i, text = `chunk ${i}`) => ({
  meetingId, chunkIndex: i, speaker: 'speaker', startMs: i * 1000, endMs: i * 1000 + 999, text, tokenCount: 10,
});

describe('chunk reprocess tombstone churn (2026-08-30 regression)', () => {
  let db;
  beforeEach(() => { db = new Database(':memory:'); makeSchema(db); });
  afterEach(() => { try { db.close(); } catch { /* noop */ } });

  test('saveChunks reuses ids across re-saves (no id churn, no tombstones)', () => {
    const chunks = [mk('m1', 0), mk('m1', 1), mk('m1', 2)];
    const first = saveChunks(db, chunks);
    const second = saveChunks(db, chunks);
    assert.deepEqual(second, first, 're-saving identical chunks must reuse the same ids');
    assert.equal(db.prepare('SELECT COUNT(*) c FROM sync_tombstones').get().c, 0, 'no tombstones from id-preserving re-save');
  });

  test('reprocess (keepRows reset + saveChunks) creates no tombstones and keeps ids', () => {
    const chunks = [mk('m1', 0), mk('m1', 1), mk('m1', 2)];
    const first = saveChunks(db, chunks);
    db.prepare('UPDATE chunks SET embedding = x\'00\' WHERE meeting_id = \'m1\'').run();
    deleteChunksForMeeting(db, 'm1', true); // keepRows: reset embeddings only
    const second = saveChunks(db, chunks);
    assert.deepEqual(second, first, 'reprocess must reuse chunk ids');
    assert.equal(db.prepare('SELECT COUNT(*) c FROM sync_tombstones').get().c, 0, 'no tombstones from keepRows reprocess');
    assert.equal(db.prepare('SELECT COUNT(*) c FROM chunks WHERE embedding IS NULL').get().c, 3, 'embeddings reset for re-embed');
  });

  test('a real purge (keepRows=false) still tombstones every removed chunk', () => {
    saveChunks(db, [mk('m1', 0), mk('m1', 1), mk('m1', 2)]);
    deleteChunksForMeeting(db, 'm1', false);
    assert.equal(db.prepare('SELECT COUNT(*) c FROM sync_tombstones WHERE table_name = \'chunks\'').get().c, 3, 'purge must propagate 3 tombstones');
  });

  test('saveSummary preserves the chunk_summaries id across re-saves', () => {
    saveSummary(db, 'm1', 'first');
    const id1 = db.prepare('SELECT id FROM chunk_summaries WHERE meeting_id = \'m1\'').get().id;
    saveSummary(db, 'm1', 'updated');
    const id2 = db.prepare('SELECT id FROM chunk_summaries WHERE meeting_id = \'m1\'').get().id;
    assert.equal(id2, id1, 'summary re-save must preserve the id (no INSERT OR REPLACE churn)');
    assert.equal(db.prepare('SELECT summary_text FROM chunk_summaries WHERE meeting_id = \'m1\'').get().summary_text, 'updated');
    assert.equal(db.prepare('SELECT COUNT(*) c FROM sync_tombstones WHERE table_name = \'chunk_summaries\'').get().c, 0, 'no tombstones from summary re-save');
  });
});
