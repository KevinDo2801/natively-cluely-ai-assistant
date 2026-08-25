import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// Source-contract tests for the "every keybind must work with NO meeting"
// audit (launcher mode). They pin the three failure classes that made
// shortcuts silently dead without a meeting:
//
//   1. shouldRegister() never registered the shortcut in launcher mode
//      (process-screenshots, focusInput).
//   2. The shortcut WAS registered but main routed the event to
//      getMainWindow() — the LAUNCHER in launcher mode — whose renderer has
//      no global-shortcut / capture-and-process listener (take-screenshot,
//      selective-screenshot, capture-and-process).
//   3. Window-movement keys drove getMainWindow() = the launcher instead of
//      the overlay group (pill + overlay chat) the user actually means.
//
// These are source-contract assertions (the better-sqlite3-free kind): they
// fail the moment someone re-routes these actions back at the launcher.

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const mainPath = path.resolve(__dirname, '../../../electron/main.ts');
const keybindPath = path.resolve(__dirname, '../../../electron/services/KeybindManager.ts');
const windowHelperPath = path.resolve(__dirname, '../../../electron/WindowHelper.ts');
const mainSource = readFileSync(mainPath, 'utf8');
const keybindSource = readFileSync(keybindPath, 'utf8');
const windowHelperSource = readFileSync(windowHelperPath, 'utf8');

function extractRegionAround(src, needle, chars = 1_500) {
  const idx = src.indexOf(needle);
  assert.ok(idx >= 0, `could not locate ${needle}`);
  return src.slice(Math.max(0, idx - 300), idx + chars);
}

// Matches both `foo()` and optional-chained `foo?.()` call forms.
const CALL = (name) => new RegExp(`${name}(\\?\\.)?\\s*\\(\\s*\\)`);

function extractClassMethod(src, methodName) {
  const methodRe = new RegExp(`(?:private|public)\\s+(?:async\\s+)?${methodName}\\s*\\([^)]*\\)[^{]*\\{`);
  const match = methodRe.exec(src);
  assert.ok(match, `could not locate ${methodName}`);
  let i = match.index + match[0].length;
  let depth = 1;
  const start = i;
  while (i < src.length && depth > 0) {
    const ch = src[i];
    if (ch === '{') depth++;
    else if (ch === '}') depth--;
    i++;
  }
  assert.equal(depth, 0, `unbalanced braces while extracting ${methodName}`);
  return src.slice(start, i - 1);
}

test('launcher mode registers process-screenshots and stealth-typing globally', () => {
  const gate = extractClassMethod(keybindSource, 'shouldRegister');
  assert.ok(
    /actionId\s*===\s*'general:process-screenshots'\)\s*return true/.test(gate),
    'BUG: Ctrl/Cmd+Enter (Process Screenshots) must be registered with no meeting running.'
  );
  assert.ok(
    /actionId\s*===\s*'chat:focusInput'\)\s*return true/.test(gate),
    'BUG: Ctrl/Cmd+Shift+Space (Toggle Stealth Typing) must be registered with no meeting running.'
  );
});

test('launcher mode registers chat scroll Up/Down globally', () => {
  const gate = extractClassMethod(keybindSource, 'shouldRegister');
  for (const id of ['chat:scrollUp', 'chat:scrollDown']) {
    assert.ok(
      new RegExp(`actionId\\s*===\\s*'${id}'\\)\\s*return true`).test(gate),
      `BUG: ${id} must be registered with no meeting running — the standalone overlay chat is scrollable.`
    );
  }
  // The deliberate exclusions must stay out: Ctrl+1..7 hijack browser tab
  // switching, Ctrl+Alt+Arrows hijack workspace/editor navigation.
  assert.ok(
    !/actionId\s*===\s*'chat:whatToAnswer'\)\s*return true/.test(gate),
    'chat:whatToAnswer (Ctrl+1) must stay overlay-only in launcher mode.'
  );
  assert.ok(
    !/actionId\s*===\s*'chat:scrollLeft'\)\s*return true/.test(gate),
    'chat:scrollLeft (Ctrl+Alt+Left) must stay overlay-only in launcher mode.'
  );
});

test('screenshot shortcuts target the overlay, never getMainWindow()', () => {
  for (const id of ["'general:take-screenshot'", "'general:selective-screenshot'"]) {
    const region = extractRegionAround(mainSource, `actionId === ${id}`, 1_600);
    assert.ok(
      CALL('getOverlayWindow').test(region),
      `BUG: ${id} must route to the overlay window — the listener lives in NativelyInterface only.`
    );
    assert.ok(
      !/const mainWindow = this\.getMainWindow\(\)/.test(region),
      `BUG: ${id} routed to getMainWindow() again — dead in launcher mode (launcher has no listener).`
    );
    assert.ok(
      CALL('revealOverlayForGlobalShortcut').test(region),
      `BUG: ${id} must reveal the overlay chat when hidden, else the hotkey looks dead.`
    );
  }
});

test('capture-and-process is delivered to the overlay, not the launcher', () => {
  const body = extractClassMethod(mainSource, 'captureScreenAndProcess');
  assert.ok(
    CALL('getOverlayWindow').test(body),
    'BUG: capture-and-process payload must go to the overlay (onCaptureAndProcess lives in NativelyInterface).'
  );
  assert.ok(
    CALL('revealOverlayForGlobalShortcut').test(body),
    'BUG: capture-and-process must reveal the overlay chat when hidden.'
  );
});

test('the reveal helper shows the overlay INACTIVE and only when hidden', () => {
  const body = extractClassMethod(mainSource, 'revealOverlayForGlobalShortcut');
  assert.ok(/!overlay\.isVisible\s*\(\s*\)/.test(body), 'reveal must no-op when the overlay is already visible.');
  assert.ok(/showOverlay\s*\(\s*true\s*\)/.test(body), 'reveal must show INACTIVE — a global shortcut must never steal focus.');
});

test('stealth-typing shortcut surfaces the overlay chat in launcher mode', () => {
  const region = extractRegionAround(mainSource, "'chat:focusInput'", 2_200);
  assert.ok(
    /getCurrentWindowMode\s*\(\s*\)\s*===\s*'overlay'/.test(region),
    'BUG: focusInput must branch on window mode — showMainWindow in launcher mode routes through switchToLauncher and kills the stealth tap.'
  );
  assert.ok(
    /revealOverlayForGlobalShortcut\s*\(\s*\)/.test(region),
    'BUG: focusInput in launcher mode must reveal the overlay chat (inactive), not the launcher.'
  );
});

test('window-movement keys drive the overlay group, not the launcher', () => {
  const body = extractClassMethod(windowHelperSource, 'moveActiveWindow');
  assert.ok(
    /const win = this\.overlayWindow/.test(body),
    'BUG: move keys must move the overlay group (overlay + pill + toggle) in both modes.'
  );
  assert.ok(
    !/getMainWindow\s*\(\s*\)/.test(body),
    'BUG: move keys must not target getMainWindow() — that is the launcher in launcher mode.'
  );
  assert.ok(
    /positionOverlayAuxWindows\s*\(\s*\)/.test(body),
    'BUG: after moving, the pill/toggle must be re-seated explicitly (hidden-window moves may not emit the move event).'
  );
});
