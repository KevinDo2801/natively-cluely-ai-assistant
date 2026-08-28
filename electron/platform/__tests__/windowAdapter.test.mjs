// electron/platform/__tests__/windowAdapter.test.mjs
//
// Contract test for the WindowAdapter (Phase 1). Replaces the brittle
// source-regex parity pins in WindowsPlatformParity.test.mjs: asserts branch
// BEHAVIOR on both platforms via injected platform — both darwin and win32
// branches run on any host, with mock windows, no process.platform mutation.
//
// Run: `npm run build:electron` then ELECTRON_RUN_AS_NODE=1 electron --test

import { test } from 'node:test';
import assert from 'node:assert/strict';
import Module from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const COMPILED = path.resolve(__dirname, '../../../dist-electron/electron/platform/windowAdapter/index.js');
const require = Module.createRequire(import.meta.url);
const { createWindowAdapter } = require(COMPILED);

/** Records every win.* call; type-checks nothing (plain JS). */
function createMockWindow() {
  const calls = [];
  const win = {
    calls,
    destroyed: false,
    visible: true,
    alwaysOnTop: false,
    isDestroyed: () => win.destroyed,
    isVisible: () => win.visible,
    isAlwaysOnTop: () => win.alwaysOnTop,
    setAlwaysOnTop: (v, lvl, rel) => { win.alwaysOnTop = v; calls.push(['setAlwaysOnTop', v, lvl, rel]); },
    setOpacity: (v) => calls.push(['setOpacity', v]),
    setContentProtection: (v) => calls.push(['setContentProtection', v]),
    show: () => calls.push(['show']),
    showInactive: () => calls.push(['showInactive']),
    focus: () => calls.push(['focus']),
    hide: () => calls.push(['hide']),
    setVisibleOnAllWorkspaces: (v, o) => calls.push(['setVisibleOnAllWorkspaces', v, o]),
    setHiddenInMissionControl: (v) => calls.push(['setHiddenInMissionControl', v]),
    setSkipTaskbar: (v) => calls.push(['setSkipTaskbar', v]),
    setVibrancy: (v) => calls.push(['setVibrancy', v]),
    setBounds: (b) => calls.push(['setBounds', b]),
    getNativeWindowHandle: () => 0,
    once: (ev, cb) => calls.push(['once', ev]),
    on: (ev, cb) => calls.push(['on', ev]),
  };
  return win;
}
const has = (calls, name) => calls.some((c) => c[0] === name);

test('factory: darwin/win32 resolve; unsupported throws', () => {
  assert.equal(createWindowAdapter('darwin').platform, 'darwin');
  assert.equal(createWindowAdapter('win32').platform, 'win32');
  assert.throws(() => createWindowAdapter('linux'), /Unsupported platform/);
});

test('construction options: launcher / panel / cropper fragments', () => {
  assert.deepEqual(createWindowAdapter('darwin').launcherWindowOptions(),
    { titleBarStyle: 'hiddenInset', trafficLightPosition: { x: 14, y: 14 }, vibrancy: 'under-window', visualEffectState: 'followWindow' });
  assert.deepEqual(createWindowAdapter('win32').launcherWindowOptions(),
    { frame: false, titleBarOverlay: false, autoHideMenuBar: true });
  assert.deepEqual(createWindowAdapter('darwin').panelWindowOptions(), { type: 'panel' });
  assert.deepEqual(createWindowAdapter('win32').panelWindowOptions(), {});
  assert.deepEqual(createWindowAdapter('win32').cropperWindowOptions(), { enableLargerThanScreen: true });
  assert.deepEqual(createWindowAdapter('darwin').cropperWindowOptions(), { type: 'toolbar' });
});

test('launcherIconPath: icns vs ico, fakeicon dir, unknown-mode fallback', () => {
  const d = createWindowAdapter('darwin'), w = createWindowAdapter('win32');
  assert.ok(d.launcherIconPath('none', false).endsWith(path.join('assets', 'natively.icns')), d.launcherIconPath('none', false));
  assert.ok(w.launcherIconPath('none', false).endsWith(path.join('assets', 'icons', 'win', 'icon.ico')), w.launcherIconPath('none', false));
  assert.ok(d.launcherIconPath('terminal', false).includes(path.join('fakeicon', 'mac')), d.launcherIconPath('terminal', false));
  assert.ok(w.launcherIconPath('activity', false).includes(path.join('fakeicon', 'win')), w.launcherIconPath('activity', false));
  // Unknown mode → app icon fallback.
  assert.ok(w.launcherIconPath('bogus', false).endsWith('icon.ico'), w.launcherIconPath('bogus', false));
  // Packaged mode resolves under process.resourcesPath.
  assert.ok(w.launcherIconPath('none', true).includes('resources'), w.launcherIconPath('none', true));
});

test('applyStealth matrix: darwin attrs vs win32 re-assert opt-in', () => {
  const dw = createMockWindow();
  createWindowAdapter('darwin').applyStealth(dw, { visibleOnAllWorkspaces: true, hiddenInMissionControl: true, alwaysOnTop: true, alwaysOnTopLevel: 'floating', alwaysOnTopRelativeLevel: -1 });
  assert.deepEqual(dw.calls, [
    ['setVisibleOnAllWorkspaces', true, { visibleOnFullScreen: true }],
    ['setHiddenInMissionControl', true],
    ['setAlwaysOnTop', true, 'floating', -1],
  ]);
  const ww = createMockWindow();
  createWindowAdapter('win32').applyStealth(ww, { alwaysOnTop: true, alwaysOnTopLevel: 'floating', win32ReassertTopmost: true });
  assert.deepEqual(ww.calls, [['setAlwaysOnTop', true, 'screen-saver', undefined]]);
  // Catcher: no win32ReassertTopmost → win32 is a no-op (darwin-only original).
  const ww2 = createMockWindow();
  createWindowAdapter('win32').applyStealth(ww2, { alwaysOnTop: true });
  assert.deepEqual(ww2.calls, []);
});

test('applyNativeStealth / stopStealthTapOnShow: listeners on darwin only', () => {
  const d = createMockWindow();
  createWindowAdapter('darwin').applyNativeStealth(d);
  assert.ok(d.calls.some((c) => c[0] === 'once' && c[1] === 'ready-to-show'));
  const w = createMockWindow();
  createWindowAdapter('win32').applyNativeStealth(w);
  assert.ok(!has(w.calls, 'once'));
  const ds = createMockWindow();
  createWindowAdapter('darwin').stopStealthTapOnShow(ds);
  assert.ok(ds.calls.some((c) => c[0] === 'on' && c[1] === 'show'));
  const ws = createMockWindow();
  createWindowAdapter('win32').stopStealthTapOnShow(ws);
  assert.deepEqual(ws.calls, []);
});

test('reassertAlwaysOnTop / zeroOpacityForHide / setLauncherVibrancy / syncLauncherTaskbarPresence', () => {
  const w1 = createMockWindow();
  createWindowAdapter('win32').reassertAlwaysOnTop(w1);
  assert.deepEqual(w1.calls, [['setAlwaysOnTop', true, 'screen-saver', undefined]]);
  const d1 = createMockWindow();
  createWindowAdapter('darwin').reassertAlwaysOnTop(d1);
  assert.deepEqual(d1.calls, []);

  const w2 = createMockWindow();
  createWindowAdapter('win32').zeroOpacityForHide(w2);
  assert.deepEqual(w2.calls, [['setOpacity', 0]]);
  const d2 = createMockWindow();
  createWindowAdapter('darwin').zeroOpacityForHide(d2);
  assert.deepEqual(d2.calls, []);

  const d3 = createMockWindow();
  createWindowAdapter('darwin').setLauncherVibrancy(d3, true);
  assert.deepEqual(d3.calls, [['setVibrancy', null]]);
  const d3b = createMockWindow();
  createWindowAdapter('darwin').setLauncherVibrancy(d3b, false);
  assert.deepEqual(d3b.calls, [['setVibrancy', 'under-window']]);
  const w3 = createMockWindow();
  createWindowAdapter('win32').setLauncherVibrancy(w3, true);
  assert.deepEqual(w3.calls, []);

  const w4 = createMockWindow();
  createWindowAdapter('win32').syncLauncherTaskbarPresence(w4, true);
  assert.deepEqual(w4.calls, [['setSkipTaskbar', true]]);
  const w4b = createMockWindow();
  createWindowAdapter('win32').syncLauncherTaskbarPresence(w4b, false);
  assert.deepEqual(w4b.calls, [['setSkipTaskbar', false]]);
  const d4 = createMockWindow();
  createWindowAdapter('darwin').syncLauncherTaskbarPresence(d4, true);
  assert.deepEqual(d4.calls, []);
});

test('syncActivationPolicy: win32 re-applies CP + opacity-1 when visible; darwin no-op', () => {
  const wv = createMockWindow(); // visible: true
  createWindowAdapter('win32').syncActivationPolicy(wv, true);
  assert.deepEqual(wv.calls, [['setContentProtection', true], ['setOpacity', 1]]);
  const wh = createMockWindow(); wh.visible = false;
  createWindowAdapter('win32').syncActivationPolicy(wh, true);
  assert.deepEqual(wh.calls, [['setContentProtection', true]]);
  const d = createMockWindow();
  createWindowAdapter('darwin').syncActivationPolicy(d, true);
  assert.deepEqual(d.calls, []);
});

test('applyPopupReveal: darwin re-syncs workspace + guarded alwaysOnTop; win32 no-op', () => {
  const d = createMockWindow(); // alwaysOnTop: false initially
  createWindowAdapter('darwin').applyPopupReveal(d, true);
  assert.deepEqual(d.calls, [
    ['setVisibleOnAllWorkspaces', true, { visibleOnFullScreen: true }],
    ['setAlwaysOnTop', true, 'floating', undefined],
    ['setHiddenInMissionControl', true],
  ]);
  // Guard: when state already matches, no setAlwaysOnTop (avoids NSApp activation).
  const d2 = createMockWindow(); d2.alwaysOnTop = true;
  createWindowAdapter('darwin').applyPopupReveal(d2, true);
  assert.ok(!d2.calls.some((c) => c[0] === 'setAlwaysOnTop'), JSON.stringify(d2.calls));
  const w = createMockWindow();
  createWindowAdapter('win32').applyPopupReveal(w, true);
  assert.deepEqual(w.calls, []);
});

test('applyMultiMonitorSpan: win32 setBounds; darwin no-op', () => {
  const b = { x: -1, y: 0, width: 4000, height: 2000 };
  const w = createMockWindow();
  createWindowAdapter('win32').applyMultiMonitorSpan(w, b);
  assert.deepEqual(w.calls, [['setBounds', b]]);
  const d = createMockWindow();
  createWindowAdapter('darwin').applyMultiMonitorSpan(d, b);
  assert.deepEqual(d.calls, []);
});

test('showWithOpacityShield: win32 shield, gated direct, forceShield, darwin direct', async () => {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  // win32 + contentProtection → shield: zero all, show, CP, timer → opacity 1 + focus.
  const w1 = createMockWindow();
  createWindowAdapter('win32').showWithOpacityShield([w1], { activate: true, contentProtection: true, delayMs: 5, timer: { current: null } });
  assert.ok(has(w1.calls, 'setOpacity') && w1.calls.find((c) => c[0] === 'setOpacity')[1] === 0);
  assert.ok(has(w1.calls, 'setContentProtection'));
  await sleep(20);
  assert.ok(w1.calls.find((c) => c[0] === 'setOpacity' && c[1] === 1));
  assert.ok(has(w1.calls, 'focus'));

  // win32 + contentProtection:false (no forceShield) → direct, no setOpacity(0).
  const w2 = createMockWindow();
  createWindowAdapter('win32').showWithOpacityShield([w2], { activate: true, contentProtection: false, timer: { current: null } });
  assert.ok(!w2.calls.some((c) => c[0] === 'setOpacity' && c[1] === 0), JSON.stringify(w2.calls));
  assert.ok(has(w2.calls, 'show'));

  // win32 + forceShield (cropper) even with CP false → shield path.
  const w3 = createMockWindow();
  createWindowAdapter('win32').showWithOpacityShield([w3], { activate: true, contentProtection: false, forceShield: true, delayMs: 5, timer: { current: null } });
  assert.ok(w3.calls.find((c) => c[0] === 'setOpacity')[1] === 0, JSON.stringify(w3.calls));
  await sleep(20);

  // darwin → direct always.
  const d1 = createMockWindow();
  createWindowAdapter('darwin').showWithOpacityShield([d1], { activate: true, contentProtection: true, timer: { current: null } });
  assert.ok(!d1.calls.some((c) => c[0] === 'setOpacity'), JSON.stringify(d1.calls));
  assert.ok(has(d1.calls, 'setContentProtection'));
  assert.ok(has(d1.calls, 'show'));

  // activate:false → showInactive + NO focus in every path.
  const w4 = createMockWindow();
  createWindowAdapter('win32').showWithOpacityShield([w4], { activate: false, contentProtection: true, delayMs: 5, timer: { current: null } });
  assert.ok(has(w4.calls, 'showInactive') && !has(w4.calls, 'show') && !has(w4.calls, 'focus'));
  await sleep(20);

  // reassertTopmost → setAlwaysOnTop('screen-saver') on win32 shield reveal.
  const w5 = createMockWindow();
  createWindowAdapter('win32').showWithOpacityShield([w5], { activate: true, contentProtection: true, reassertTopmost: true, delayMs: 5, timer: { current: null } });
  await sleep(20);
  assert.ok(w5.calls.some((c) => c[0] === 'setAlwaysOnTop' && c[1] === true && c[2] === 'screen-saver'));

  // Per-helper timer slot: a second call clears the first pending restore.
  const w6 = createMockWindow();
  const slot = { current: null };
  createWindowAdapter('win32').showWithOpacityShield([w6], { activate: true, contentProtection: true, delayMs: 1000, timer: slot });
  createWindowAdapter('win32').showWithOpacityShield([w6], { activate: true, contentProtection: true, delayMs: 5, timer: slot });
  await sleep(30);
  assert.ok(w6.calls.some((c) => c[0] === 'setOpacity' && c[1] === 1), 'second shield must reveal');
});

test('predicates', () => {
  assert.equal(createWindowAdapter('darwin').mayStealFocusOnLauncherShow(), true);
  assert.equal(createWindowAdapter('win32').mayStealFocusOnLauncherShow(), false);
  assert.equal(createWindowAdapter('darwin').shouldHideToTrayOnClose(), false);
  assert.equal(createWindowAdapter('win32').shouldHideToTrayOnClose(), true);
  assert.equal(createWindowAdapter('darwin').managedGroupDragDefault(), false);
  assert.equal(createWindowAdapter('win32').managedGroupDragDefault(), true);
});
