/**
 * MeetingDetailsLiveMode.test.mjs
 *
 * LIVE MEETING NOTE (v31) — source-contract guards on MeetingDetails.tsx.
 *
 * When the opened note is live (meetings row created at Start, meeting still
 * running), MeetingDetails must:
 *   - show placeholder panels in the Summary and Usage tabs (real content is
 *     generated only after Stop),
 *   - stream the real-time transcript: finals from the display IPC
 *     (onNativeAudioTranscript) append instantly, with a 5s DB-resync poll,
 *   - leave live mode when the meeting ends (onMeetingStateChanged) and reload
 *     the finalized note,
 *   - hide the speaker-rename row while live.
 *
 * Component tests in this repo are source checks (no DOM) — see
 * NativelyInterfaceEffectDeps.test.mjs.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const sourcePath = path.resolve(__dirname, '../MeetingDetails.tsx');
const source = fs.readFileSync(sourcePath, 'utf8');

describe('MeetingDetails live mode (v31)', () => {
  test('derives the live flag from the meeting object', () => {
    assert.match(source, /const isLive = meeting\.isLive === true/,
      'the live flag must come from the meeting row (getMeetingDetails exposes isLive)');
  });

  test('Summary tab shows the placeholder while live', () => {
    assert.match(source, /activeTab === 'summary' && \(isLive \? \(/,
      'the summary tab must swap to the live placeholder while the meeting runs');
    assert.match(source, /<LiveNotePlaceholder kind="summary" \/>/);
  });

  test('Usage tab shows the placeholder while live', () => {
    assert.match(source, /activeTab === 'usage' && \(isLive \? \(/,
      'the usage tab must swap to the live placeholder while the meeting runs');
    assert.match(source, /<LiveNotePlaceholder kind="usage" \/>/);
  });

  test('placeholder strings exist for both tabs', () => {
    assert.match(source, /t\('Live meeting in progress'\)/);
    assert.match(source, /t\('Summary will be generated after the meeting ends'\)/);
    assert.match(source, /t\('Usage will appear after the meeting ends'\)/);
  });

  test('subscribes the real-time transcript stream while live', () => {
    assert.match(source, /window\.electronAPI\.onNativeAudioTranscript\(\(t\) => \{/,
      'live mode must consume the display IPC transcript stream');
    assert.match(source, /if \(t\.final\) \{/,
      'finals must commit into the transcript list');
    assert.match(source, /setLivePreview\(t\.text\)/,
      'interim (partial) segments must render as a live preview');
  });

  test('dedupes IPC finals against the DB snapshot by speaker+text+time proximity', () => {
    assert.match(source, /s\.speaker === seg\.speaker && s\.text === seg\.text && isNear\(s\.timestamp \|\| 0, seg\.timestamp\)/,
      'IPC and DB timestamps come from separate Date.now() calls — exact-key dedupe would double rows');
  });

  test('resyncs from the DB every 5 seconds by MERGING, not replacing, the live transcript', () => {
    // The 5s poll is on the same cadence as the main-process flush, but the DB
    // snapshot lags the IPC stream by up to a flush period and the two clocks
    // are unsynchronized — a blind setMeeting(fresh) would revert the newest
    // IPC finals every poll (laggy/jumpy transcript). The poll must UNION the
    // DB lines with the already-appended IPC finals instead of replacing them.
    assert.match(source, /setInterval\(\(\) => \{[\s\S]*?getMeetingDetails\?\.\(meeting\.id\)[\s\S]*?\}, 5000\)/,
      'the note must poll the authoritative DB snapshot on the same cadence as the flush');
    assert.match(source, /if \(prev\.isLive !== true\) \{[\s\S]*?return fresh as Meeting;/,
      'only leaving live mode takes the DB snapshot whole (no merge)');
    assert.match(source, /const merged = \[\.\.\.localList\];/,
      'the poll must start from the already-appended IPC finals so they are never reverted');
    assert.match(source, /if \(!dup\) merged\.push\(seg\);/,
      'DB-only lines must be appended when the local list does not already carry them');
    assert.match(source, /merged\.sort\(\(a, b\) => \(a\.timestamp \|\| 0\) - \(b\.timestamp \|\| 0\)\);/,
      'the merged list must be re-sorted by timestamp');
  });

  test('leaves live mode when the meeting ends and reloads the finalized note', () => {
    assert.match(source, /window\.electronAPI\.onMeetingStateChanged\(\(\{ isActive \}\) => \{/,
      'live mode must react to meeting-state changes');
    assert.match(source, /if \(stopped \|\| isActive\) return;/,
      'only the ended transition (isActive false) must stop live mode');
    assert.match(source, /setMeeting\(prev => \(\{ \.\.\.prev, isLive: false \}\)/,
      'the note must flip out of live mode immediately at Stop');
    assert.match(source, /void reloadMeeting\(\);/,
      'then refetch the finalized note from the DB');
  });

  test('cleans up subscriptions and the poll timer on unmount / live exit', () => {
    assert.match(source, /removeTranscript\(\);/);
    assert.match(source, /removeState\(\);/);
    assert.match(source, /if \(pollTimer\) clearInterval\(pollTimer\);/);
  });

  test('hides the speaker-rename row while live', () => {
    assert.match(source, /\{!isLive && \(\(\) => \{[\s\S]*?speakers\.length === 0/,
      'speaker labels are finalized after Stop — no inline rename during the live note');
  });

  test('renders the interim transcript preview at the bottom of the transcript tab', () => {
    assert.match(source, /\{isLive && livePreview && \(/,
      'the latest partial must render as a preview while live');
  });
});
