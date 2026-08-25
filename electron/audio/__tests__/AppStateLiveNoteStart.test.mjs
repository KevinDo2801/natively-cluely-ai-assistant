// electron/audio/__tests__/AppStateLiveNoteStart.test.mjs
//
// LIVE MEETING NOTE (v31) — source-contract guards on main.ts (AppState).
//
// At Start the app must create a `meetings` row with is_live=1 (so the note
// exists immediately and survives a crash mid-meeting), broadcast
// meetings-updated so the Launcher shows the "Live" entry, and arm a periodic
// flush of the in-memory transcript + usage into that row. At Stop the flush
// stops and the row id is handed to stopMeeting so the note is finalized in
// place. A quit mid-meeting flushes once more synchronously.
//
// The invariant is pinned from the TypeScript source (the established
// convention — see MeetingStartMicBeforeSystemOrder.test.mjs).

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '../../..');
const mainSource = fs.readFileSync(path.join(root, 'electron/main.ts'), 'utf8');

function extractMethodBody(methodName) {
  const re = new RegExp(`(?:public|private|protected)\\s+(?:async\\s+)?${methodName}\\s*\\([^)]*\\)\\s*(?::\\s*[^{;=]*(?:\\{[^{}]*\\}\\s*)?)?\\s*\\{`);
  const m = re.exec(mainSource);
  assert.ok(m, `could not locate ${methodName} in main.ts`);
  let i = m.index + m[0].length;
  let depth = 1;
  const start = i;
  while (i < mainSource.length && depth > 0) {
    const ch = mainSource[i];
    if (ch === '{') depth++;
    else if (ch === '}') depth--;
    i++;
  }
  assert.equal(depth, 0, `unbalanced braces in ${methodName}`);
  return mainSource.slice(start, i - 1);
}

function scrubNonCode(body) {
  return body
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/\/\/.*$/gm, '')
    .replace(/`(?:\\.|[^`])*`/g, '``')
    .replace(/'(?:\\.|[^'])*'/g, "''")
    .replace(/"(?:\\.|[^"])*"/g, '""');
}

describe('startMeetingTransition creates the live note at Start (v31)', () => {
  const body = extractMethodBody('startMeetingTransition');
  const scrubbed = scrubNonCode(body);

  test('calls startLiveMeetingNote(metadata) after the meeting becomes active', () => {
    const activeIdx = scrubbed.indexOf('this.isMeetingActive = true');
    const callIdx = scrubbed.indexOf('this.startLiveMeetingNote(metadata)');
    assert.ok(activeIdx >= 0, 'sanity: isMeetingActive must be set');
    assert.ok(callIdx >= 0, 'startMeetingTransition must call startLiveMeetingNote(metadata)');
    assert.ok(activeIdx < callIdx,
      'the live note must be created AFTER the meeting is active (and after its state broadcast)');
  });

  test('broadcasts meeting state before creating the live note', () => {
    const broadcastIdx = scrubbed.indexOf('this.broadcastMeetingState()');
    const callIdx = scrubbed.indexOf('this.startLiveMeetingNote(metadata)');
    assert.ok(broadcastIdx >= 0);
    assert.ok(broadcastIdx < callIdx,
      'the state broadcast must precede live-note creation so UI never sees the note before the meeting');
  });
});

describe('startLiveMeetingNote creates the is_live row + flush timer (v31)', () => {
  const body = extractMethodBody('startLiveMeetingNote');
  const scrubbed = scrubNonCode(body);

  test('saves a meeting row with isLive: true', () => {
    assert.match(scrubbed, /db\.saveMeeting\(\{/,
      'startLiveMeetingNote must persist a meetings row');
    assert.match(scrubbed, /isLive: true/,
      'the row must be flagged is_live so the Launcher shows the Live entry');
    assert.match(scrubbed, /crypto\.randomUUID\(\)/,
      'each meeting gets a fresh live row id (reused at Stop via stopMeeting)');
  });

  test('stores the live id and broadcasts meetings-updated', () => {
    assert.match(body, /this\._liveMeetingId = liveId/,
      'the live row id must be remembered for the Stop-side reuse and periodic flush');
    // The raw body: string literals survive here (scrubNonCode empties them).
    assert.match(body, /this\.broadcast\(['"]meetings-updated['"]\)/,
      'the Launcher history list must refresh so the Live entry appears');
  });

  test('arms the periodic flush with the LIVE_NOTE_FLUSH_MS cadence', () => {
    assert.match(scrubbed, /setInterval\(\(\) => \{\s*this\.flushLiveMeetingSnapshot\(\);\s*\}, AppState\.LIVE_NOTE_FLUSH_MS\)/,
      'a timer must flush the in-memory transcript+usage into the live row on the shared cadence');
    assert.match(scrubbed, /flushLiveMeetingSnapshot/);
  });

  test('is gated on retention never / doNotPersist (same privacy contract as stopMeeting)', () => {
    assert.match(body, /retention === ['"]never['"] \|\| metadata\?\.doNotPersist === true/,
      'the privacy contract must skip live-note creation entirely');
    assert.match(scrubbed, /!db\.isAvailable\(\)/,
      'DB unavailability must skip creation (never break the meeting)');
  });

  test('failure cleanup deletes the row and clears the timer', () => {
    assert.match(scrubbed, /deleteMeeting\(this\._liveMeetingId\)/,
      'a start-side failure must not leave an orphan live row behind');
    assert.match(scrubbed, /clearInterval\(this\._liveFlushTimer\)/);
    assert.match(scrubbed, /this\._liveMeetingId = null/);
  });
});

describe('flushLiveMeetingSnapshot (v31)', () => {
  const body = extractMethodBody('flushLiveMeetingSnapshot');
  const scrubbed = scrubNonCode(body);

  test('no-ops without a live id or an active meeting', () => {
    assert.match(scrubbed, /if \(!liveId \|\| !this\.isMeetingActive\) return/,
      'the flush must only run for the current live meeting');
  });

  test('writes the in-memory transcript + usage into the live row', () => {
    assert.match(scrubbed, /upsertLiveMeetingSnapshot\(/,
      'must call the idempotent DB flush');
    assert.match(scrubbed, /getCurrentMeetingTranscript\(\)/,
      'must flush the finalized transcript (finals only — same persistence semantics as Stop)');
    assert.match(scrubbed, /getCurrentMeetingUsage\(\)/,
      'must flush the usage log too');
  });
});

describe('endMeetingTransition hands the live row id to stopMeeting (v31)', () => {
  const body = extractMethodBody('endMeetingTransition');
  const scrubbed = scrubNonCode(body);

  test('captures and clears _liveMeetingId synchronously', () => {
    assert.match(scrubbed, /const liveMeetingId = this\._liveMeetingId;/,
      'Stop must capture the live row id before the background teardown');
    assert.match(scrubbed, /this\._liveMeetingId = null;/,
      'the id must be cleared synchronously so a new meeting never reuses it');
    assert.match(scrubbed, /clearInterval\(this\._liveFlushTimer\)/,
      'the periodic flush must stop at Stop');
  });

  test('passes the live id into stopMeeting (finalize in place)', () => {
    assert.match(scrubbed, /stopMeeting\(liveMeetingId\)/,
      'the placeholder + final save must reuse the live row id');
  });
});

describe('before-quit flushes the live note synchronously (v31)', () => {
  test('shutdown flushes the live snapshot once more', () => {
    const idx = mainSource.indexOf('app.on("before-quit"');
    assert.ok(idx >= 0, 'before-quit handler should exist');
    const beforeQuit = mainSource.slice(idx, idx + 6000);
    assert.match(beforeQuit, /appState\.flushLiveMeetingSnapshot\(\)/,
      'a quit mid-meeting must flush the latest transcript+usage (best-effort, synchronous)');
  });
});
