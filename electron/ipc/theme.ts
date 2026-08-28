// ============================================================================
// IPC: Theme handlers (Phase 2 exemplar).
//
// The pattern for every domain module split out of ipcHandlers.ts:
//   • a narrow `Deps` interface listing ONLY the methods the handlers need
//     (never the whole AppState), and
//   • a `registerXHandlers(deps)` that owns its channels via safeHandle/safeOn.
// initializeIpcHandlers() calls it with the real `appState` accessor.
// ============================================================================

import { safeHandle } from './safeIpc';
import type { ThemeManager } from '../ThemeManager';

export interface ThemeDeps {
  getThemeManager(): ThemeManager;
}

export function registerThemeHandlers(deps: ThemeDeps): void {
  safeHandle('theme:get-mode', () => {
    const tm = deps.getThemeManager();
    return {
      mode: tm.getMode(),
      resolved: tm.getResolvedTheme(),
    };
  });

  safeHandle('theme:set-mode', (_event, mode: 'system' | 'light' | 'dark') => {
    deps.getThemeManager().setMode(mode);
    return { success: true };
  });
}
