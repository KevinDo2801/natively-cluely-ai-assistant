# WindowAdapter Extraction — Complete Design Document

**Phase 1 prep (READ-ONLY) — approved refactor: extract a `WindowAdapter` from the four window helpers.**

- Repo: `D:\Code\natively-cluely-ai-assistant` (production Electron app, macOS + Windows)
- Status: design only. **No source file was edited to produce this document.**
- Source files in scope:
  - `electron/WindowHelper.ts` — 3,140 lines (not 2,937; line numbers below verified against HEAD), 23× `process.platform`
  - `electron/CropperWindowHelper.ts` — 694 lines, 8×
  - `electron/SettingsWindowHelper.ts` — 429 lines, 6×
  - `electron/ModelSelectorWindowHelper.ts` — 354 lines, 7×
- Style template: `electron/platform/macosVersion.ts` (injectable params, contract test in `electron/platform/__tests__/macosVersion.test.mjs` — compiled `dist-electron` via `createRequire`).

---

## 1. Branch catalog (all 44 `process.platform` reads)

### 1.1 WindowHelper.ts (23)

| Lines | Branch | darwin value | win32 value | Adapter method |
|---|---|---|---|---|
| 322 | `!== 'win32'` early-return | no-op | `setSkipTaskbar(!!undetectable)` (try/catch) | `syncLauncherTaskbarPresence(win, undetectable)` |
| 505, 525–530 | `=== 'darwin'` | `titleBarStyle:'hiddenInset'` + `trafficLightPosition:{x:14,y:14}` + `vibrancy:'under-window'` + `visualEffectState:'followWindow'` | `frame:false` + `titleBarOverlay:false` + `autoHideMenuBar:true` | `launcherWindowOptions()` |
| 550–551, 549–597 | `=== 'darwin'` / `'win32'` | `natively.icns`, fakeicon `mac/` | `icons/win/icon.ico`, fakeicon `win/` | `launcherIconPath(mode, isPackaged)` |
| 823 | `=== 'darwin' \|\| 'win32'` | **identical both** (register overlay as stealth sink) | — keep in helper (test-pinned) — |
| 833–875 / 876–882 | `=== 'darwin'` else `'win32'` | `setVisibleOnAllWorkspaces(true,{visibleOnFullScreen:true})` + `setHiddenInMissionControl(true)` + `setAlwaysOnTop(true,'floating')` + ready-to-show native stealth | `setAlwaysOnTop(true,'screen-saver')` only | `applyStealth(win,{…})` + `applyNativeStealth(win)` |
| 1088 | `!== 'darwin'` | no close-interception | close→hide-to-tray + maximize/unmaximize sync | `shouldHideToTrayOnClose()` |
| 1178–1183 | `=== 'win32'` (blur listener) | none | re-assert `setAlwaysOnTop(true,'screen-saver')` on blur | `reassertAlwaysOnTop(win)` |
| 1277–1285 | `=== 'win32'` | none | `setOpacity(0)` on launcher/overlay/pill/toggle pre-hide | `zeroOpacityForHide(win)` ×4 |
| 1332 | `!== 'linux'` | **true both** — linux-only guard | — keep in helper — |
| 1497, 1518 | `=== 'darwin'` | `type:'panel'` | `{}` | `panelWindowOptions()` |
| 1521–1527 | `=== 'darwin'` | vOaW + `setHiddenInMissionControl(true)` + `setAlwaysOnTop(true,'floating',-1)` **(relativeLevel −1)** | none | `applyStealth(catcher,{…,alwaysOnTopRelativeLevel:-1})` |
| 1562, 1583 | `=== 'darwin'` | `type:'panel'` | `{}` | `panelWindowOptions()` |
| 1599–1611 | weld/drag flags | `welded` (env-gated) | env-gated managed drag | `isMac()` + `managedGroupDragDefault()` |
| 1622–1641 | `=== 'darwin'` else `'win32'` | vOaW + MC + `'floating'` + native stealth | `setAlwaysOnTop(true,'screen-saver')` | `applyStealth(win,{…,win32ReassertTopmost:true})` + `applyNativeStealth(win)` |
| 2344–2346 | `=== 'win32'` (showOverlay) | none | re-assert `'screen-saver'` pre-show | `reassertAlwaysOnTop(win)` |
| 2473, 2476, 2489 | `=== 'darwin'` | `setVibrancy(null)` / `('under-window')` | none | `setLauncherVibrancy(win, previewing)` |
| 2609–2661 | `=== 'win32' && contentProtection` | restore opacity + CP + show + aux-visible + focus | **group opacity shield** (3 windows, one 60 ms timer, CP(true), topmost re-assert) | `showWithOpacityShield(windows[], opts)` |
| 2650 | `=== 'win32'` (inside else) | — | topmost re-assert pre-show | folded into win32 direct path (`reassertTopmost`) |
| 2724–2745 | `=== 'win32' && contentProtection` | restore + CP + show + focus | launcher shield | `showWithOpacityShield([launcher], opts)` |
| 2774 | `=== 'darwin'` | `app.focus({steal:true})` allowed | never | `mayStealFocusOnLauncherShow()` |
| 2800 | `=== 'darwin'` | dock-stealth re-assert | none | `isMac()` gate |

### 1.2 CropperWindowHelper.ts (8)

| Lines | Branch | darwin | win32 | Adapter method |
|---|---|---|---|---|
| 415–434 | `=== 'win32'` | CP + show + focus | **unconditional** shield: opacity 0 → show → CP → 60 ms → opacity 1 + focus | `showWithOpacityShield([win],{forceShield:true,delayMs:…})` |
| 474–478 | `=== 'win32'` | `type:'toolbar'` | `enableLargerThanScreen:true` | `cropperWindowOptions()` |
| 500–507 | `=== 'win32'` | none | `setBounds(combinedBounds)` span | `applyMultiMonitorSpan(win, bounds)` |
| 514–517 | `=== "darwin"` | vOaW + `setAlwaysOnTop(true,'screen-saver')` **(no MC, level differs)** | none | `applyStealth(win,{visibleOnAllWorkspaces:true,alwaysOnTop:true,alwaysOnTopLevel:'screen-saver'})` |
| 530–541 | `=== 'darwin'` (ready-to-show) | native stealth | none | `applyNativeStealth(win)` |
| 552–560 | `!== 'darwin'` (show) | stop stealth tap | none | `stopStealthTapOnShow(win)` |
| 610 | `=== 'linux'` | hide (reuse) | opacity 0 + hide | **keep** linux branch; `zeroOpacityForHide(win)` + `hide()` |
| 618 | `=== 'win32'` | — | `setOpacity(0)` pre-hide | part of `zeroOpacityForHide(win)` |

### 1.3 SettingsWindowHelper.ts (6) / ModelSelectorWindowHelper.ts (7)

| Lines (S / M) | Branch | darwin | win32 | Adapter method |
|---|---|---|---|---|
| 246, 273 / 166, 197 | `=== 'darwin'` | `type:'panel'` | `{}` | `panelWindowOptions()` |
| 291–295 / 213–216 | `=== "darwin"` | S: vOaW + MC + `'floating'`; M: **MC only** | none | `applyStealth(win,{…})` |
| 317–328 / 244–255 | `=== 'darwin'` (ready-to-show) | native stealth | none | `applyNativeStealth(win)` |
| 352–370 / 284–293 | `!== 'darwin'` (show) | stop stealth tap | none | `stopStealthTapOnShow(win)` |
| 156–172 / 103–119 | `=== 'win32' && contentProtection` | CP + show/showInactive + focus | shield (CP-gated) | `showWithOpacityShield([win],opts)` |
| 421–428 / 346–353 | `!== 'win32'` | no-op | CP + opacity 1 if visible | `syncActivationPolicy(win, cp)` |
| — / 72–83 | `=== "darwin"` (show-time) | vOaW(isOverlay) + **guarded** alwaysOnTop + MC | none | `applyPopupReveal(win, visible)` |

**Summary:** all 44 mapped — **41 move into the adapter; 3 intentionally stay** (WindowHelper:823 both-platform; WindowHelper:1332 linux-only; Cropper:610 linux-only).

---

## 2. Divergence findings (blocks that look alike but differ)

1. **CropperWindowHelper.ts:415** — win32 shield is **unconditional**; Settings:156 / ModelSelector:103 / WindowHelper:2609,2724 gate on `contentProtection`. → `forceShield` flag.
2. **CropperWindowHelper.ts:514–517** — darwin level is `'screen-saver'` (not `'floating'`) **and omits** `setHiddenInMissionControl`. Unique.
3. **WindowHelper.ts:1527** — catcher uses `setAlwaysOnTop(true,'floating',-1)`; only caller of the relativeLevel third arg.
4. **ModelSelectorWindowHelper.ts:72–83 vs SettingsWindowHelper.ts:291–295** — Model re-syncs vOaW/alwaysOnTop **per show** with an `isAlwaysOnTop()` change guard (avoids NSApp activation); Settings sets once at creation. Different methods (`applyPopupReveal` vs `applyStealth`).
5. **WindowHelper.ts:2344/2634/2650** — win32 re-asserts topmost at show; Settings/Model/Cropper **never** do. → `reassertTopmost` opt-in (default off).
6. **WindowHelper.ts:2640–2642, 2740** — direct path restores opacity 1; Settings/Model direct paths don't (nothing was zeroed). → `restoreOpacity` opt-in.
7. **WindowHelper.ts:2609–2637** — group shield (3 windows, **one** timer); Settings/Model/Cropper single-window. → `windows[]` + per-helper timer slot (a shared adapter timer would let a second shield clear the first's pending restore — behavior change).
8. **CropperWindowHelper.ts:424** — delay from `CROPPER_CONFIG.OPACITY_DELAY_MS` (env-tunable); others hardcode 60. → `delayMs` param.
9. **Byte-identical pairs (confirmations, prime contract-test targets):** `syncActivationPolicy` Settings:421–428 ≡ Model:346–353; overlay vs aux darwin blocks WindowHelper:833–836 ≡ 1622–1625 and native-stealth 858–875 ≡ 1626–1638.

---

## 3. Adapter design

**Recommendation: `types.ts` + `shared.ts` + `darwin.ts` + `win32.ts` + `index.ts`** (not one `windowAdapter.ts`) — each platform side is ~120 lines of real behavior (stealth sequences + shields + icon paths), and CLAUDE.md's preferred structure is `feature/{index,types,shared,macos,windows}.ts`. Location: `electron/platform/windowAdapter/` (compiles to `dist-electron/electron/platform/windowAdapter/`, so the contract test follows the `macosVersion.test.mjs` createRequire pattern).

No runtime `electron` import (type-only) → contract tests load the compiled module under plain node. Lazy requires inside listeners only.

### 3.1 `electron/platform/windowAdapter/types.ts`

```ts
import type { BrowserWindow, BrowserWindowConstructorOptions } from 'electron';

export type LauncherDisguise = 'none' | 'terminal' | 'settings' | 'activity';

/** Per-helper timer holder — preserves today's per-helper opacityTimeout semantics. */
export interface TimerSlot { current: NodeJS.Timeout | null; }

export interface ApplyStealthOptions {
  visibleOnAllWorkspaces?: boolean;   // darwin: setVisibleOnAllWorkspaces(true,{visibleOnFullScreen:true})
  hiddenInMissionControl?: boolean;   // darwin: setHiddenInMissionControl(true)
  alwaysOnTop?: boolean;
  alwaysOnTopLevel?: 'floating' | 'screen-saver'; // darwin level
  alwaysOnTopRelativeLevel?: number;  // darwin 3rd arg (popover catcher: -1)
  win32ReassertTopmost?: boolean;     // win32: re-assert setAlwaysOnTop(true,'screen-saver')
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
  panelWindowOptions(): Partial<BrowserWindowConstructorOptions>;      // {type:'panel'} | {}
  cropperWindowOptions(): Partial<BrowserWindowConstructorOptions>;    // {enableLargerThanScreen:true} | {type:'toolbar'}
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
  showWithOpacityShield(windows: BrowserWindow[], opts: RevealOptions): void;

  isMac(): boolean;
  isWindows(): boolean;
  mayStealFocusOnLauncherShow(): boolean;   // darwin true / win32 false
  shouldHideToTrayOnClose(): boolean;       // darwin false / win32 true
  managedGroupDragDefault(): boolean;       // darwin false / win32 true
}
```

### 3.2 `electron/platform/windowAdapter/shared.ts`

```ts
export const DISGUISE_ICON_NAMES: Record<string, string> = {
  terminal: 'terminal.png',
  settings: 'settings.png',
  activity: 'activity.png',
};
export function disguiseIconName(mode: string): string | null {
  return DISGUISE_ICON_NAMES[mode] ?? null;
}
```

### 3.3 `electron/platform/windowAdapter/darwin.ts`

```ts
import path from 'node:path';
import type { BrowserWindow, BrowserWindowConstructorOptions } from 'electron';
import type { WindowAdapter, ApplyStealthOptions, RevealOptions, LauncherDisguise } from './types';
import { disguiseIconName } from './shared';

export function createDarwinWindowAdapter(): WindowAdapter {
  return {
    platform: 'darwin',

    launcherWindowOptions() {
      return {
        titleBarStyle: 'hiddenInset',
        trafficLightPosition: { x: 14, y: 14 },
        vibrancy: 'under-window',
        visualEffectState: 'followWindow',
      } as Partial<BrowserWindowConstructorOptions>;
    },
    panelWindowOptions() { return { type: 'panel' } as Partial<BrowserWindowConstructorOptions>; },
    cropperWindowOptions() { return { type: 'toolbar' } as Partial<BrowserWindowConstructorOptions>; },

    launcherIconPath(mode: LauncherDisguise, isPackaged: boolean): string {
      const devBase = path.resolve(__dirname, '../../../assets'); // dist-electron/assets
      const appIcon = isPackaged ? path.join(process.resourcesPath, 'natively.icns')
                                 : path.join(devBase, 'natively.icns');
      const name = disguiseIconName(mode);
      if (!name) return appIcon;
      return isPackaged
        ? path.join(process.resourcesPath, `assets/fakeicon/mac/${name}`)
        : path.join(devBase, `fakeicon/mac/${name}`);
    },

    applyStealth(win: BrowserWindow, opts: ApplyStealthOptions = {}) {
      if (opts.visibleOnAllWorkspaces) win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
      if (opts.hiddenInMissionControl) win.setHiddenInMissionControl(true);
      if (opts.alwaysOnTop) {
        win.setAlwaysOnTop(true, opts.alwaysOnTopLevel ?? 'floating', opts.alwaysOnTopRelativeLevel);
      }
    },
    applyNativeStealth(win: BrowserWindow) {
      win.once('ready-to-show', () => {
        if (win.isDestroyed()) return;
        try {
          // eslint-disable-next-line @typescript-eslint/no-var-requires
          const { loadNativeModule } = require('../../audio/nativeModuleLoader');
          const native = loadNativeModule();
          if (native && typeof native.applyStealthToWindow === 'function') {
            native.applyStealthToWindow(win.getNativeWindowHandle());
          }
        } catch { /* non-fatal: type:'panel' alone still keeps the dock out of the way */ }
      });
    },
    stopStealthTapOnShow(win: BrowserWindow) {
      win.on('show', () => {
        try {
          // eslint-disable-next-line @typescript-eslint/no-var-requires
          const { StealthKeyboardManager } = require('../services/StealthKeyboardManager');
          StealthKeyboardManager.getInstance().stop();
        } catch (e) { console.error('[WindowAdapter] failed to stop stealth tap on show:', e); }
      });
    },
    reassertAlwaysOnTop() { /* macOS: re-asserting setAlwaysOnTop triggers [NSApp activate] — never */ },
    zeroOpacityForHide() { /* macOS: zeroing opacity pre-hide re-registers the app as a regular window */ },
    setLauncherVibrancy(win: BrowserWindow, previewing: boolean) {
      win.setVibrancy(previewing ? null : 'under-window');
    },
    syncLauncherTaskbarPresence() { /* macOS stealth is the Dock path; forcing skipTaskbar would change behavior */ },
    syncActivationPolicy() { /* no win32 activation-policy flip on macOS */ },
    applyPopupReveal(win: BrowserWindow, visible: boolean) {
      win.setVisibleOnAllWorkspaces(visible, { visibleOnFullScreen: visible });
      if (win.isAlwaysOnTop() !== visible) win.setAlwaysOnTop(visible, 'floating');
      win.setHiddenInMissionControl(true);
    },
    applyMultiMonitorSpan() { /* macOS spans via fullscreenable + visibleOnAllWorkspaces */ },

    showWithOpacityShield(windows: BrowserWindow[], opts: RevealOptions) {
      const live = windows.filter((w): w is BrowserWindow => !!w && !w.isDestroyed());
      const primary = live[0];
      if (!primary) return;
      const { activate, contentProtection, restoreOpacity, onRevealed } = opts;
      if (restoreOpacity) for (const w of live) w.setOpacity(1);
      primary.setContentProtection(contentProtection);
      if (activate) primary.show(); else primary.showInactive();
      onRevealed?.();
      if (activate) primary.focus();
    },

    isMac: () => true,
    isWindows: () => false,
    mayStealFocusOnLauncherShow: () => true,
    shouldHideToTrayOnClose: () => false,
    managedGroupDragDefault: () => false, // welding implies managed drag
  };
}
```

### 3.4 `electron/platform/windowAdapter/win32.ts`

```ts
import path from 'node:path';
import type { BrowserWindow, BrowserWindowConstructorOptions } from 'electron';
import type { WindowAdapter, ApplyStealthOptions, RevealOptions, LauncherDisguise } from './types';
import { disguiseIconName } from './shared';

export function createWin32WindowAdapter(): WindowAdapter {
  return {
    platform: 'win32',

    launcherWindowOptions() {
      return { frame: false, titleBarOverlay: false, autoHideMenuBar: true } as Partial<BrowserWindowConstructorOptions>;
    },
    panelWindowOptions() { return {}; },
    cropperWindowOptions() { return { enableLargerThanScreen: true } as Partial<BrowserWindowConstructorOptions>; },

    launcherIconPath(mode: LauncherDisguise, isPackaged: boolean): string {
      const devBase = path.resolve(__dirname, '../../../assets'); // dist-electron/assets
      const appIcon = isPackaged ? path.join(process.resourcesPath, 'assets/icons/win/icon.ico')
                                 : path.join(devBase, 'icons/win/icon.ico');
      const name = disguiseIconName(mode);
      if (!name) return appIcon;
      return isPackaged
        ? path.join(process.resourcesPath, `assets/fakeicon/win/${name}`)
        : path.join(devBase, `fakeicon/win/${name}`);
    },

    applyStealth(win: BrowserWindow, opts: ApplyStealthOptions = {}) {
      // 'floating' (HWND_TOPMOST) loses to fullscreen browser windows; 'screen-saver' wins (issue #167).
      if (opts.win32ReassertTopmost) win.setAlwaysOnTop(true, 'screen-saver');
    },
    applyNativeStealth() { /* no NSPanel SPI on Windows — WS_EX_NOACTIVATE is attachNoActivate's job */ },
    stopStealthTapOnShow() { /* Windows keeps the hook; no per-window stop */ },
    reassertAlwaysOnTop(win: BrowserWindow) { win.setAlwaysOnTop(true, 'screen-saver'); },
    zeroOpacityForHide(win: BrowserWindow) { win.setOpacity(0); },
    setLauncherVibrancy() { /* no vibrancy API on Windows */ },
    syncLauncherTaskbarPresence(win: BrowserWindow, undetectable: boolean) {
      try { win.setSkipTaskbar(!!undetectable); }
      catch (e) { console.error('[WindowAdapter] setSkipTaskbar failed:', e); }
    },
    syncActivationPolicy(win: BrowserWindow, contentProtection: boolean) {
      win.setContentProtection(contentProtection);
      if (win.isVisible()) win.setOpacity(1);
    },
    applyPopupReveal() { /* Windows z-order handled by reassertAlwaysOnTop call sites */ },
    applyMultiMonitorSpan(win: BrowserWindow, bounds: Electron.Rectangle) { win.setBounds(bounds); },

    showWithOpacityShield(windows: BrowserWindow[], opts: RevealOptions) {
      const live = windows.filter((w): w is BrowserWindow => !!w && !w.isDestroyed());
      const primary = live[0];
      if (!primary) return;
      const { activate, contentProtection, restoreOpacity, reassertTopmost, forceShield, onRevealed, delayMs = 60, timer } = opts;
      if (contentProtection || forceShield) {
        // DWM frame-leak shield: show at opacity 0, apply CP, let DWM process, then reveal.
        for (const w of live) w.setOpacity(0);
        if (activate) primary.show(); else primary.showInactive();
        onRevealed?.();
        primary.setContentProtection(true);
        if (timer.current) clearTimeout(timer.current);
        timer.current = setTimeout(() => {
          timer.current = null;
          for (const w of live) if (!w.isDestroyed()) w.setOpacity(1);
          if (reassertTopmost) primary.setAlwaysOnTop(true, 'screen-saver');
          if (activate) primary.focus();
        }, delayMs);
      } else {
        if (restoreOpacity) for (const w of live) w.setOpacity(1);
        primary.setContentProtection(contentProtection);
        if (reassertTopmost) primary.setAlwaysOnTop(true, 'screen-saver'); // before show (issue #136)
        if (activate) primary.show(); else primary.showInactive();
        onRevealed?.();
        if (activate) primary.focus();
      }
    },

    isMac: () => false,
    isWindows: () => true,
    mayStealFocusOnLauncherShow: () => false,
    shouldHideToTrayOnClose: () => true,
    managedGroupDragDefault: () => true,
  };
}
```

### 3.5 `electron/platform/windowAdapter/index.ts`

```ts
import type { WindowAdapter } from './types';
import { createDarwinWindowAdapter } from './darwin';
import { createWin32WindowAdapter } from './win32';

export type { WindowAdapter, ApplyStealthOptions, RevealOptions, TimerSlot, LauncherDisguise } from './types';

export function createWindowAdapter(platform: NodeJS.Platform = process.platform): WindowAdapter {
  switch (platform) {
    case 'darwin': return createDarwinWindowAdapter();
    case 'win32': return createWin32WindowAdapter();
    default: throw new Error(`Unsupported platform: ${platform}`);
  }
}
```

### 3.6 Move-verbatim traps (must be handled during implementation)

- **Path adjustments:** the adapter lives one level deeper than the helpers (`dist-electron/electron/platform/windowAdapter/`), so dev icon paths become `../../../assets/...` (was `../../assets/...` from `dist-electron/electron/`), and the lazy requires become `../../audio/nativeModuleLoader` and `../services/StealthKeyboardManager`.
- **Listener-ordering invariant:** `applyNativeStealth(win)` must be called immediately after `new BrowserWindow(...)`, **before** the helper registers its own `once('ready-to-show')` — the adapter listener then fires first (stealth before show), preserving the consolidation intent documented at CropperWindowHelper.ts:488–496.

---

## 4. Extraction order + per-helper edit lists

**Order: Settings → ModelSelector → Cropper → WindowHelper** (not Cropper first): Settings is the smallest helper whose 6 branches are all *canonical* forms of the shared surface, so it validates 6 adapter methods at lowest risk. ModelSelector is the near-duplicate and converts with the identical edit pattern (adds only `applyPopupReveal`). Cropper is the *lowest-entanglement* helper (zero AppState/main references; constructors at main.ts:1554–1556 take no args), but it carries the divergent variants, so it goes after the pair derisks the canonical forms. WindowHelper last: 23 branches, AppState circular import, and it is the only helper whose extraction breaks a parity assertion.

Every helper gets:
- `private readonly adapter = createWindowAdapter();` (or optional constructor param `adapter: WindowAdapter = createWindowAdapter()` for future injection — default means main.ts:1553–1556 unchanged), and
- `opacityTimeout: NodeJS.Timeout | null` → `private readonly opacityTimer: TimerSlot = { current: null }` (all `clearTimeout(this.opacityTimeout)` → `clearTimeout(this.opacityTimer.current)`).

### 4.1 SettingsWindowHelper.ts (6 edits)

1. L273 `...(isMac ? { type: 'panel' as const } : {}),` → `...this.adapter.panelWindowOptions(),` (drop `isMac` at L246).
2. L291–295 → `this.adapter.applyStealth(this.settingsWindow, { visibleOnAllWorkspaces: true, hiddenInMissionControl: true, alwaysOnTop: true, alwaysOnTopLevel: 'floating' });`
3. L317–328 (native block inside ready-to-show) → delete; add `this.adapter.applyNativeStealth(this.settingsWindow);` right after `new BrowserWindow(windowSettings)` (L281).
4. L352–370 → keep `this.settingsWindow.on('show', () => { this.lastBlurTime = 0; });` and separately `this.adapter.stopStealthTapOnShow(this.settingsWindow);` (two listeners; ordering irrelevant — they are independent).
5. L156–172 → `this.adapter.showWithOpacityShield([this.settingsWindow], { activate, contentProtection: this.contentProtection, timer: this.opacityTimer });`
6. L421–428 → `this.adapter.syncActivationPolicy(this.settingsWindow, this.contentProtection);` (keep the null/destroyed guard at L423).

### 4.2 ModelSelectorWindowHelper.ts (7 edits — same pattern)

1. L197 → `...this.adapter.panelWindowOptions(),`
2. L213–216 → `this.adapter.applyStealth(this.window, { hiddenInMissionControl: true });`
3. L244–255 → delete from ready-to-show; add `this.adapter.applyNativeStealth(this.window);` after `new BrowserWindow` (L205).
4. L284–293 → `this.adapter.stopStealthTapOnShow(this.window);` (full replacement — that listener's only body was the darwin guard).
5. L72–83 → `this.adapter.applyPopupReveal(this.window, isOverlay);`
6. L103–119 → `this.adapter.showWithOpacityShield([this.window], { activate, contentProtection: this.contentProtection, timer: this.opacityTimer });`
7. L346–353 → `this.adapter.syncActivationPolicy(this.window, this.contentProtection);`

### 4.3 CropperWindowHelper.ts (7 edits)

1. L412–435 `applyOpacityShield` → `this.adapter.showWithOpacityShield([this.cropperWindow], { activate: true, contentProtection: this.isUndetectable, forceShield: true, delayMs: CROPPER_CONFIG.OPACITY_DELAY_MS, timer: this.opacityTimer });`
2. L474–478 → `Object.assign(windowSettings, this.adapter.cropperWindowOptions());`
3. L500–507 → `this.adapter.applyMultiMonitorSpan(this.cropperWindow, combinedBounds);`
4. L514–517 → `this.adapter.applyStealth(this.cropperWindow, { visibleOnAllWorkspaces: true, alwaysOnTop: true, alwaysOnTopLevel: 'screen-saver' });`
5. L530–541 → delete from ready-to-show; add `this.adapter.applyNativeStealth(this.cropperWindow);` right after `new BrowserWindow(windowSettings)` (L480) — **before** the L524 `once('ready-to-show')`.
6. L551–560 → `this.adapter.stopStealthTapOnShow(this.cropperWindow);`
7. L608–624 `hideOrClose` → keep the `linux` close branch; else branch → `this.adapter.zeroOpacityForHide(this.cropperWindow); this.cropperWindow.hide();` (drops the nested win32 branch).

### 4.4 WindowHelper.ts (21 edits)

1. Constructor: `constructor(appState: AppState, adapter: WindowAdapter = createWindowAdapter()) { this.appState = appState; this.adapter = adapter; }`
2. L322–331 → `const win = this.launcherWindow; if (!win || win.isDestroyed()) return; this.adapter.syncLauncherTaskbarPresence(win, !!this.appState.getUndetectable());`
3. L505 + L525–530 → `...this.adapter.launcherWindowOptions(),`
4. L549–597 icon IIFE → `icon: this.adapter.launcherIconPath(this.appState.getDisguise(), app.isPackaged),`
5. L823–831 **unchanged**.
6. L833–883 → `this.adapter.applyStealth(this.overlayWindow, { visibleOnAllWorkspaces: true, hiddenInMissionControl: true, alwaysOnTop: true, alwaysOnTopLevel: 'floating', win32ReassertTopmost: true }); this.adapter.applyNativeStealth(this.overlayWindow);`
7. L1088 → `if (this.adapter.shouldHideToTrayOnClose()) {`
8. L1178–1183 → register the blur listener unconditionally; body → `this.adapter.reassertAlwaysOnTop(this.overlayWindow);` (keep the isDestroyed/isVisible guards).
9. L1277–1285 → `for (const w of [this.launcherWindow, this.overlayWindow, this.pillWindow, this.toggleWindow]) this.adapter.zeroOpacityForHide(w);`
10. L1332 **unchanged** (linux-only).
11. L1518 → `...this.adapter.panelWindowOptions(),`; L1521–1527 → `this.adapter.applyStealth(this.popoverCatcher, { visibleOnAllWorkspaces: true, hiddenInMissionControl: true, alwaysOnTop: true, alwaysOnTopLevel: 'floating', alwaysOnTopRelativeLevel: -1 });` (**no** `win32ReassertTopmost` — preserves darwin-only original).
12. L1583 → `...this.adapter.panelWindowOptions(),`
13. L1599–1611 → `this.overlayGroupWelded = this.adapter.isMac() && process.env.NATIVELY_OVERLAY_WINDOW_GROUP !== '0';` and `this.overlayGroupDragManaged = this.overlayGroupWelded || (this.adapter.managedGroupDragDefault() && process.env.NATIVELY_OVERLAY_GROUP_DRAG !== '0');`
14. L1622–1641 → `this.adapter.applyStealth(win, { visibleOnAllWorkspaces: true, hiddenInMissionControl: true, alwaysOnTop: true, alwaysOnTopLevel: 'floating', win32ReassertTopmost: true }); this.adapter.applyNativeStealth(win);`
15. L2344–2346 → `this.adapter.reassertAlwaysOnTop(this.overlayWindow);`
16. L2473/2476/2489 → `this.adapter.setLauncherVibrancy(this.launcherWindow, active);` … `(false)`.
17. L2609–2661 → `this.adapter.showWithOpacityShield([this.overlayWindow, this.pillWindow, this.toggleWindow], { activate: !inactive, contentProtection: this.contentProtection, restoreOpacity: true, reassertTopmost: true, timer: this.opacityTimer, onRevealed: () => this.applyOverlayAuxVisibility(true) });` — the entire if/else collapses; `this.isWindowVisible = true;` and the launcher-hide/pushPillState stay.
18. L2724–2745 → `this.adapter.showWithOpacityShield([this.launcherWindow], { activate: !inactive, contentProtection: this.contentProtection, restoreOpacity: true, timer: this.opacityTimer });`
19. L2774 → `if (this.adapter.mayStealFocusOnLauncherShow() && !inactive && !wasLauncher && !this.appState.getUndetectable()) {`
20. L2800 → `if (this.adapter.isMac() && this.appState.getUndetectable()) {`
21. opacityTimer slot (L204, L2627, L2731, L2879, L3135).

---

## 5. Test design

**New file: `electron/platform/__tests__/windowAdapter.test.mjs`** — follow `macosVersion.test.mjs`: `createRequire` → `dist-electron/electron/platform/windowAdapter/index.js`; inject `'darwin'`/`'win32'`; both branches run on any host; **no process.platform mutation**. The adapter has no runtime electron imports, so the compiled module loads under plain node; windows are mocks.

```js
// electron/platform/__tests__/windowAdapter.test.mjs
// Run: npm run build:electron && ELECTRON_RUN_AS_NODE=1 electron --test
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
  assert.ok(d.launcherIconPath('none', false).endsWith(path.join('assets', 'natively.icns')));
  assert.ok(w.launcherIconPath('none', false).endsWith(path.join('assets', 'icons', 'win', 'icon.ico')));
  assert.ok(d.launcherIconPath('terminal', false).includes(path.join('fakeicon', 'mac')));
  assert.ok(w.launcherIconPath('activity', false).includes(path.join('fakeicon', 'win')));
  assert.ok(w.launcherIconPath('bogus', false).endsWith('icon.ico')); // unknown → app icon
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
  const ww2 = createMockWindow();
  createWindowAdapter('win32').applyStealth(ww2, { alwaysOnTop: true }); // catcher: no re-assert
  assert.deepEqual(ww2.calls, []);
});

test('applyNativeStealth / stopStealthTapOnShow: listeners on darwin only', () => {
  const d = createMockWindow();
  createWindowAdapter('darwin').applyNativeStealth(d);
  assert.ok(has(d.calls, 'once') && d.calls.find((c) => c[1] === 'ready-to-show'));
  const w = createMockWindow();
  createWindowAdapter('win32').applyNativeStealth(w);
  assert.ok(!has(w.calls, 'once'));
  const ds = createMockWindow();
  createWindowAdapter('darwin').stopStealthTapOnShow(ds);
  assert.ok(ds.calls.find((c) => c[0] === 'on' && c[1] === 'show'));
  const ws = createMockWindow();
  createWindowAdapter('win32').stopStealthTapOnShow(ws);
  assert.deepEqual(ws.calls, []);
});

test('reassertAlwaysOnTop / zeroOpacityForHide / setLauncherVibrancy / syncLauncherTaskbarPresence', () => {
  // win32 → ['setAlwaysOnTop',true,'screen-saver']; darwin → no calls
  // win32 zeroOpacityForHide → ['setOpacity',0]; darwin → none
  // darwin setLauncherVibrancy(win,true) → ['setVibrancy',null]; (false) → ['setVibrancy','under-window']; win32 → none
  // syncLauncherTaskbarPresence(win,true/false) → ['setSkipTaskbar',true/false] on win32; none on darwin
});

test('syncActivationPolicy: win32 re-applies CP + opacity-1 when visible; darwin no-op', () => {
  // win32 visible → ['setContentProtection',true],['setOpacity',1]; win32 hidden → CP only; darwin → none
});

test('applyPopupReveal: darwin re-syncs workspace + guarded alwaysOnTop; win32 no-op', () => {
  // darwin visible=true, alwaysOnTop=false → vOaW(true,{visibleOnFullScreen:true}), setAlwaysOnTop(true,'floating'), MC(true)
  // darwin visible=false while isAlwaysOnTop()===false → NO setAlwaysOnTop (guard!)
  // win32 → no calls
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
  // win32 + contentProtection:true → zero all, show, setContentProtection(true), timer(60)→ opacity 1 + focus
  // win32 + contentProtection:false (no forceShield) → direct: setContentProtection(false), show, focus — NO setOpacity(0)
  // win32 + forceShield:true + contentProtection:false (cropper) → shield path with CP(false)
  // darwin → direct always: CP(value), show/showInactive, focus when activate
  // activate:false → showInactive + NO focus in every path
  // reassertTopmost → setAlwaysOnTop before/at reveal on win32 only
  // timer slot: a second call clears the first timer (per-helper semantics)
  // (real timers with delayMs:5 + await sleep(20); or t.mock.timers where the runner's Node supports it)
});

test('predicates', () => {
  assert.equal(createWindowAdapter('darwin').mayStealFocusOnLauncherShow(), true);
  assert.equal(createWindowAdapter('win32').mayStealFocusOnLauncherShow(), false);
  assert.equal(createWindowAdapter('darwin').shouldHideToTrayOnClose(), false);
  assert.equal(createWindowAdapter('win32').shouldHideToTrayOnClose(), true);
  assert.equal(createWindowAdapter('darwin').managedGroupDragDefault(), false);
  assert.equal(createWindowAdapter('win32').managedGroupDragDefault(), true);
});
```

### 5.1 WindowsPlatformParity subsumption map

This file is the one whose assertions the contract tests replace. It was executed at HEAD under plain `node --test` (it is pure source-regex — no electron import): **21 pass / 1 fail**. The only WindowHelper-dependent test is *"undetectable: the launcher leaves the Windows taskbar, at creation AND on toggle"* (L159–191):

- L167–172 (`process.platform !== 'win32') return` guard) → **subsumed** by `syncLauncherTaskbarPresence` darwin-no-op / win32-behavior test.
- L173–177 (`setSkipTaskbar(!!this.appState.getUndetectable())`) → **subsumed** by the same test (undetectable→skipTaskbar mapping).
- L180–184 (creation-time application regex over WindowHelper.ts) → **NOT subsumed** — it pins helper wiring; rewrite the regex to the new call (`syncLauncherTaskbarPresence(` appearing between `setContentProtection(this.contentProtection)` and the load).
- L186–190 (main.ts call site `this.windowHelper.syncLauncherTaskbarForStealth();`) → **NOT subsumed**; survives unchanged (public method name kept).

The **pre-existing HEAD failure** is a different test: *"security(round2): chat:focusInput branches on pre-show state, not toggle()"* (L342–360). The regex demands `const wasStealthActive = ...;\s*\n\s*this.showMainWindow`, but HEAD's main.ts legitimately branches launcher mode to `this.revealOverlayForGlobalShortcut()` (main.ts:1987+). It is unrelated to window adapters and should **not** be subsumed — fix the regex to accept either call.

**InterfaceThemeAllowlist.test.mjs** is unrelated (theme IPC allowlist); it is only an example of the brittle brace-extraction source-regex *style*. The new contract tests instead follow the `macosVersion.test.mjs` compiled-module pattern; InterfaceThemeAllowlist stays as-is.

**Other tests that must keep passing** (verified non-platform regexes that survive): `windowsFocusPolicy.test.mjs:236–246` pins the WindowHelper:823 both-platform guard — this is why L823 stays in the helper. `SetContentProtectionDedupe`, `OverlayAuxVisibilityOrdering`, `PillAlwaysVisible`, `SettingsAnchorDeterministic`, `launcherAspect`/`launcherResizeAnimation`, `CropperWindowHelper.bounds/RefitsOnShow/DisposeClosesWindow` all target logic that stays in the helpers.

---

## 6. Risks — branches depending on runtime state (stay in the helpers, param-ized)

1. **Cropper display geometry** (CropperWindowHelper.ts:349–395, 444–445): combined-bounds refit + cursor-display HUD — `screen.*` runtime. Only the *whether-to-span* is platform (`applyMultiMonitorSpan`).
2. **`ensureVisibleOnScreen` workArea clamps** (Settings:377–394, Model:296–322): pure runtime, no branch — stay.
3. **`getDisplayWorkArea` + all overlay/pill/toggle clamp geometry** (WindowHelper:266–277, 1760–1952): runtime — stay.
4. **Launcher icon** (WindowHelper:549–597): disguise mode (`appState.getDisguise()`) + `app.isPackaged` passed as parameters.
5. **`syncLauncherTaskbarForStealth`**: undetectable value passed as parameter.
6. **`app.focus({steal:true})` gate** (WindowHelper:2774): `inactive`/`wasLauncher`/`getUndetectable()` stay; adapter supplies only `mayStealFocusOnLauncherShow()`.
7. **Dock-stealth re-assert** (WindowHelper:2800): `getUndetectable()` stays; adapter supplies `isMac()`.
8. **ModelSelector show-time darwin sync** (Model:72–83): `isOverlay` passed to `applyPopupReveal(win, isOverlay)`.
9. **Opacity-shield timing**: 60 ms + cropper env delay passed as `delayMs`; per-helper `TimerSlot` preserves the "second shield doesn't cancel the first helper's restore" semantics.
10. **`forwardSupported`** (WindowHelper:1332) and **cropper linux hide** (Cropper:610): linux-only — intentionally remain `process.platform` reads (the adapter factory throws on linux per CLAUDE.md's exhaustive-switch contract; supported matrix is macOS+Windows).
11. **Catcher win32 micro-delta**: `applyStealth` without `win32ReassertTopmost` preserves the darwin-only original exactly; do NOT add the flag there.
12. **Relative paths / lazy requires** in the moved code must be adjusted for the deeper module dir (§3.6) — the most likely silent-breakage point; contract test 3 covers the dev icon paths.
13. **ready-to-show ordering**: `applyNativeStealth` must be registered before each helper's own listener (edit lists call this out at each site).
14. Out of scope but noted: main.ts:1570 has its own `win32 || darwin` gate (cropper `preload()`); the adapter could serve main.ts later, but this refactor is helper-scoped.

**Validation matrix:** `Covered by automated darwin-branch tests` + `Covered by automated Windows-branch tests` (windowAdapter.test.mjs, both branches on any host); `Reviewed but not executed on macOS` / `Reviewed but not executed on Windows` for the native `applyStealthToWindow` call path (lazy, requires the rebuilt native module); physical verification still required for shield timing and DWM/topmost behavior on both OSes.
