// ============================================================================
// WindowAdapter — platform-agnostic window behavior (Phase 1).
//
// Collects every `process.platform` branch that the four window helpers
// (WindowHelper, CropperWindowHelper, SettingsWindowHelper,
// ModelSelectorWindowHelper) used to scatter inline (~41 of 44 reads move
// here; the 3 linux-only guards stay in the helpers). One source of truth per
// platform, contract-tested on any host via injected platform.
//
// See docs/refactor/phase-1-window-adapter-design.md for the full branch
// catalog and divergence findings.
// ============================================================================

import type { BrowserWindow, BrowserWindowConstructorOptions } from 'electron';

export type LauncherDisguise = 'none' | 'terminal' | 'settings' | 'activity';

/** Per-helper timer holder — preserves today's per-helper opacityTimeout semantics. */
export interface TimerSlot {
  current: NodeJS.Timeout | null;
}

export interface ApplyStealthOptions {
  visibleOnAllWorkspaces?: boolean;   // darwin: setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true })
  hiddenInMissionControl?: boolean;   // darwin: setHiddenInMissionControl(true)
  alwaysOnTop?: boolean;
  alwaysOnTopLevel?: 'floating' | 'screen-saver'; // darwin level
  alwaysOnTopRelativeLevel?: number;  // darwin 3rd arg (popover catcher: -1)
  win32ReassertTopmost?: boolean;     // win32: re-assert setAlwaysOnTop(true, 'screen-saver')
}

export interface RevealOptions {
  activate: boolean;                  // focus after reveal; false => showInactive, no focus
  contentProtection: boolean;         // tracked CP value; win32 shields only when true (unless forceShield)
  forceShield?: boolean;              // cropper: shield on win32 even when CP is false
  restoreOpacity?: boolean;           // WindowHelper: direct path re-applies opacity 1
  reassertTopmost?: boolean;          // overlay only: win32 re-asserts 'screen-saver'
  onRevealed?: () => void;            // runs synchronously right after show()/showInactive()
  delayMs?: number;                   // shield restore delay (cropper env-tunable; default 60)
  timer: TimerSlot;                   // per-helper timer slot
}

export interface WindowAdapter {
  readonly platform: 'darwin' | 'win32';

  launcherWindowOptions(): Partial<BrowserWindowConstructorOptions>;
  panelWindowOptions(): Partial<BrowserWindowConstructorOptions>;      // { type: 'panel' } | {}
  cropperWindowOptions(): Partial<BrowserWindowConstructorOptions>;    // { enableLargerThanScreen: true } | { type: 'toolbar' }
  launcherIconPath(mode: LauncherDisguise, isPackaged: boolean): string;

  applyStealth(win: BrowserWindow, opts?: ApplyStealthOptions): void;
  applyNativeStealth(win: BrowserWindow): void;   // darwin registers once('ready-to-show'); win32 no-op
  stopStealthTapOnShow(win: BrowserWindow): void; // darwin registers 'show' listener; win32 no-op
  reassertAlwaysOnTop(win: BrowserWindow): void;  // win32 'screen-saver'; darwin no-op
  zeroOpacityForHide(win: BrowserWindow): void;   // win32 setOpacity(0); darwin no-op
  setLauncherVibrancy(win: BrowserWindow, previewing: boolean): void;
  syncLauncherTaskbarPresence(win: BrowserWindow, undetectable: boolean): void;
  syncActivationPolicy(win: BrowserWindow, contentProtection: boolean): void;
  applyPopupReveal(win: BrowserWindow, visible: boolean): void;        // model-selector show-time darwin re-sync
  applyMultiMonitorSpan(win: BrowserWindow, bounds: Electron.Rectangle): void; // cropper win32 setBounds
  // Nullable windows accepted: the helpers hold BrowserWindow | null fields;
  // live (non-null, non-destroyed) entries are used.
  showWithOpacityShield(windows: (BrowserWindow | null)[], opts: RevealOptions): void;

  isMac(): boolean;
  isWindows(): boolean;
  mayStealFocusOnLauncherShow(): boolean;   // darwin true / win32 false
  shouldHideToTrayOnClose(): boolean;       // darwin false / win32 true
  managedGroupDragDefault(): boolean;       // darwin false / win32 true
}
