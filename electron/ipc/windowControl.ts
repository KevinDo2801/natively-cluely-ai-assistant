// ============================================================================
// IPC: Window movement + controls (Phase 2).
// Thin wrappers over AppState / WindowHelper — see the pattern in ipc/theme.ts.
// ============================================================================

import { safeHandle } from './safeIpc';

export interface WindowControlDeps {
  moveWindowLeft(): void;
  moveWindowRight(): void;
  moveWindowUp(): void;
  moveWindowDown(): void;
  centerAndShowWindow(): void;
  getWindowHelper(): {
    minimizeWindow(): void;
    maximizeWindow(): void;
    closeWindow(): void;
    isMainWindowMaximized(): boolean;
  };
}

export function registerWindowControlHandlers(deps: WindowControlDeps): void {
  // Window movement handlers
  safeHandle('move-window-left', async () => {
    deps.moveWindowLeft();
  });

  safeHandle('move-window-right', async () => {
    deps.moveWindowRight();
  });

  safeHandle('move-window-up', async () => {
    deps.moveWindowUp();
  });

  safeHandle('move-window-down', async () => {
    deps.moveWindowDown();
  });

  safeHandle('center-and-show-window', async () => {
    deps.centerAndShowWindow();
  });

  // Window Controls
  safeHandle('window-minimize', async () => {
    deps.getWindowHelper().minimizeWindow();
  });

  safeHandle('window-maximize', async () => {
    deps.getWindowHelper().maximizeWindow();
  });

  safeHandle('window-close', async () => {
    deps.getWindowHelper().closeWindow();
  });

  safeHandle('window-is-maximized', async () => {
    return deps.getWindowHelper().isMainWindowMaximized();
  });
}
