// ============================================================================
// IPC: Settings flags (Phase 2).
// Boolean/settings toggle handlers: open-at-login, verbose-logging, ambient
// chat, pill visibility, overlay-on-start, auto-answer, code verification,
// meeting retention, provider data scopes, screen-understanding, technical
// interview vision-first. Copied verbatim from ipcHandlers.ts (appState →
// deps; SettingsManager stays a singleton import).
// ============================================================================

import { app, BrowserWindow } from 'electron';
import { safeHandle } from './safeIpc';
import { SettingsManager } from '../services/SettingsManager';
import { mergeProviderDataScopes } from '../llm/ProviderRouter';

export interface SettingsFlagsDeps {
  getVerboseLogging(): boolean;
  setVerboseLogging(v: boolean): void;
  getAmbientChatEnabled(): boolean;
  setAmbientChatEnabled(v: boolean): void;
  getPillAlwaysVisible(): boolean;
  setPillAlwaysVisible(v: boolean): void;
  getHideOverlayOnStart(): boolean;
  setHideOverlayOnStart(v: boolean): void;
  getAutoAnswerEnabled(): boolean;
  setAutoAnswerEnabled(v: boolean): boolean;
}

export function registerSettingsFlagHandlers(deps: SettingsFlagsDeps): void {
  safeHandle('set-open-at-login', async (_event, openAtLogin: boolean) => {
    app.setLoginItemSettings({
      openAtLogin,
      openAsHidden: false,
      path: app.getPath('exe'), // Explicitly point to executable for production reliability
    });
    return { success: true };
  });

  safeHandle('get-open-at-login', async () => {
    const settings = app.getLoginItemSettings();
    return settings.openAtLogin;
  });

  safeHandle('get-verbose-logging', async () => {
    return deps.getVerboseLogging();
  });

  safeHandle('set-verbose-logging', async (_event, enabled: boolean) => {
    deps.setVerboseLogging(enabled);
    return { success: true };
  });

  safeHandle('get-ambient-chat-enabled', async () => {
    return deps.getAmbientChatEnabled();
  });

  safeHandle('set-ambient-chat-enabled', async (_event, enabled: boolean) => {
    deps.setAmbientChatEnabled(enabled);
    return { success: true };
  });

  safeHandle('get-pill-always-visible', async () => {
    return deps.getPillAlwaysVisible();
  });

  safeHandle('set-pill-always-visible', async (_event, enabled: boolean) => {
    deps.setPillAlwaysVisible(Boolean(enabled));
    return { success: true };
  });

  safeHandle('get-hide-overlay-on-start', async () => {
    return deps.getHideOverlayOnStart();
  });

  safeHandle('set-hide-overlay-on-start', async (_event, enabled: boolean) => {
    deps.setHideOverlayOnStart(Boolean(enabled));
    return { success: true };
  });

  safeHandle('get-auto-answer-enabled', async () => {
    return deps.getAutoAnswerEnabled();
  });

  safeHandle('set-auto-answer-enabled', async (_event, enabled: boolean) => {
    const persisted = deps.setAutoAnswerEnabled(Boolean(enabled));
    return persisted
      ? { success: true }
      : { success: false, error: 'Settings store is unavailable; the change was not saved.' };
  });

  safeHandle('get-code-verification', async () => {
    // Default OFF: code verification is currently disabled. Only true when the
    // user has explicitly opted in via Settings → General or env override.
    const v = SettingsManager.getInstance().get('codeVerificationEnabled');
    return v === true;
  });

  safeHandle('set-code-verification', async (_event, enabled: boolean) => {
    if (typeof enabled !== 'boolean') {
      return { success: false, error: 'invalid_type' };
    }
    if (!SettingsManager.getInstance().set('codeVerificationEnabled', enabled)) {
      // R-24: the write was refused (degraded settings store). Returning
      // success — and broadcasting below — put every window on a value disk
      // never received, which silently reverted on the next launch.
      return { success: false, error: 'settings_store_degraded' };
    }
    try {
      BrowserWindow.getAllWindows().forEach((win) => {
        if (!win.isDestroyed()) {
          win.webContents.send('code-verification-changed', enabled);
        }
      });
    } catch { /* broadcasting is best-effort */ }
    return { success: true };
  });

  safeHandle('get-meeting-retention', async () => {
    return SettingsManager.getInstance().get('meetingRetention') ?? 'forever';
  });

  safeHandle('set-meeting-retention', async (_event, retention: 'forever' | '7d' | '30d' | 'never') => {
    if (!['forever', '7d', '30d', 'never'].includes(retention)) {
      return { success: false, error: 'invalid_retention' };
    }
    if (!SettingsManager.getInstance().set('meetingRetention', retention)) {
      // R-24: the write was refused (degraded settings store).
      return { success: false, error: 'settings_store_degraded' };
    }
    BrowserWindow.getAllWindows().forEach((win) => {
      if (!win.isDestroyed()) {
        win.webContents.send('meeting-retention-changed', retention);
      }
    });
    return { success: true };
  });

  safeHandle('get-provider-data-scopes', async () => {
    return SettingsManager.getInstance().get('providerDataScopes') ?? {};
  });

  safeHandle('set-provider-data-scopes', async (_event, scopes: Record<string, boolean>) => {
    if (!scopes || typeof scopes !== 'object') {
      return { success: false, error: 'invalid_scopes' };
    }
    // MERGE over the stored policy, using the ONE scope list in ProviderRouter.
    const settings = SettingsManager.getInstance();
    const merged = mergeProviderDataScopes(settings.get('providerDataScopes'), scopes);
    if (!settings.set('providerDataScopes', merged as any)) {
      // R-24: the write was refused (degraded settings store).
      return { success: false, error: 'settings_store_degraded' };
    }
    BrowserWindow.getAllWindows().forEach((win) => {
      if (!win.isDestroyed()) {
        // Broadcast the MERGED object, not the incoming payload.
        win.webContents.send('provider-data-scopes-changed', merged);
      }
    });
    return { success: true };
  });

  safeHandle('get-screen-understanding-mode', async () => {
    return SettingsManager.getInstance().getScreenUnderstandingMode();
  });

  safeHandle(
    'set-screen-understanding-mode',
    async (_event, mode: 'vision_first' | 'vision_only' | 'private_vision') => {
      if (!['vision_first', 'vision_only', 'private_vision'].includes(mode)) {
        return { success: false, error: 'invalid_mode' };
      }
      // CR-04: report the REAL outcome.
      if (!SettingsManager.getInstance().setScreenUnderstandingMode(mode)) {
        return { success: false, error: 'settings_store_degraded' };
      }
      BrowserWindow.getAllWindows().forEach((win) => {
        if (!win.isDestroyed()) {
          win.webContents.send('screen-understanding-mode-changed', mode);
        }
      });
      return { success: true };
    },
  );

  safeHandle('get-technical-interview-vision-first', async () => {
    return SettingsManager.getInstance().getTechnicalInterviewVisionFirst();
  });

  safeHandle('set-technical-interview-vision-first', async (_event, enabled: boolean) => {
    if (typeof enabled !== 'boolean') {
      return { success: false, error: 'invalid_value' };
    }
    if (!SettingsManager.getInstance().set('technicalInterviewVisionFirst', enabled)) {
      // R-24: the write was refused (degraded settings store).
      return { success: false, error: 'settings_store_degraded' };
    }
    BrowserWindow.getAllWindows().forEach((win) => {
      if (!win.isDestroyed()) {
        win.webContents.send('technical-interview-vision-first-changed', enabled);
      }
    });
    return { success: true };
  });
}
