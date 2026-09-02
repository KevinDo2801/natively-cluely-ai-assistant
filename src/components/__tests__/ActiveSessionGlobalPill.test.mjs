/**
 * ActiveSessionGlobalPill.test.mjs
 *
 * Source-contract guard for the ONE global "Active Session" pill.
 *
 * The pill (recording timer + stop button) used to be rendered only inside
 * MeetingDetails' floating footer. It is now rendered once by the Launcher so
 * it is visible on EVERY launcher view while a meeting records (home, folders,
 * calendar detail, meeting details), and clicking the pill body opens the live
 * note. MeetingDetails must NOT render its own pill anymore — exactly one pill
 * may exist on screen.
 *
 * Component tests in this repo are source checks (no DOM) — same convention as
 * LauncherLiveBadge.test.mjs / MeetingDetailsLiveMode.test.mjs.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const launcherSource = fs.readFileSync(path.resolve(__dirname, '../Launcher.tsx'), 'utf8');
const detailsSource = fs.readFileSync(path.resolve(__dirname, '../MeetingDetails.tsx'), 'utf8');

describe('Active Session global pill (Launcher)', () => {
  test('renders exactly one pill while a live meeting exists AND the meeting is active', () => {
    assert.match(launcherSource, /\{liveMeeting && isMeetingActive && \(/,
      'the pill must render only while a live meeting row exists and the meeting is active');
  });

  test('pill body click opens the live meeting (Transcript tab)', () => {
    assert.match(launcherSource, /handleOpenMeeting\(liveMeeting, 'transcript'\)/,
      'clicking the pill must open the live note in the transcript tab');
  });

  test('pill carries the stop-recording button wired to the endMeeting flow', () => {
    assert.match(launcherSource, /title=\{t\('Stop recording'\)\}/,
      'the pill must keep the stop button (parity with the old details pill)');
    assert.match(launcherSource, /handleStopLivePill\(\)/,
      'the stop button must call the launcher-level stop handler');
    assert.match(launcherSource, /window\.electronAPI\.endMeeting\(\)/,
      'the stop handler must fire the endMeeting IPC');
    assert.match(launcherSource, /localStorage\.removeItem\(LIVE_SESSION_START_KEY\)/,
      'the stop handler must clear the session anchor so the next timer starts clean');
  });

  test('pill timer uses the staleness-protected session anchor (phantom 800+ min guard)', () => {
    assert.match(launcherSource, /useLiveSessionTimer\(/,
      'the pill timer must come from the shared useLiveSessionTimer hook');
  });

  test('pill is driven by the global meeting list so it shows from any folder view', () => {
    assert.match(launcherSource, /allMeetings\.find\(m => m\.isLive\)/,
      'the live row must be resolved from the all-folder list (a live meeting may live in another folder)');
  });
});

describe('Active Session pill is NOT duplicated in MeetingDetails', () => {
  test('MeetingDetails no longer renders its own Active Session pill', () => {
    assert.ok(!detailsSource.includes("{t('Active Session')}"),
      'the details view must not render a second pill — the Launcher pill is global');
    assert.ok(!detailsSource.includes('handleStopSession'),
      'the old details-level stop handler must be gone');
    assert.ok(!detailsSource.includes('liveElapsedMs'),
      'the old details-level timer state must be gone');
  });

  test('MeetingDetails keeps the Continue + Ask bar only for non-live notes', () => {
    assert.match(detailsSource, /\{!isLive && \(/,
      'the floating footer (Continue + Ask) must only render for non-live notes');
    assert.match(detailsSource, /handleContinueSession/,
      'Continue recording must keep working on finalized notes');
  });
});
