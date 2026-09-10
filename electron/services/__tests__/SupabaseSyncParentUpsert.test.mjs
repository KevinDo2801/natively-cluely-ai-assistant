// Regression for the 2026-09-09 meeting-data loss incident.
// A pulled meeting update must not replace the SQLite parent row because
// ON DELETE CASCADE would erase transcripts, AI usage, and RAG chunks.

import { afterEach, beforeEach, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import Database from 'better-sqlite3';

const require = createRequire(import.meta.url);
const { TABLE_DEFS, applyToLocal } = require('../supabaseSyncEngine.js');
const MEETINGS_DEF = TABLE_DEFS.find((def) => def.table === 'meetings');

function makeSchema(db) {
  db.pragma('foreign_keys = ON');
  db.exec(`
    CREATE TABLE meetings (
      id TEXT PRIMARY KEY,
      title TEXT,
      start_time INTEGER,
      duration_ms INTEGER,
      summary_json TEXT,
      created_at TEXT,
      calendar_event_id TEXT,
      source TEXT,
      is_processed INTEGER,
      summary_status TEXT,
      embedding_provider TEXT,
      embedding_dimensions INTEGER,
      embedding_space TEXT,
      user_titled INTEGER,
      is_live INTEGER,
      folder_id TEXT,
      updated_at TEXT
    );
    CREATE TABLE transcripts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      meeting_id TEXT NOT NULL REFERENCES meetings(id) ON DELETE CASCADE,
      content TEXT
    );
    CREATE TABLE ai_interactions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      meeting_id TEXT NOT NULL REFERENCES meetings(id) ON DELETE CASCADE,
      ai_response TEXT
    );
    CREATE TABLE chunks (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      meeting_id TEXT NOT NULL REFERENCES meetings(id) ON DELETE CASCADE,
      cleaned_text TEXT
    );
    CREATE TABLE sync_tombstones (
      table_name TEXT NOT NULL,
      row_id TEXT NOT NULL,
      deleted_at TEXT NOT NULL,
      PRIMARY KEY (table_name, row_id)
    );
    CREATE TRIGGER transcript_deleted AFTER DELETE ON transcripts BEGIN
      INSERT OR REPLACE INTO sync_tombstones VALUES ('transcripts', CAST(OLD.id AS TEXT), '2026-09-10T00:00:00.000Z');
    END;
    CREATE TRIGGER interaction_deleted AFTER DELETE ON ai_interactions BEGIN
      INSERT OR REPLACE INTO sync_tombstones VALUES ('ai_interactions', CAST(OLD.id AS TEXT), '2026-09-10T00:00:00.000Z');
    END;
    CREATE TRIGGER chunk_deleted AFTER DELETE ON chunks BEGIN
      INSERT OR REPLACE INTO sync_tombstones VALUES ('chunks', CAST(OLD.id AS TEXT), '2026-09-10T00:00:00.000Z');
    END;
  `);
}

describe('Supabase meeting pull preserves local child data', () => {
  let db;

  beforeEach(() => {
    db = new Database(':memory:');
    makeSchema(db);
    db.prepare(`
      INSERT INTO meetings (id, title, updated_at)
      VALUES ('meeting-1', 'Local title', '2026-09-09T13:16:00.000Z')
    `).run();
    db.prepare("INSERT INTO transcripts (meeting_id, content) VALUES ('meeting-1', 'lecture transcript')").run();
    db.prepare("INSERT INTO ai_interactions (meeting_id, ai_response) VALUES ('meeting-1', 'usage answer')").run();
    db.prepare("INSERT INTO chunks (meeting_id, cleaned_text) VALUES ('meeting-1', 'rag chunk')").run();
  });

  afterEach(() => {
    try { db.close(); } catch { /* noop */ }
  });

  test('cloud metadata update uses UPSERT instead of parent replacement', () => {
    const updatedMs = Date.parse('2026-09-09T13:16:13.064Z');
    applyToLocal(db, MEETINGS_DEF, {
      pullRows: [{
        id: 'meeting-1',
        title: 'Cloud title',
        start_time: 1788956522663,
        duration_ms: 3237878,
        summary_json: '{"legacySummary":"still present"}',
        created_at: '2026-09-09T12:22:02.663Z',
        source: 'manual',
        is_processed: 1,
        summary_status: 'completed',
        user_titled: 1,
        is_live: 0,
        updatedMs,
      }],
      pullDeletes: [],
      tombPull: [],
    });

    assert.equal(db.prepare("SELECT title FROM meetings WHERE id = 'meeting-1'").get().title, 'Cloud title');
    assert.equal(db.prepare("SELECT COUNT(*) c FROM transcripts WHERE meeting_id = 'meeting-1'").get().c, 1);
    assert.equal(db.prepare("SELECT COUNT(*) c FROM ai_interactions WHERE meeting_id = 'meeting-1'").get().c, 1);
    assert.equal(db.prepare("SELECT COUNT(*) c FROM chunks WHERE meeting_id = 'meeting-1'").get().c, 1);
    assert.equal(db.prepare('SELECT COUNT(*) c FROM sync_tombstones').get().c, 0);
  });
});
