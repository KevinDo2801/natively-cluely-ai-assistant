// Source-contract regression tests for the "always-visible TopPill" feature.
//
// Requirement (Settings > Overlay → "Always Show TopPill"): with the setting
// on, the overlay TopPill stays floating while the LAUNCHER is visible — even
// with no meeting running — so it is always there to summon the no-audio AI
// chatbox. Clicking the pill's expand/toggle while idle opens (or closes) the
// overlay WITHOUT starting a meeting; its stop button returns to the launcher.
//
// Load-bearing details these tests pin:
//   1. The setting is persistent (AppSettings) and lives in AppState.
//   2. WindowHelper keeps the pill up standalone in launcher mode, and on
//      macOS UN-WELDS it (parent.hide() drags children down with the shell),
//      re-welding it the moment a meeting starts (switchToOverlay).
//   3. The overlay-mirroring paths are untouched when the setting is off —
//      every pre-existing visibility invariant (see
//      OverlayAuxVisibilityOrdering.test.mjs) must keep holding.
//   4. Standalone drags move the pill alone (the shell is hidden), clamped
//      into the work area.
//   5. Idle pill actions are intercepted in the overlay-ui-action IPC and
//      never reach the overlay renderer's meeting handlers.
//   6. Stealth wins: undetectable mode suppresses the floating pill.
//   7. The overlay renderer hides meeting-only quick actions while idle.
//
// Strategy mirrors OverlayAuxVisibilityOrdering.test.mjs: source-contract
// assertions, because window ordering/visibility is exactly what a
// well-meaning refactor silently drops.

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
const ipc = read('electron/ipcHandlers.ts');
const settings = read('electron/services/SettingsManager.ts');
const preload = read('electron/preload.ts');
const electronDts = read('src/types/electron.d.ts');
const settingsOverlay = read('src/components/SettingsOverlay.tsx');
const nativelyInterface = read('src/components/NativelyInterface.tsx');

function extractMethodBody(source, methodName) {
  const re = new RegExp(
    `(?:public|private|protected)\\s+(?:async\\s+)?${methodName}\\s*\\([^)]*\\)\\s*(?::[^{]*)?\\{`,
  );
  const m = re.exec(source);
  assert.ok(m, `could not locate ${methodName}`);
  let i = m.index + m[0].length;
  let depth = 1;
  const start = i;
  while (i < source.length && depth > 0) {
    const ch = source[i];
    if (ch === '{') depth++;
    else if (ch === '}') depth--;
    i++;
  }
  assert.equal(depth, 0, `unbalanced braces in ${methodName}`);
  return source.slice(start, i - 1);
}

// ── 1. Persistent setting ───────────────────────────────────────────────────

test('AppSettings declares pillAlwaysVisible', () => {
  assert.match(
    settings,
    /pillAlwaysVisible\?: boolean;/,
    'the setting must be persisted in SettingsManager so it survives restarts',
  );
});

test('AppState loads, exposes and persists pillAlwaysVisible', () => {
  assert.match(
    main,
    /private _pillAlwaysVisible: boolean = false;/,
    'AppState must carry the runtime flag',
  );
  assert.match(
    main,
    /this\._pillAlwaysVisible = settingsManager\.get\('pillAlwaysVisible'\) \?\? false;/,
    'AppState must load the setting at construction',
  );
  const getter = extractMethodBody(main, 'getPillAlwaysVisible');
  assert.match(getter, /return this\._pillAlwaysVisible;/);
  const setter = extractMethodBody(main, 'setPillAlwaysVisible');
  assert.match(
    setter,
    /SettingsManager\.getInstance\(\)\.set\('pillAlwaysVisible', enabled\)/,
    'the setter must persist through SettingsManager (R-15 degradation guard)',
  );
  assert.match(
    setter,
    /this\.windowHelper\?\.setPillAlwaysVisible\(enabled\)/,
    'toggling the setting must flow through WindowHelper.setPillAlwaysVisible — ' +
      'it sets the flag that syncPillAlwaysVisibility reads. Calling sync ' +
      'directly consults the STALE flag and silently no-ops ("toggle does ' +
      'nothing until restart"), which was the live bug this test pins.',
  );
});

// ── 2. WindowHelper standalone-pill lifecycle ───────────────────────────────

test('WindowHelper seeds the flag and re-evaluates standalone visibility', () => {
  const seeder = extractMethodBody(main, 'setPillAlwaysVisible');
  assert.ok(seeder, 'AppState.setPillAlwaysVisible must exist');
  const setter = extractMethodBody(windowHelper, 'setPillAlwaysVisible');
  assert.match(
    setter,
    /this\.pillAlwaysVisible = enabled;/,
    'WindowHelper must cache the flag so swap paths can consult it synchronously',
  );
  assert.match(
    setter,
    /this\.syncPillAlwaysVisibility\(\)/,
    'seeding must re-evaluate the pill state immediately',
  );
});

test('syncPillAlwaysVisibility hides the standalone pill when off or undetectable', () => {
  const sync = extractMethodBody(windowHelper, 'syncPillAlwaysVisibility');
  assert.match(
    sync,
    /if \(!this\.pillAlwaysVisible \|\| this\.appState\.getUndetectable\(\)\)/,
    'a permanently floating pill would defeat undetectable/stealth mode — stealth must win',
  );
  assert.match(
    sync,
    /this\.setPillStandalone\(false\);/,
    'setting off (or stealth on) must never leave the pill floating standalone',
  );
  // With the setting on, the pill floats whenever the overlay is NOT the
  // visible surface — including when the whole UI is hidden (tray).
  assert.match(
    sync,
    /overlayVisible\) \{\s*\n\s*\/\/ The shell is up[\s\S]{0,160}this\.setPillStandalone\(false\);/,
    'the group path owns the pill while the overlay is visible',
  );
  assert.match(
    sync,
    /else \{\s*\n\s*\/\/ Launcher visible OR the whole UI hidden[\s\S]{0,160}this\.setPillStandalone\(true\);/,
    'with the setting on, the pill must float whenever the overlay is not the ' +
      'visible surface — INCLUDING when the whole UI is hidden (tray)',
  );
});

test('setPillStandalone un-welds on macOS and re-welds when the shell returns', () => {
  const body = extractMethodBody(windowHelper, 'setPillStandalone');
  assert.match(
    body,
    /if \(this\.pillStandalone === want\) return;/,
    'standalone transitions must be idempotent',
  );
  // Entering standalone: detach the AppKit child so parent.hide() cannot take
  // the pill down with the shell (parent.hide() hides children — measured).
  assert.match(
    body,
    /if \(this\.overlayGroupWelded\) \{\s*\n\s*try \{\s*\n\s*pill\.setParentWindow\(null\);/,
    'macOS must un-weld the pill before floating it standalone',
  );
  assert.match(
    body,
    /pill\.showInactive\(\);/,
    'standalone show must not steal OS focus (ghost/stealth invariant)',
  );
  // Leaving standalone: re-weld so the group path owns an intact child.
  assert.match(
    body,
    /pill\.setParentWindow\(this\.overlayWindow\);/,
    'macOS must re-weld the pill before the overlay shows again',
  );
});

test('switchToOverlay leaves standalone mode before the group show', () => {
  const overlay = extractMethodBody(windowHelper, 'switchToOverlay');
  const leave = overlay.indexOf('this.setPillStandalone(false)');
  assert.notEqual(leave, -1, 'switchToOverlay must leave standalone mode');
  const groupShow = overlay.indexOf('this.applyOverlayAuxVisibility(true)');
  assert.ok(
    leave < groupShow,
    'the re-weld must happen BEFORE the group show, or the pill lags the shell',
  );
});

test('switchToLauncher re-floats the pill after the overlay hides', () => {
  const launcher = extractMethodBody(windowHelper, 'switchToLauncher');
  // The pre-existing hide-before-launcher-show invariant must remain intact
  // (pinned by OverlayAuxVisibilityOrdering.test.mjs) — the standalone show
  // must come AFTER the overlay hide, at the very end of the swap.
  const overlayHide = launcher.indexOf('this.overlayWindow.hide()');
  const standaloneSync = launcher.lastIndexOf('this.syncPillAlwaysVisibility()');
  assert.notEqual(standaloneSync, -1, 'switchToLauncher must re-evaluate the pill');
  assert.ok(
    overlayHide < standaloneSync,
    'the pill must be re-floated only AFTER the overlay is down, so no frame ' +
      'paints the pill over the launcher mid-swap',
  );
});

test('hideOverlay keeps the standalone pill up; hideMainWindow takes it down (screenshot)', () => {
  // hideOverlay = stealth / the pill's "Hide" button: the overlay body goes
  // down but the always-visible pill must survive to summon it again.
  const hideOverlayBody = extractMethodBody(windowHelper, 'hideOverlay');
  assert.match(
    hideOverlayBody,
    /this\.applyOverlayAuxVisibility\(false\);/,
    'hideOverlay must still take the pill/toggle down with the body (pinned)',
  );
  assert.match(
    hideOverlayBody,
    /this\.syncPillAlwaysVisibility\(\);/,
    'hideOverlay must re-float the standalone pill after hiding the body',
  );
  // hideMainWindow feeds screenshot capture — the pill must be DOWN for the
  // captured frame (the 80ms compositor flush would leak it otherwise).
  assert.match(
    extractMethodBody(windowHelper, 'hideMainWindow'),
    /this\.setPillStandalone\(false\);/,
    'hideMainWindow must leave standalone mode (screenshot-safe)',
  );
  // User-facing hide (Cmd+B / tray) re-floats it right after.
  const toggle = extractMethodBody(windowHelper, 'toggleMainWindow');
  assert.match(
    toggle,
    /this\.hideMainWindow\(\);[\s\S]{0,220}this\.syncPillAlwaysVisibility\(\);/,
    'Cmd+B / tray hide must re-float the always-visible pill',
  );
});

test('pushPillState stamps overlay/meeting state and runs at every settle point', () => {
  const push = extractMethodBody(windowHelper, 'pushPillState');
  assert.match(
    push,
    /overlayVisible: !!overlay && !overlay\.isDestroyed\(\) && overlay\.isVisible\(\)/,
    'the pill needs live overlay visibility for its Ask/Hide label',
  );
  assert.match(
    push,
    /meetingActive: this\.appState\.getIsMeetingActive\(\)/,
    'the pill needs live meeting state for its mic/stop icon',
  );
  // Every visibility-change settle point must refresh the aux state.
  for (const method of [
    'switchToOverlay',
    'switchToLauncher',
    'hideOverlay',
    'showOverlay',
    'hideMainWindow',
    'createOverlayAuxWindows',
  ]) {
    assert.match(
      extractMethodBody(windowHelper, method),
      /this\.pushPillState\(\);/,
      `${method} must refresh the aux windows' overlay/meeting state`,
    );
  }
});

test('the overlay hide-event backstop cannot take the standalone pill down', () => {
  // The overlay 'hide' event handler routes through syncOverlayAuxVisibility
  // (pinned by OverlayAuxVisibilityOrdering). With the pill floating
  // standalone, a derived hide (OS-driven hide, any future ui-state relay)
  // must re-assert the pill instead of stranding it hidden.
  const sync = extractMethodBody(windowHelper, 'syncOverlayAuxVisibility');
  assert.match(
    sync,
    /this\.pillStandalone && !want\) \{\s*\n\s*const pill = this\.pillWindow;[\s\S]{0,120}!pill\.isVisible\(\)\) pill\.showInactive\(\);/,
    'a derived hide must re-assert a floating standalone pill',
  );
});

// ── 3. Standalone drag ──────────────────────────────────────────────────────

test('the group drag targets the pill when the shell is hidden (standalone)', () => {
  const target = extractMethodBody(windowHelper, 'groupDragTarget');
  assert.match(
    target,
    /if \(overlay && !overlay\.isDestroyed\(\) && overlay\.isVisible\(\)\) return overlay;/,
    'the shell wins while visible; otherwise the pill is the drag target',
  );
  assert.match(target, /return this\.pillWindow;/);

  const begin = extractMethodBody(windowHelper, 'beginOverlayGroupDrag');
  assert.match(
    begin,
    /const target = this\.groupDragTarget\(\);/,
    'drag start must anchor on the actual target window',
  );

  const move = extractMethodBody(windowHelper, 'moveOverlayGroupTo');
  assert.match(
    move,
    /const isOverlay = target === this\.overlayWindow;/,
    'the move path must branch on which window is being dragged',
  );
  assert.match(
    move,
    /this\.clampedGroupOrigin\(origin\.x \+ offsetX, origin\.y \+ offsetY\)/,
    'the overlay path must keep the pinned anchored+clamped group move',
  );
  assert.match(
    move,
    /this\.clampedPillOrigin\(target, origin\.x \+ offsetX, origin\.y \+ offsetY\)/,
    'the standalone path must clamp the pill into the work area on its own',
  );
  assert.ok(
    !move.includes('o.x + dx'),
    'no relative-delta arithmetic may return to the drag path',
  );

  const end = extractMethodBody(windowHelper, 'endOverlayGroupDrag');
  assert.match(
    end,
    /this\.clampOverlayGroupIntoWorkArea\(\)/,
    'the overlay settle must stay for the group path',
  );
  assert.match(
    end,
    /Standalone pill: settle it into the work area on its own/,
    'standalone drag release must settle the pill',
  );
});

// ── 4. Idle pill actions (IPC) ──────────────────────────────────────────────

test('overlay-ui-action intercepts pill actions by meeting state', () => {
  const handler = ipc.slice(ipc.indexOf("safeHandle('overlay-ui-action'"));
  assert.ok(handler.length > 0, 'overlay-ui-action handler not found');
  const body = handler.slice(0, handler.indexOf('safeHandle', 10));
  assert.match(
    body,
    /if \(!appState\.getIsMeetingActive\(\)\) \{/,
    'the idle branch must be gated on meeting state',
  );
  // Idle toggle-expand: opens the no-audio AI chatbox (show the overlay on
  // top) or closes it — the LAUNCHER window is never touched by Ask/Hide.
  assert.match(
    body,
    /action\.type === 'toggle-expand'/,
    'the Ask/Hide pill button must be intercepted while idle',
  );
  assert.match(
    body,
    /if \(overlayVisible\) \{\s*\n\s*helper\.hideOverlay\(\);\s*\n\s*\} else \{\s*\n\s*helper\.showOverlay\(\);/,
    'idle Ask/Hide must show/hide ONLY the overlay — never the launcher',
  );
  assert.doesNotMatch(
    body,
    /helper\.setWindowMode\(/,
    'Ask/Hide must be fully independent of the launcher window — the launcher ' +
      'appears only via the pill logo / tray icon',
  );
  // Idle start-meeting: the mic button starts a REAL meeting (recording).
  assert.match(
    body,
    /action\.type === 'start-meeting'[\s\S]{0,240}appState\.startMeeting\(\)\.catch/,
    'the mic button must start a real meeting through the lifecycle queue',
  );
  // Meeting-active toggle-expand: Ask/Hide stealth-hides / re-shows the
  // meeting overlay (recording continues) instead of collapsing a panel.
  assert.match(
    body,
    /\} else if \(action\.type === 'toggle-expand'\) \{\s*\n[\s\S]{0,480}if \(overlayVisible\) \{\s*\n\s*helper\.hideOverlay\(\);/,
    'during a meeting, Hide must hide the overlay (meeting keeps recording)',
  );
  assert.match(
    body,
    /\} else \{\s*\n\s*helper\.showOverlay\(\);/,
    'during a meeting, Ask must re-show the overlay without touching the launcher',
  );
  assert.match(
    body,
    /helper\.forwardOverlayUiAction\(action\);/,
    'unhandled actions must still reach the overlay renderer unchanged',
  );
});

test('showOverlay leaves standalone mode so the pill joins the shell', () => {
  const show = extractMethodBody(windowHelper, 'showOverlay');
  assert.match(
    show,
    /this\.setPillStandalone\(false\);/,
    'showing the overlay must re-weld the pill (macOS) / join the group path',
  );
  assert.match(
    show,
    /this\.applyOverlayAuxVisibility\(true\);/,
    'showOverlay must still bring the aux chrome up with the body (pinned)',
  );
});

test('TopPill renders mic (idle) / stop (recording) and Ask/Hide labels', () => {
  const pill = read('src/components/ui/TopPill.tsx');
  assert.match(
    pill,
    /meetingActive: boolean;/,
    'the pill must know meeting state to pick mic vs stop icon',
  );
  assert.match(
    pill,
    /overlayVisible: boolean;/,
    'the pill must know overlay visibility to pick Ask vs Hide label',
  );
  assert.match(
    pill,
    /\{overlayVisible \? "Hide" : "Ask"\}/,
    'center label: Hide while the overlay is visible, Ask while hidden',
  );
  assert.match(
    pill,
    /#1592EA/,
    'Ask (overlay hidden) must render on the brand-blue chip background',
  );
  assert.match(
    pill,
    /"#ffffff"/,
    'Ask glyphs (label + chevron) must be white on the blue chip',
  );
  assert.match(
    pill,
    /overlayVisible\s*\?\s*appearance\.chipStyle/,
    'Hide (overlay visible) must restore the default chip style',
  );
  assert.match(
    pill,
    /\{meetingActive \? \(/,
    'the action button must branch on recording state',
  );
  assert.match(
    pill,
    /<Mic className="w-4 h-4" strokeWidth=\{2\} \/>/,
    'idle must show a MIC icon (a square reads as "recording")',
  );
  assert.match(
    pill,
    /w-3\.5 h-3\.5 rounded-\[3px\] bg-current opacity-80/,
    'recording must show the square/stop icon',
  );
});

test('OverlayPillWindow wires meeting state and the new action semantics', () => {
  const aux = read('src/components/OverlayAuxWindows.tsx');
  assert.match(
    aux,
    /onMeetingStateChanged\?\.\(/,
    'the pill must subscribe to the meeting-state broadcast (reaches all windows)',
  );
  assert.match(
    aux,
    /sendAction\(meetingActive \? 'end-meeting' : 'start-meeting'\)/,
    'mic → start-meeting while idle; stop → end-meeting while recording',
  );
  assert.match(
    aux,
    /overlayVisible=\{state\.overlayVisible === true\}/,
    'the Ask/Hide label must come from the pushed overlay-visibility state',
  );
  assert.match(
    aux,
    /overlayVisible\?: boolean;/,
    'OverlayUiState must carry overlay visibility',
  );
});

test('screenshot restore re-floats the pill (it floats even while hidden)', () => {
  assert.match(
    main,
    /this\.windowHelper\.syncPillAlwaysVisibility\(\);/,
    'restoreWindowsAfterScreenshot must bring the pill back even when no main ' +
      'window was restored (always-visible pill floats while the app is hidden)',
  );
  assert.match(
    ipc,
    /safeHandle\('hide-window'[\s\S]{0,420}syncPillAlwaysVisibility\(\);/,
    'the hide-window IPC must leave the always-visible pill floating',
  );
});

test('launcher close hides to tray and keeps the always-visible pill (dev too)', () => {
  // Closing the launcher window used to QUIT the app in dev ("no hide-to-tray
  // in dev", 2026-07-10). That kills the always-visible pill with the whole
  // app. It must now hide-to-tray on BOTH dev and packaged builds.
  const closeBlock = windowHelper.slice(
    windowHelper.indexOf("this.launcherWindow.on('close'"),
    windowHelper.indexOf("this.launcherWindow.on('close'") + 1200,
  );
  assert.match(
    closeBlock,
    /if \(!this\.appState\.isQuitting\(\)\) \{/,
    'tray Quit (isQuitting) must still close the window for real',
  );
  assert.match(
    closeBlock,
    /this\.launcherWindow\?\.hide\(\);[\s\S]{0,260}this\.syncPillAlwaysVisibility\(\);/,
    'closing the launcher window must leave the always-visible pill floating',
  );
  assert.doesNotMatch(
    closeBlock,
    /if \(isDev\) \{\s*\n\s*\/\/ Let the close proceed and quit/,
    'dev must no longer quit on window close — the pill must survive',
  );
});

test('get/set-pill-always-visible IPC handlers exist', () => {
  assert.match(ipc, /safeHandle\('get-pill-always-visible'/);
  assert.match(
    ipc,
    /safeHandle\('set-pill-always-visible', async \(_, enabled: boolean\) => \{\s*\n\s*appState\.setPillAlwaysVisible\(Boolean\(enabled\)\);/,
  );
});

// ── 5. Preload + renderer types ─────────────────────────────────────────────

test('preload and renderer types expose the setting IPC', () => {
  assert.match(preload, /getPillAlwaysVisible: \(\) => Promise<boolean>;/);
  assert.match(preload, /setPillAlwaysVisible: \(enabled: boolean\) => Promise<\{ success: boolean \}>;/);
  assert.match(preload, /getPillAlwaysVisible: \(\) => ipcRenderer\.invoke\('get-pill-always-visible'\)/);
  assert.match(preload, /setPillAlwaysVisible: \(enabled: boolean\) => ipcRenderer\.invoke\('set-pill-always-visible', enabled\)/);
  assert.match(electronDts, /getPillAlwaysVisible: \(\) => Promise<boolean>;/);
  assert.match(electronDts, /setPillAlwaysVisible: \(enabled: boolean\) => Promise<\{ success: boolean \}>;/);
});

test('Settings > Overlay renders the Always Show TopPill toggle', () => {
  assert.match(
    settingsOverlay,
    /const \[pillAlwaysVisible, setPillAlwaysVisible\] = useState\(false\);/,
  );
  assert.match(
    settingsOverlay,
    /window\.electronAPI\?\.getPillAlwaysVisible\?\.\(\)\.then\(setPillAlwaysVisible\)/,
    'the toggle must load its initial state from main',
  );
  assert.match(
    settingsOverlay,
    /\{t\('Always Show TopPill'\)\}/,
    'the toggle row must be visible in the UI',
  );
  assert.match(
    settingsOverlay,
    /window\.electronAPI\?\.setPillAlwaysVisible\?\.\(newState\)/,
    'flipping the toggle must persist through main',
  );
});

// ── 6. Overlay renderer: hide meeting-only quick actions while idle ─────────

test('NativelyInterface gates the quick-action row on meeting state', () => {
  assert.match(
    nativelyInterface,
    /const \[meetingActive, setMeetingActive\] = useState\(true\);/,
    'meeting UI must be the default so it never flickers out during a start',
  );
  assert.match(
    nativelyInterface,
    /getMeetingActive\?\.\(\)/,
    'the overlay must probe the authoritative meeting state on mount',
  );
  assert.match(
    nativelyInterface,
    /onMeetingStateChanged\?\.\(\(data: \{ isActive: boolean \}\) =>/,
    'the overlay must stay in sync with every meeting start/stop broadcast',
  );
  assert.match(
    nativelyInterface,
    /\{meetingActive && \(\s*\n\s*<div\s*\n\s*className=\{`flex flex-nowrap justify-center items-center gap-1\.5 px-4 pb-3/,
    'the quick-action row (What to answer / Clarify / Recap / Follow-up / ' +
      'Answer) must be hidden while no meeting is active — those actions are ' +
      'voice/meeting-dependent and would fail silently in the no-audio chatbox',
  );
});
