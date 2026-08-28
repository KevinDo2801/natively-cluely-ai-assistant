import path from 'node:path';
import type { BrowserWindow, BrowserWindowConstructorOptions } from 'electron';
import type { WindowAdapter, ApplyStealthOptions, RevealOptions, LauncherDisguise } from './types';
import { disguiseIconName } from './shared';

/**
 * macOS WindowAdapter.
 *
 * Dev icon base: this module compiles to dist-electron/electron/platform/windowAdapter/,
 * so `../../../assets` resolves to <root>/assets (mirrors the helpers' own
 * `../../assets` from dist-electron/electron/).
 */
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
      const devBase = path.resolve(__dirname, '../../../assets');
      const appIcon = isPackaged
        ? path.join(process.resourcesPath, 'natively.icns')
        : path.join(devBase, 'natively.icns');
      const name = disguiseIconName(mode);
      if (!name) return appIcon;
      return isPackaged
        ? path.join(process.resourcesPath, `assets/fakeicon/mac/${name}`)
        : path.join(devBase, `fakeicon/mac/${name}`);
    },

    applyStealth(win: BrowserWindow, opts: ApplyStealthOptions = {}) {
      if (opts.visibleOnAllWorkspaces) {
        win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
      }
      if (opts.hiddenInMissionControl) win.setHiddenInMissionControl(true);
      if (opts.alwaysOnTop) {
        win.setAlwaysOnTop(true, opts.alwaysOnTopLevel ?? 'floating', opts.alwaysOnTopRelativeLevel);
      }
    },

    applyNativeStealth(win: BrowserWindow) {
      win.once('ready-to-show', () => {
        if (win.isDestroyed()) return;
        try {
          // Lazy require: native module is heavy and only needed at show time.
          // eslint-disable-next-line @typescript-eslint/no-var-requires
          const { loadNativeModule } = require('../../audio/nativeModuleLoader');
          const native = loadNativeModule();
          if (native && typeof native.applyStealthToWindow === 'function') {
            native.applyStealthToWindow(win.getNativeWindowHandle());
          }
        } catch {
          /* non-fatal: type:'panel' alone still keeps the dock out of the way */
        }
      });
    },

    stopStealthTapOnShow(win: BrowserWindow) {
      win.on('show', () => {
        try {
          // eslint-disable-next-line @typescript-eslint/no-var-requires
          const { StealthKeyboardManager } = require('../../services/StealthKeyboardManager');
          StealthKeyboardManager.getInstance().stop();
        } catch (e) {
          console.error('[WindowAdapter] failed to stop stealth tap on show:', e);
        }
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
      // Guard: only re-assert when the current state differs (avoids an
      // NSApp activation churn on every show).
      if (win.isAlwaysOnTop() !== visible) win.setAlwaysOnTop(visible, 'floating');
      win.setHiddenInMissionControl(true);
    },
    applyMultiMonitorSpan() { /* macOS spans via fullscreenable + visibleOnAllWorkspaces */ },

    showWithOpacityShield(windows: (BrowserWindow | null)[], opts: RevealOptions) {
      // macOS: no DWM frame-leak problem; reveal directly, honoring CP + focus.
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
