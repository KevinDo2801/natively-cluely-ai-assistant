/**
 * LauncherFoldersSourceGuard.test.mjs
 *
 * MEETING FOLDERS (v32) — source-contract guard on Launcher.tsx.
 *
 * The launcher must render Google-Drive-style folder organization: a New
 * Folder button + folders section at root, folder navigation with breadcrumb,
 * a "Move to folder" action in the meeting ⋯ menu, and rename/delete folder
 * actions. Meetings started from inside a folder must land in that folder
 * (main process reads the folder the launcher reported via setCurrentFolder).
 *
 * Source check (no DOM) — same convention as the other component guards.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const sourcePath = path.resolve(__dirname, '../Launcher.tsx');
const source = fs.readFileSync(sourcePath, 'utf8');

describe('Launcher meeting folders (v32)', () => {
  test('the Meeting type carries folderId', () => {
    assert.match(source, /folderId\?: string \| null; \/\/ Meeting folders \(v32\)/,
      'the Launcher Meeting interface must expose folderId so list rows typecheck');
  });

  test('root view renders a Folders section with a New Folder button', () => {
    assert.match(source, /\{t\('Folders'\)\}/, 'the section header must use the i18n key');
    assert.match(source, /\{t\('New Folder'\)\}/, 'the New Folder button must use the i18n key');
    assert.match(source, /openCreateFolderDialog/, 'New Folder must open the create dialog');
  });

  test('the meeting list is fetched for the current folder scope', () => {
    assert.match(source, /fetchMeetings\(currentFolderIdRef\.current\)/,
      'the launcher must refetch the folder-scoped meeting list');
    assert.match(source, /window\.electronAPI\.getRecentMeetings\(folderId\)/,
      'the folder scope must be forwarded to getRecentMeetings');
  });

  test('folder navigation is mirrored to the main process', () => {
    assert.match(source, /window\.electronAPI\?\.setCurrentFolder\?\.\(folderId\)/,
      'entering/leaving a folder must call setCurrentFolder so every meeting start lands there');
    assert.match(source, /handleGoToRoot/, 'a way back to the root view must exist');
  });

  test('the meeting ⋯ menu offers Move', () => {
    assert.match(source, /\{t\('Move'\)\}/, 'the menu item must use the i18n key');
    assert.match(source, /setMoveMeetingId\(m\.id\)/, 'the item must open the move picker for that meeting');
    assert.match(source, /moveMeetingToFolder\?\.\(meetingId, folderId\)/,
      'the picker must call the move IPC with the target folder');
  });

  test('folders support rename and delete (meetings move to root)', () => {
    assert.match(source, /openRenameFolderDialog/, 'folders must be renamable');
    assert.match(source, /\{t\('Rename'\)\}/, 'the rename action must use the i18n key');
    assert.match(source, /deleteFolder\?\.\(folderId, \{ deleteMeetings \}\)/, 'folders must be deletable via IPC');
    assert.match(source, /t\('Delete this folder\? Meetings inside will move to root\.'\)/,
      'the delete confirmation must warn that meetings move to root');
  });

  test('folder delete offers to also permanently delete the contained meetings', () => {
    assert.match(source, /\{t\('Also delete the meetings inside this folder'\)\}/,
      'the delete dialog must offer the permanent-delete option');
    assert.match(source, /handleDeleteFolder\(deleteFolderId, deleteMeetingsCheck\)/,
      'the confirm button must forward the checkbox flag');
    assert.match(source, /t\('This will permanently delete the folder and everything inside it\.'\)/,
      'the danger text must reflect the permanent-delete mode');
  });

  test('the header back button steps out of a folder', () => {
    assert.match(source, /currentFolderId \? handleGoToRoot : undefined/,
      'the back button must leave an open folder when no meeting is selected');
  });

  test('the launcher offers multi-select bulk delete', () => {
    assert.match(source, /\{t\('Select'\)\}/, 'a Select button must exist when meetings are listed');
    assert.match(source, /toggleSelect\(m\.id, !!m\.isLive\)/,
      'rows must toggle selection and live-note rows must be excluded');
    assert.match(source, /deleteMeetings\?\.\(ids\)/, 'bulk delete must call the delete-many IPC');
    assert.match(source, /\{t\('Delete the selected meetings\? This cannot be undone\.'\)\}/,
      'a confirmation dialog must precede bulk delete');
  });
});
