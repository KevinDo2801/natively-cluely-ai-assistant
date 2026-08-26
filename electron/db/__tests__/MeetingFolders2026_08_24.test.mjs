// Meeting folders (v32) — DatabaseManager folder CRUD + meetings.folder_id.
//
// Pins the Google-Drive-style folder feature:
//   - migration v32 creates the `folders` table and `meetings.folder_id`
//     (nullable; NULL = root / main launcher list) without touching existing
//     meeting rows;
//   - createFolder / listFolders (with meeting counts) / renameFolder /
//     deleteFolder (contained meetings move BACK to root, never deleted) /
//     moveMeeting (into a folder or back to root, rejecting unknown folders);
//   - getRecentMeetings filters by folder scope (all / root / one folder) and
//     returns folderId;
//   - saveMeeting's INSERT OR REPLACE preserves folder_id across idempotent
//     re-saves (live-note flush → final save → RAG re-save must not orphan a
//     meeting out of its folder — the RC-7 lesson applied to folder_id);
//   - getMeetingDetails returns folderId.
//
// Run under `ELECTRON_RUN_AS_NODE=1 electron --test` (native ABI) or
// `node --test` after `npm run build:electron`.

import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repoRoot = path.resolve(__dirname, '..', '..', '..');
const DB_PATH = path.join(repoRoot, 'dist-electron/electron/db/DatabaseManager.js');

let DatabaseManager;
let dbMgr;

/** Minimal Meeting shape accepted by saveMeeting. */
function makeMeeting(id, overrides = {}) {
  return {
    id,
    title: `Meeting ${id}`,
    date: new Date().toISOString(),
    duration: '0:00',
    summary: '',
    detailedSummary: { actionItems: [], keyPoints: [] },
    transcript: [],
    usage: [],
    isProcessed: true,
    ...overrides,
  };
}

describe('DatabaseManager — meeting folders (v32)', () => {
  beforeEach(() => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'folders-test-'));
    process.env.NATIVELY_TEST_USERDATA = tmp;
    try { delete require.cache[DB_PATH]; } catch {}
    DatabaseManager = require(DB_PATH).DatabaseManager;
    dbMgr = DatabaseManager.getInstance();
  });

  afterEach(() => {
    try { dbMgr?.close?.(); } catch {}
    try { delete require.cache[DB_PATH]; } catch {}
    delete process.env.NATIVELY_TEST_USERDATA;
  });

  test('migration v32 creates folders table + meetings.folder_id', () => {
    if (!dbMgr.isAvailable()) return;
    const db = dbMgr.getDb();
    const foldersTable = db.prepare(
      `SELECT name FROM sqlite_master WHERE type='table' AND name='folders'`
    ).get();
    assert.ok(foldersTable, 'folders table must exist after migrations');

    const meetingCols = db.prepare(`PRAGMA table_info(meetings)`).all();
    const folderCol = meetingCols.find((c) => c.name === 'folder_id');
    assert.ok(folderCol, 'meetings.folder_id column must exist after migrations');
  });

  test('createFolder trims names and rejects blank input', () => {
    if (!dbMgr.isAvailable()) return;
    const f = dbMgr.createFolder('  Project X  ');
    assert.ok(f, 'createFolder must return the created folder');
    assert.equal(f.name, 'Project X');
    assert.ok(f.id);

    assert.equal(dbMgr.createFolder('   '), null, 'blank names must be rejected');
    assert.equal(dbMgr.createFolder(''), null, 'empty names must be rejected');
  });

  test('listFolders returns folders with meeting counts', () => {
    if (!dbMgr.isAvailable()) return;
    const a = dbMgr.createFolder('Alpha');
    const b = dbMgr.createFolder('beta');
    assert.ok(a && b);

    // Put one meeting in Alpha, none in beta.
    dbMgr.saveMeeting(makeMeeting('m-1', { folderId: a.id }), Date.now(), 0);

    const folders = dbMgr.listFolders();
    assert.equal(folders.length, 2);
    const alpha = folders.find((f) => f.id === a.id);
    const beta = folders.find((f) => f.id === b.id);
    assert.equal(alpha.meetingCount, 1);
    assert.equal(beta.meetingCount, 0);
    // Case-insensitive name sort: Alpha before beta.
    assert.equal(folders[0].id, a.id);
  });

  test('renameFolder updates the name and rejects blank', () => {
    if (!dbMgr.isAvailable()) return;
    const f = dbMgr.createFolder('Old');
    assert.ok(f);
    assert.equal(dbMgr.renameFolder(f.id, '  New Name  '), true);
    assert.equal(dbMgr.listFolders()[0].name, 'New Name');
    assert.equal(dbMgr.renameFolder(f.id, '   '), false, 'blank rename must fail');
    assert.equal(dbMgr.renameFolder('missing-id', 'X'), false, 'unknown id must fail');
  });

  test('deleteFolder moves contained meetings to root and removes the folder', () => {
    if (!dbMgr.isAvailable()) return;
    const f = dbMgr.createFolder('ToDelete');
    assert.ok(f);
    dbMgr.saveMeeting(makeMeeting('m-in', { folderId: f.id }), Date.now(), 0);
    dbMgr.saveMeeting(makeMeeting('m-root'), Date.now(), 0);

    assert.equal(dbMgr.deleteFolder(f.id), true);
    assert.equal(dbMgr.listFolders().length, 0);
    assert.equal(dbMgr.deleteFolder(f.id), false, 'second delete must fail');

    // The contained meeting moved back to root (folder_id = NULL), not deleted.
    const rootMeetings = dbMgr.getRecentMeetings(50, null);
    const ids = rootMeetings.map((m) => m.id);
    assert.ok(ids.includes('m-in'), 'contained meeting must move back to root');
    assert.ok(ids.includes('m-root'));
  });

  test('deleteFolder with deleteMeetings=true permanently deletes contained meetings (children too)', () => {
    if (!dbMgr.isAvailable()) return;
    const f = dbMgr.createFolder('ToWipe');
    assert.ok(f);
    dbMgr.saveMeeting(makeMeeting('m-wipe-1', { folderId: f.id }), Date.now() - 2000, 0);
    dbMgr.saveMeeting(makeMeeting('m-wipe-2', { folderId: f.id }), Date.now() - 1000, 0);
    dbMgr.saveMeeting(makeMeeting('m-keep'), Date.now(), 0);

    // Give m-wipe-1 a transcript so we can assert the FK cascade reached children.
    const db = dbMgr.getDb();
    db.prepare('INSERT INTO transcripts (meeting_id, speaker, content, timestamp_ms) VALUES (?, ?, ?, ?)')
      .run('m-wipe-1', 'user', 'hello', Date.now());

    assert.equal(dbMgr.deleteFolder(f.id, { deleteMeetings: true }), true);

    assert.equal(dbMgr.listFolders().length, 0, 'folder must be gone');
    assert.equal(dbMgr.getRecentMeetings(50, f.id).length, 0, 'folder-scoped list must be empty');
    const remaining = dbMgr.getRecentMeetings(50).map((m) => m.id);
    assert.ok(!remaining.includes('m-wipe-1') && !remaining.includes('m-wipe-2'),
      'contained meetings must be permanently deleted');
    assert.ok(remaining.includes('m-keep'), 'unrelated meetings must survive');
    const childCount = db.prepare('SELECT COUNT(*) AS n FROM transcripts WHERE meeting_id = ?').get('m-wipe-1').n;
    assert.equal(childCount, 0, 'transcript children must cascade-delete with the meeting');

    // An empty folder is still deletable in permanent mode.
    const empty = dbMgr.createFolder('Empty');
    assert.ok(empty);
    assert.equal(dbMgr.deleteFolder(empty.id, { deleteMeetings: true }), true);
  });

  test('moveMeeting assigns to a folder, back to root, and rejects unknown folders', () => {
    if (!dbMgr.isAvailable()) return;
    const f = dbMgr.createFolder('Target');
    assert.ok(f);
    dbMgr.saveMeeting(makeMeeting('m-1'), Date.now(), 0);

    assert.equal(dbMgr.moveMeeting('m-1', f.id), true);
    assert.equal(dbMgr.getMeetingDetails('m-1').folderId, f.id);

    assert.equal(dbMgr.moveMeeting('m-1', 'no-such-folder'), false, 'unknown folder must be rejected');
    assert.equal(dbMgr.getMeetingDetails('m-1').folderId, f.id, 'failed move must not change folder');

    assert.equal(dbMgr.moveMeeting('m-1', null), true);
    assert.equal(dbMgr.getMeetingDetails('m-1').folderId, null, 'null must move back to root');
  });

  test('getRecentMeetings filters by folder scope and returns folderId', () => {
    if (!dbMgr.isAvailable()) return;
    const a = dbMgr.createFolder('A');
    assert.ok(a);
    dbMgr.saveMeeting(makeMeeting('m-a', { folderId: a.id }), Date.now() - 2000, 0);
    dbMgr.saveMeeting(makeMeeting('m-root-1'), Date.now() - 1000, 0);
    dbMgr.saveMeeting(makeMeeting('m-root-2'), Date.now(), 0);

    const all = dbMgr.getRecentMeetings(50);
    assert.equal(all.length, 3, 'undefined scope must return every meeting');

    const root = dbMgr.getRecentMeetings(50, null);
    assert.deepEqual(root.map((m) => m.id).sort(), ['m-root-1', 'm-root-2']);
    assert.ok(root.every((m) => m.folderId === null));

    const folder = dbMgr.getRecentMeetings(50, a.id);
    assert.deepEqual(folder.map((m) => m.id), ['m-a']);
    assert.equal(folder[0].folderId, a.id);
  });

  test('saveMeeting preserves folder_id across idempotent re-saves (regression pin)', () => {
    if (!dbMgr.isAvailable()) return;
    const f = dbMgr.createFolder('Keep');
    assert.ok(f);

    // Live-note creation: row starts inside the folder.
    dbMgr.saveMeeting(makeMeeting('live-1', { folderId: f.id, isLive: true, isProcessed: false, summaryStatus: 'queued' }), Date.now(), 0);
    assert.equal(dbMgr.getMeetingDetails('live-1').folderId, f.id);

    // Final save (stop path) does NOT pass folderId — the pre-read must
    // preserve the existing assignment instead of resetting it to NULL.
    dbMgr.saveMeeting(makeMeeting('live-1', { isLive: false, isProcessed: true, summaryStatus: 'completed' }), Date.now(), 60000);
    assert.equal(
      dbMgr.getMeetingDetails('live-1').folderId,
      f.id,
      'INSERT OR REPLACE re-save must not orphan the meeting out of its folder'
    );

    // An EXPLICIT folderId still wins over the pre-read (e.g. a move).
    dbMgr.saveMeeting(makeMeeting('live-1', { folderId: null, isProcessed: true }), Date.now(), 60000);
    assert.equal(dbMgr.getMeetingDetails('live-1').folderId, null);
  });

  test('getMeetingDetails returns folderId', () => {
    if (!dbMgr.isAvailable()) return;
    const f = dbMgr.createFolder('Details');
    assert.ok(f);
    dbMgr.saveMeeting(makeMeeting('m-details', { folderId: f.id }), Date.now(), 0);
    assert.equal(dbMgr.getMeetingDetails('m-details').folderId, f.id);
  });

  test('deleteMeetings bulk-deletes atomically and returns the deleted count', () => {
    if (!dbMgr.isAvailable()) return;
    dbMgr.saveMeeting(makeMeeting('b1'), Date.now() - 3000, 0);
    dbMgr.saveMeeting(makeMeeting('b2'), Date.now() - 2000, 0);
    dbMgr.saveMeeting(makeMeeting('b3'), Date.now() - 1000, 0);
    dbMgr.saveMeeting(makeMeeting('b-keep'), Date.now(), 0);

    // Children of b1 must cascade with the bulk delete.
    const db = dbMgr.getDb();
    db.prepare('INSERT INTO transcripts (meeting_id, speaker, content, timestamp_ms) VALUES (?, ?, ?, ?)')
      .run('b1', 'user', 'hello', Date.now());

    const deleted = dbMgr.deleteMeetings(['b1', 'b2', 'missing-id', 'b3']);
    assert.equal(deleted, 3, 'existing ids deleted, unknown id skipped');
    const remaining = dbMgr.getRecentMeetings(50).map((m) => m.id);
    assert.deepEqual(remaining, ['b-keep']);
    const childCount = db.prepare('SELECT COUNT(*) AS n FROM transcripts WHERE meeting_id = ?').get('b1').n;
    assert.equal(childCount, 0, 'children cascade with the bulk delete');

    assert.equal(dbMgr.deleteMeetings([]), 0, 'empty input is a no-op');
    assert.equal(dbMgr.deleteMeetings(['nope']), 0, 'unknown-only input deletes nothing');
  });

  test('clearAllData wipes folders too', () => {
    if (!dbMgr.isAvailable()) return;
    const f = dbMgr.createFolder('Wipe');
    assert.ok(f);
    dbMgr.saveMeeting(makeMeeting('m-wipe', { folderId: f.id }), Date.now(), 0);
    assert.equal(dbMgr.clearAllData(), true);
    assert.equal(dbMgr.listFolders().length, 0);
    assert.equal(dbMgr.getRecentMeetings(50).length, 0);
  });
});
