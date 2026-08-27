import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const helperPath = path.resolve(__dirname, '../../../electron/SettingsWindowHelper.ts');
const source = readFileSync(helperPath, 'utf8');

test('SettingsWindowHelper anchors off the deterministic main window, not getAllWindows iteration order', () => {
  assert.ok(
    !/BrowserWindow\.getAllWindows\s*\(\s*\)\s*\.find\s*\(/.test(source),
    'BUG: SettingsWindowHelper must not pick an anchor by iterating BrowserWindow.getAllWindows().',
  );
  assert.ok(
    /toggleWindow[\s\S]*this\.windowHelper\?\.\s*getMainWindow\s*\(\s*\)/.test(source),
    'BUG: toggleWindow must look up the active main window via the WindowHelper.',
  );
  assert.ok(
    /emitVisibilityChange[\s\S]*this\.windowHelper\?\.\s*getMainWindow\s*\(\s*\)/.test(source),
    'BUG: settings-visibility-changed must target the active main window, not whichever window appears first in getAllWindows().',
  );
  assert.ok(
    /settings-visibility-changed dropped/.test(source),
    'BUG: emitVisibilityChange should surface a warning when no main window is bound so renderer/main desync is visible.',
  );
});

test('closeWindow un-parents the settings window before hiding (Windows owned-window parity)', () => {
  // On Windows the settings window is an OWNED window of the overlay
  // (setParentWindow in showWindow). Hiding the owner auto-hides owned
  // windows, and re-showing an owned window taken down by its owner can leave
  // it click-dead ("settings popup opens but clicks do nothing" after the chat
  // overlay is hidden and re-shown). ModelSelectorWindowHelper.hideWindow()
  // already un-parents first — the settings helper must match, and the next
  // showWindow() re-parents from a clean slate.
  const close = source.slice(source.indexOf('public closeWindow()'), source.indexOf('private emitVisibilityChange'));
  assert.match(
    close,
    /this\.settingsWindow\.setParentWindow\(null\);[\s\S]{0,80}this\.settingsWindow\.hide\(\)/,
    'BUG: closeWindow must un-parent the settings window BEFORE hiding it, or the owned-window ' +
      'hide/show cycle on Windows leaves it click-dead after the overlay is hidden and re-shown.',
  );
});

test('the overlay show clears the settings blur-reopen guard (hit-or-miss fix)', () => {
  // toggleWindow() refuses to re-open the settings window within 250ms of a
  // blur-close. Hiding the chat overlay blurs/closes the settings popup and
  // stamps lastBlurTime; a fast settings re-open right after bringing the
  // overlay back then gets swallowed by the guard — "sometimes works,
  // sometimes not". The overlay 'show' is the natural boundary to clear it.
  assert.match(
    source,
    /public clearBlurGuard\(\): void \{\s*\n\s*this\.lastBlurTime = 0;/,
    'BUG: SettingsWindowHelper needs a clearBlurGuard() that resets lastBlurTime.',
  );
  const windowHelperSource = readFileSync(
    path.resolve(__dirname, '../../../electron/WindowHelper.ts'),
    'utf8',
  );
  const showHandler = windowHelperSource.slice(
    windowHelperSource.indexOf("this.overlayWindow.on('show'"),
    windowHelperSource.indexOf("this.overlayWindow.on('hide'"),
  );
  assert.match(
    showHandler,
    /this\.appState\.settingsWindowHelper\?\.clearBlurGuard\?\.\(\)/,
    'BUG: the overlay show handler must clear the settings blur guard, or the 250ms ' +
      'reopen suppression makes the settings popup hit-or-miss after hiding the chat overlay.',
  );
});

test('the settings/model popovers parent to the OVERLAY when it is visible, not getMainWindow()', () => {
  // The popup buttons live in the chat OVERLAY, and the overlay can be the
  // visible surface while currentWindowMode is still 'launcher' (Ctrl+B / the
  // pill's Ask open the chat WITHOUT a mode swap). getMainWindow() then
  // returns the LAUNCHER, and parenting the popup to it puts the popup BELOW
  // the always-on-top overlay on Windows (screen-saver > topmost) and hides it
  // with the launcher ("settings works only while the launcher is up; hide the
  // launcher and it dies"). The anchor must be the overlay whenever the
  // overlay is visible, with getMainWindow() only as a fallback.
  const modelSource = readFileSync(
    path.resolve(__dirname, '../../../electron/ModelSelectorWindowHelper.ts'),
    'utf8',
  );
  for (const [label, src, target] of [
    ['settings toggleWindow', source, /const overlayWin = this\.windowHelper\?\.getOverlayWindow\?\.\(\);/],
    ['settings showWindow', source, /const overlayWin = this\.windowHelper\?\.getOverlayWindow\?\.\(\);/],
    ['model showWindow', modelSource, /const overlayWin = this\.windowHelper\?\.getOverlayWindow\?\.\(\);/],
  ]) {
    assert.match(src, target, `BUG: ${label} must resolve the anchor from the overlay, not getMainWindow() alone.`);
  }
  // The overlay wins when visible; getMainWindow() is only the fallback.
  assert.match(
    source,
    /overlayWin && !overlayWin\.isDestroyed\(\) && overlayWin\.isVisible\(\)[\s\S]{0,120}\? overlayWin\s*:\s*\(this\.windowHelper\?\.getMainWindow\(\) \?\? null\)/,
    'BUG: settings showWindow must prefer the visible overlay over getMainWindow().',
  );
  assert.match(
    modelSource,
    /const isOverlay = !!overlayWin && !overlayWin\.isDestroyed\(\) && overlayWin\.isVisible\(\);/,
    'BUG: model selector must derive isOverlay from overlay visibility, not from getMainWindow() identity.',
  );
});
