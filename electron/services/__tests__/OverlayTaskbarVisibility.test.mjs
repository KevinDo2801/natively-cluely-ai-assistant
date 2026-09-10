import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '../../..');
const read = (rel) => readFileSync(path.resolve(root, rel), 'utf8');

const windowHelper = read('electron/WindowHelper.ts');
const main = read('electron/main.ts');

test('the complete overlay family is re-hidden from the Windows taskbar', () => {
  const method = windowHelper.slice(
    windowHelper.indexOf('public reassertOverlayTaskbarHidden()'),
    windowHelper.indexOf('public reassertContentProtection()'),
  );
  assert.match(method, /this\.adapter\.isWindows\(\)/);
  assert.match(method, /this\.overlayWindow, this\.pillWindow, this\.toggleWindow/);
  assert.match(method, /win\.setSkipTaskbar\(true\)/);
  assert.match(method, /setTimeout\(\(\) =>/,
    'DWM can apply show/focusability styles after the synchronous call, so a delayed reassertion is required');
});

test('showing the overlay reasserts taskbar hiding before and after auxiliary windows appear', () => {
  const showOverlay = windowHelper.slice(
    windowHelper.indexOf('public showOverlay('),
    windowHelper.indexOf('public hideOverlay('),
  );
  const calls = showOverlay.match(/this\.reassertOverlayTaskbarHidden\(\)/g) ?? [];
  assert.ok(calls.length >= 2, 'showOverlay must re-hide the family before and after showing auxiliary windows');
});

test('switching normal versus stealth focusability does not leak the overlay into taskbar previews', () => {
  const setter = main.slice(
    main.indexOf('public setStealthTypingEnabled('),
    main.indexOf('public getAutoAnswerEnabled('),
  );
  const focusIndex = setter.indexOf('overlay.setFocusable(!enabled)');
  const taskbarIndex = setter.indexOf('this.windowHelper.reassertOverlayTaskbarHidden()');
  assert.ok(focusIndex >= 0, 'stealth setter must still flip Windows focusability');
  assert.ok(taskbarIndex > focusIndex, 'taskbar hiding must be reasserted after focusability changes');
});

test('blur and hide transitions reassert taskbar hiding after no-activate focusability changes', () => {
  const setupListeners = windowHelper.slice(
    windowHelper.indexOf('private setupWindowListeners()'),
    windowHelper.indexOf('public getMainWindow()'),
  );
  assert.match(
    setupListeners,
    /this\.overlayWindow\.on\('blur',[\s\S]*?this\.reassertOverlayTaskbarHidden\(\)/,
    'overlay blur must repair taskbar registration after attachNoActivate changes focusability',
  );

  const auxWindows = windowHelper.slice(
    windowHelper.indexOf('private createOverlayAuxWindows('),
    windowHelper.indexOf('private positionOverlayAuxWindows('),
  );
  assert.match(
    auxWindows,
    /win\.on\('blur',[\s\S]*?this\.reassertOverlayTaskbarHidden\(\)/,
    'pill/toggle blur must repair taskbar registration',
  );
  assert.match(
    auxWindows,
    /this\.overlayWindow\.on\('hide',[\s\S]*?this\.reassertOverlayTaskbarHidden\(\)/,
    'overlay hide must repair taskbar registration after no-activate hide listeners',
  );
});
