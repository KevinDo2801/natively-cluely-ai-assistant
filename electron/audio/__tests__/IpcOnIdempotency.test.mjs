import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ipcHandlersPath = path.resolve(__dirname, '../../../electron/ipcHandlers.ts');
const ipcSource = readFileSync(ipcHandlersPath, 'utf8');
// Phase 2: safeOn lives in the shared electron/ipc/safeIpc.ts module.
const safeIpcPath = path.resolve(__dirname, '../../../electron/ipc/safeIpc.ts');
const safeIpcSource = readFileSync(safeIpcPath, 'utf8');

test('send-style IPC registrations use safeOn to avoid listener accumulation', () => {
  const safeOnStart = safeIpcSource.indexOf('export function safeOn(');
  assert.ok(safeOnStart >= 0, 'BUG: electron/ipc/safeIpc.ts must export safeOn.');
  const safeOnBody = safeIpcSource.slice(safeOnStart, safeIpcSource.indexOf('}', safeOnStart) + 1);
  assert.ok(
    /ipcMain\.removeAllListeners\s*\(\s*channel\s*\)/.test(safeOnBody) &&
      /ipcMain\.on\s*\(\s*channel\s*,\s*listener\s*\)/.test(safeOnBody),
    'BUG: safeOn must remove old listeners before registering ipcMain.on channels.',
  );

  for (const channel of ['intelligence-stream-stop', 'forward-log-to-file', 'interface-theme:set']) {
    assert.ok(
      new RegExp(`safeOn\\s*\\(\\s*['"]${channel}['"]`).test(ipcSource),
      `BUG: ${channel} must be registered through safeOn, not raw ipcMain.on.`,
    );
    assert.ok(
      !new RegExp(`ipcMain\\.on\\s*\\(\\s*['"]${channel}['"]`).test(ipcSource),
      `BUG: ${channel} raw ipcMain.on registration would accumulate listeners on re-init.`,
    );
  }
});
