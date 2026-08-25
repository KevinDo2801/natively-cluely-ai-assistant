// electron/services/__tests__/MeetingPersistenceLiveNote.test.mjs
//
// LIVE MEETING NOTE (v31) — source-contract guards on MeetingPersistence.ts.
//
// The meetings row is created at Start (is_live=1). When the meeting stops,
// stopMeeting must REUSE that row's id (placeholder + final save finalize it in
// place instead of minting a new id), and the discard / do-not-persist paths
// must DELETE the live row so no stale "Live" entry survives. On the next
// launch, recoverUnprocessedMeetings adopts orphaned live rows (app quit
// mid-meeting) into the normal unprocessed pipeline.
//
// MeetingPersistence cannot be constructed without Electron, so these are
// source-contract checks (the established convention — see
// MeetingPersistenceRace.test.mjs / ModeBleeding.test.mjs).

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const sourcePath = path.resolve(__dirname, '../../MeetingPersistence.ts');
const source = fs.readFileSync(sourcePath, 'utf8');

describe('MeetingPersistence stopMeeting reuses the live meeting row id (v31)', () => {
  const stopStart = source.indexOf('public async stopMeeting');
  assert.ok(stopStart >= 0, 'stopMeeting should exist');
  const stopEnd = source.indexOf('private async processAndSaveMeeting', stopStart);
  const stopSource = source.slice(stopStart, stopEnd);

  test('stopMeeting accepts the optional liveMeetingId parameter', () => {
    assert.match(stopSource, /public async stopMeeting\(liveMeetingId\?: string \| null\)/,
      'stopMeeting must accept the live row id so the note is finalized in place');
  });

  test('the placeholder save reuses liveMeetingId instead of a fresh id', () => {
    assert.match(stopSource, /const meetingId = liveMeetingId \?\? crypto\.randomUUID\(\)/,
      'the persisted meeting id must be the live row id when provided, else the legacy random id');
  });

  test('processAndSaveMeeting receives the (possibly live) meeting id', () => {
    assert.match(stopSource, /this\.processAndSaveMeeting\(snapshot, meetingId, metadataSnapshot, modeSnapshot\)/,
      'the background finalize must run against the same id');
  });

  test('the too-short (<1s) discard path deletes the live row', () => {
    const start = stopSource.indexOf('if (durationMs < 1000)');
    assert.ok(start >= 0, 'the too-short guard should exist');
    const tooShort = stopSource.slice(start, stopSource.indexOf('return null;', start));
    assert.match(tooShort, /deleteMeeting\(liveMeetingId\)/,
      'a sub-second meeting with a live row must delete the row (no orphan "Live" entry)');
  });

  test('the doNotPersist path deletes the live row', () => {
    const start = stopSource.indexOf("doNotPersist set");
    assert.ok(start >= 0, 'the doNotPersist guard should exist');
    const dnp = stopSource.slice(start, stopSource.indexOf('this.session.reset();', start));
    assert.match(dnp, /deleteMeeting\(liveMeetingId\)/,
      'the privacy contract (no DB row) must remove the live row created at Start');
  });
});

describe('MeetingPersistence recovery adopts orphaned live rows (v31)', () => {
  const recStart = source.indexOf('public async recoverUnprocessedMeetings');
  assert.ok(recStart >= 0, 'recoverUnprocessedMeetings should exist');
  const recEnd = source.indexOf('public async regenerateSavedMeeting', recStart);
  const recSource = source.slice(recStart, recEnd);

  test('recoverUnprocessedMeetings adopts orphaned live rows before processing', () => {
    const adoptIdx = recSource.indexOf('adoptOrphanedLiveMeetings');
    const unprocessedIdx = recSource.indexOf('getUnprocessedMeetings');
    assert.ok(adoptIdx >= 0, 'recovery must adopt orphaned live rows');
    assert.ok(unprocessedIdx >= 0, 'sanity: recovery must query unprocessed meetings');
    assert.ok(adoptIdx < unprocessedIdx,
      'adoption must run BEFORE the unprocessed query so adopted rows are processed this launch');
  });
});
