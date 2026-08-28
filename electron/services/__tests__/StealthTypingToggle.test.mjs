// Source-contract regression tests for the "Stealth typing" settings toggle.
//
// The toggle lets a user disable stealth typing (the OS-level keystroke
// tap/hook) so the overlay input falls back to real DOM focus — which is what
// lets an IME (e.g. Vietnamese, CJK) compose. These tests pin the wiring end to
// end so a refactor can't silently drop any link in the chain:
//   1. The setting key exists in SettingsManager.AppSettings.
//   2. StealthKeyboardManager.isAvailable() declines when the setting is OFF
//      (this is the single gate feeding chat:focusInput, engageOverlayStealthTyping,
//      the Windows no-activate policy provider, and Windows should-auto-engage).
//   3. The macOS should-auto-engage + refresh-ime handlers also fold isAvailable().
//   4. AppState exposes get/set and setter persists + flips the Windows overlay
//      focusability + stops an engaged tap.
//   5. The settings IPC + preload bridge + electron.d.ts expose the API.
//   6. The Windows no-activate blur/hide revert is setting-aware (does not fight
//      the toggle by re-asserting setFocusable(false) while stealth is OFF).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '../../..');
const read = (rel) => readFileSync(path.resolve(root, rel), 'utf8');

const settings = read('electron/services/SettingsManager.ts');
const mgr = read('electron/services/StealthKeyboardManager.ts');
const main = read('electron/main.ts');
const policy = read('electron/utils/windowsFocusPolicy.ts');
const flags = read('electron/ipc/settingsFlags.ts');
const preload = read('electron/preload.ts');
const electronDts = read('src/types/electron.d.ts');

test('SettingsManager declares the stealthTypingEnabled setting key', () => {
  assert.match(
    settings,
    /stealthTypingEnabled\?: boolean;/,
    'BUG: the stealth toggle needs a SettingsManager.AppSettings key.',
  );
});

test('isAvailable() declines when the stealth toggle is OFF', () => {
  const block = mgr.slice(mgr.indexOf('public isAvailable()'), mgr.indexOf('public isNativeTapPresent()'));
  assert.ok(block.length > 0, 'isAvailable() not found');
  assert.match(
    block,
    /SettingsManager[\s\S]{0,120}get\('stealthTypingEnabled'\)\s*===\s*false\)\s*return false/,
    "BUG: isAvailable() must return false when the stealth toggle is OFF — that is the single gate " +
      'that routes the user through the focus-fallback so an IME (e.g. Vietnamese) can compose.',
  );
});

test('macOS should-auto-engage and refresh-ime fold isAvailable() (setting-aware)', () => {
  // Slice the darwin-only stealth handler block: from the `if (process.platform
  // === 'darwin')` that guards should-auto-engage/refresh-ime down to the
  // Windows `} else {` that ends it.
  const darwinGuard = "if (process.platform === 'darwin') {";
  const darwinStart = main.indexOf(darwinGuard, main.indexOf("registerStealthHandler('stealth-tap:available'"));
  const winElse = main.indexOf('} else {', darwinStart);
  const block = main.slice(darwinStart, winElse);
  const folds = block.match(/stealth\.isAvailable\(\) && shouldAutoEngageStealthTap\(\)/g) ?? [];
  assert.ok(
    folds.length >= 2,
    `BUG: both darwin handlers (should-auto-engage + refresh-ime) must fold stealth.isAvailable() ` +
      `(which reads the user's toggle) — found ${folds.length}.`,
  );
});

test('AppState exposes get/set + setter persists, stops the tap, and flips Windows focusability', () => {
  assert.match(main, /public getStealthTypingEnabled\(\): boolean \{/);
  assert.match(main, /public setStealthTypingEnabled\(enabled: boolean\): boolean \{/);
  const setter = main.slice(main.indexOf('public setStealthTypingEnabled'), main.indexOf('public setDisguise'));
  assert.match(setter, /SettingsManager\.getInstance\(\)\.set\('stealthTypingEnabled', enabled\)/);
  assert.match(
    setter,
    /if \(!enabled\)[\s\S]{0,200}StealthKeyboardManager\.getInstance\(\)\.stop\(\)/,
    'BUG: disabling stealth must stop any engaged tap immediately.',
  );
  assert.match(
    setter,
    /process\.platform === 'win32'[\s\S]{0,240}overlay\.setFocusable\(!enabled\)/,
    'BUG: on Windows the setter must flip the overlay focusability so the toggle takes effect mid-session.',
  );
  assert.match(
    main,
    /this\._stealthTypingEnabled = settingsManager\.get\('stealthTypingEnabled'\) !== false/,
    'BUG: the toggle must default to ON when unset.',
  );
});

test('settings IPC + preload + electron.d.ts expose the toggle', () => {
  assert.match(flags, /getStealthTypingEnabled\(\): boolean;/);
  assert.match(flags, /setStealthTypingEnabled\(v: boolean\): boolean;/);
  assert.match(flags, /'get-stealth-typing-enabled'/);
  assert.match(flags, /'set-stealth-typing-enabled'/);
  assert.match(preload, /getStealthTypingEnabled: \(\) => Promise<boolean>/);
  assert.match(preload, /setStealthTypingEnabled: \(enabled: boolean\) => Promise<\{ success: boolean; error\?: string \}>/);
  assert.match(preload, /get-stealth-typing-enabled/);
  assert.match(preload, /set-stealth-typing-enabled/);
  assert.match(electronDts, /getStealthTypingEnabled: \(\) => Promise<boolean>/);
  assert.match(electronDts, /setStealthTypingEnabled: \(enabled: boolean\) => Promise<\{ success: boolean; error\?: string \}>/);
});

test('Windows no-activate blur/hide revert is setting-aware (does not fight the toggle)', () => {
  const revert = policy.slice(policy.indexOf('const revert'), policy.indexOf('win.on(\'blur\', revert)'));
  assert.match(
    revert,
    /setFocusable\(!hookAvailabilityProvider\(\)\)/,
    'BUG: the blur/hide revert must re-assert based on hookAvailabilityProvider() (which folds the stealth toggle + IME), ' +
      'not hardcode false — otherwise disabling stealth mid-session gets undone on the next blur/hide.',
  );
});
