// ============================================================================
// safeIpc — idempotent ipcMain registration helpers (Phase 2 foundation).
//
// Extracted from ipcHandlers.ts. Every channel in this app is registered
// through these wrappers so that re-init (HMR, single-instance second-launch,
// manual app.ready in tests) never throws Electron's
// "Attempted to register a second handler for '<channel>'".
//
//   safeHandle — removeHandler-then-handle for invoke channels.
//   safeOn     — removeAllListeners-then-on for send/on channels.
// ============================================================================

import { ipcMain } from 'electron';

/**
 * Register an ipcMain.handle idempotently: removes any prior handler for the
 * channel first, so a duplicate registration never throws.
 */
export function safeHandle(
  channel: string,
  listener: (event: Electron.IpcMainInvokeEvent, ...args: any[]) => Promise<any> | any,
): void {
  ipcMain.removeHandler(channel);
  ipcMain.handle(channel, listener);
}

/**
 * Register an ipcMain.on idempotently: removes all prior listeners for the
 * channel first, so re-init cannot accumulate duplicate listeners.
 */
export function safeOn(
  channel: string,
  listener: (event: Electron.IpcMainEvent, ...args: any[]) => void,
): void {
  ipcMain.removeAllListeners(channel);
  ipcMain.on(channel, listener);
}
