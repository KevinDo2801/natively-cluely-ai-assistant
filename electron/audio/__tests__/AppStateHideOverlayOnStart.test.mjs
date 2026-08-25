// electron/audio/__tests__/AppStateHideOverlayOnStart.test.mjs
//
// "Keep overlay closed when a meeting starts" — source-contract guards on
// main.ts (AppState) + SettingsManager.
//
// When the user enables the toggle, starting a meeting must NOT auto-show the
// always-on-top meeting overlay: the launcher stays visible and flips its CTA
// to "Meeting ongoing", and the user opens the overlay on demand. The setting
// lives in SettingsManager ('hideOverlayOnStart'), is loaded into AppState at
// construction, exposed via get/set IPC, and gates the window swap inside
// startMeetingTransition.
//
// Pinned from the TypeScript source (the established convention — see
// AppStateLiveNoteStart.test.mjs).

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '../../..');
const mainSource = fs.readFileSync(path.join(root, 'electron/main.ts'), 'utf8');
const settingsSource = fs.readFileSync(path.join(root, 'electron/services/SettingsManager.ts'), 'utf8');

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

describe('hideOverlayOnStart (Settings > Overlay)', () => {
  test('AppSettings interface declares the flag in SettingsManager', () => {
    assert.match(settingsSource, /hideOverlayOnStart\?: boolean;/, 'the setting must be declared in the AppSettings interface');
  });

  test('AppState loads the flag from SettingsManager at construction', () => {
    assert.match(mainSource, /this\._hideOverlayOnStart = settingsManager\.get\('hideOverlayOnStart'\) \?\? false;/,
      'the flag must be read once at AppState construction so startMeetingTransition reads it synchronously');
  });

  test('AppState exposes get/set over the flag and persists it', () => {
    assert.match(mainSource, /public getHideOverlayOnStart\(\): boolean \{[\s\S]*?return this\._hideOverlayOnStart;/);
    assert.match(mainSource, /public setHideOverlayOnStart\(enabled: boolean\): void \{[\s\S]*?SettingsManager\.getInstance\(\)\.set\('hideOverlayOnStart', enabled\);/);
  });

  test('startMeetingTransition gates the overlay swap on the flag', () => {
    const body = extractMethodBody('startMeetingTransition');
    assert.match(body, /if \(this\._hideOverlayOnStart\)/,
      'the window swap must be gated on the hideOverlayOnStart flag');
    assert.match(body, /getCurrentWindowMode\(\) === 'overlay'/,
      'when hidden, only force a switch if we are currently on the overlay');
    assert.match(body, /setWindowMode\('launcher'\)/,
      'hidden mode must land on the launcher (which shows "Meeting ongoing")');
    assert.match(body, /setWindowMode\('overlay'\)/,
      'the default path must still switch to the overlay');
  });

  test('the gated swap still runs BEFORE the meeting-active broadcast', () => {
    const body = extractMethodBody('startMeetingTransition');
    const swapIdx = body.indexOf('setWindowMode');
    const activeIdx = body.indexOf('this.isMeetingActive = true');
    assert.ok(swapIdx >= 0 && activeIdx >= 0, 'sanity: swap and broadcast must both exist');
    assert.ok(swapIdx < activeIdx,
      'the window swap must precede the isMeetingActive=true broadcast to avoid a launcher flash');
  });
});
