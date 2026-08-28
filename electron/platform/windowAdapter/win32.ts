import path from 'node:path';
import type { BrowserWindow, BrowserWindowConstructorOptions } from 'electron';
import type { WindowAdapter, ApplyStealthOptions, RevealOptions, LauncherDisguise } from './types';
import { disguiseIconName } from './shared';

/**
 * Windows WindowAdapter.
 *
 * Dev icon base mirrors the darwin side: `../../../assets` from this module's
 * compiled location resolves to <root>/assets.
 */
export function createWin32WindowAdapter(): WindowAdapter {
  return {
    platform: 'win32',

    launcherWindowOptions() {
      return {
        frame: false,
        titleBarOverlay: false,
        autoHideMenuBar: true,
      } as Partial<BrowserWindowConstructorOptions>;
    },
    panelWindowOptions() { return {}; },
    cropperWindowOptions() {
      return { enableLargerThanScreen: true } as Partial<BrowserWindowConstructorOptions>;
    },

    launcherIconPath(mode: LauncherDisguise, isPackaged: boolean): string {
      const devBase = path.resolve(__dirname, '../../../assets');
      const appIcon = isPackaged
        ? path.join(process.resourcesPath, 'assets/icons/win/icon.ico')
        : path.join(devBase, 'icons/win/icon.ico');
      const name = disguiseIconName(mode);
      if (!name) return appIcon;
      return isPackaged
        ? path.join(process.resourcesPath, `assets/fakeicon/win/${name}`)
        : path.join(devBase, `fakeicon/win/${name}`);
    },

    applyStealth(win: BrowserWindow, opts: ApplyStealthOptions = {}) {
      // 'floating' (HWND_TOPMOST) loses to fullscreen browser windows;
      // 'screen-saver' wins (issue #167). The catcher path deliberately omits
      // win32ReassertTopmost to stay darwin-only, matching the original.
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

    showWithOpacityShield(windows: (BrowserWindow | null)[], opts: RevealOptions) {
      const live = windows.filter((w): w is BrowserWindow => !!w && !w.isDestroyed());
      const primary = live[0];
      if (!primary) return;
      const {
        activate,
        contentProtection,
        restoreOpacity,
        reassertTopmost,
        forceShield,
        onRevealed,
        delayMs = 60,
        timer,
      } = opts;
      if (contentProtection || forceShield) {
        // DWM frame-leak shield: show at opacity 0, apply CP, let DWM process,
        // then reveal. Guards the primary + group windows together.
        //
        // CP value: use `contentProtection` (not a hardcoded true) so the
        // cropper (forceShield, may run with CP off) keeps its exact behavior
        // — Settings/Model/WindowHelper only enter this branch when their CP
        // is already true, so they are unaffected.
        for (const w of live) w.setOpacity(0);
        if (activate) primary.show(); else primary.showInactive();
        onRevealed?.();
        primary.setContentProtection(contentProtection);
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
