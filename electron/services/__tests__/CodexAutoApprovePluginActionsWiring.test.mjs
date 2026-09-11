// electron/services/__tests__/CodexAutoApprovePluginActionsWiring.test.mjs
//
// Source-contract guards for Settings → Plugins → "Approve plugin actions
// automatically" (SettingsManager key `codexAutoApprovePlugins`).
//
// The user-visible promise is: a plugin action the chat was asked to perform is
// not blocked by a confirmation the user never saw. That requires FOUR links to
// stay connected, and losing any single one silently reverts to "the model
// reports that approvals are disabled":
//   1. the setting exists and is persisted by SettingsManager
//   2. the main process reads it into CodexAppServerService (default ON)
//   3. the get/set IPC pair exists and is exposed through the preload bridge
//   4. Settings → Plugins renders the switch that owns it
//
// Pinned from the TypeScript source (established convention — see
// electron/audio/__tests__/AppStateHideOverlayOnStart.test.mjs).

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '../../..');
const read = relative => fs.readFileSync(path.join(root, relative), 'utf8');

const settingsSource = read('electron/services/SettingsManager.ts');
const ipcSource = read('electron/ipcHandlers.ts');
const serviceSource = read('electron/services/CodexAppServerService.ts');
const preloadSource = read('electron/preload.ts');
const typesSource = read('src/types/electron.d.ts');
const uiSource = read('src/components/settings/PluginsSettings.tsx');

describe('codexAutoApprovePlugins (Settings > Plugins)', () => {
  test('AppSettings declares the flag', () => {
    assert.match(settingsSource, /codexAutoApprovePlugins\?: boolean;/,
      'the setting must be declared in the AppSettings interface');
  });

  test('the App Server service owns the runtime flag', () => {
    assert.match(serviceSource, /private autoApprovePlugins = false;/,
      'the service default must stay OFF so a directly constructed instance (tests, background recovery) cannot auto-approve');
    assert.match(serviceSource, /setAutoApprovePlugins\(enabled: boolean\) \{ this\.autoApprovePlugins = enabled === true; \}/);
    assert.match(serviceSource, /if \(this\.autoApprovePlugins\) \{[\s\S]*?buildAutoApprovalResponse\(request\)/,
      'incoming interactions must consult the auto-approval policy when the setting is on');
    assert.match(serviceSource, /const connectorTurnsAllowed = Boolean\(activeApp\) \|\| this\.autoApprovePlugins;/,
      'without a named plugin the turn needs the auto-approval flag to reach a connector at all');
    assert.match(serviceSource, /const approvalPolicy = connectorTurnsAllowed \? 'on-request' : 'never';/,
      'with `never` a connector write is refused instead of asked, which is the "approvals are disabled" answer');
  });

  test('main process loads the persisted value (default ON) and updates it live', () => {
    assert.match(ipcSource, /codexServer\.setAutoApprovePlugins\(SettingsManager\.getInstance\(\)\.get\('codexAutoApprovePlugins'\) \?\? true\);/,
      'undefined (never touched) must read as enabled');
    assert.match(ipcSource, /safeHandle\('get-codex-auto-approve-plugins'/);
    assert.match(ipcSource, /safeHandle\('set-codex-auto-approve-plugins'[\s\S]*?sm\.set\('codexAutoApprovePlugins', enabled\)[\s\S]*?codexServer\.setAutoApprovePlugins\(enabled\);/,
      'the setter must persist AND push the new value into the running service');
    assert.match(ipcSource, /settings_store_degraded/,
      'a refused store write must not be reported as success (R-24)');
  });

  test('preload exposes the get/set pair', () => {
    assert.match(preloadSource, /getCodexAutoApprovePlugins: \(\) => ipcRenderer\.invoke\('get-codex-auto-approve-plugins'\)/);
    assert.match(preloadSource, /setCodexAutoApprovePlugins: \(enabled: boolean\) => ipcRenderer\.invoke\('set-codex-auto-approve-plugins', enabled\)/);
    assert.match(typesSource, /getCodexAutoApprovePlugins: \(\) => Promise<\{ enabled: boolean \}>;/);
    assert.match(typesSource, /setCodexAutoApprovePlugins: \(enabled: boolean\) => Promise<\{ success: boolean; enabled\?: boolean; error\?: string \}>;/);
  });

  test('Settings > Plugins renders the switch that owns the flag', () => {
    assert.match(uiSource, /getCodexAutoApprovePlugins/);
    assert.match(uiSource, /setCodexAutoApprovePlugins\(next\)/);
    assert.match(uiSource, /role="switch"[\s\S]*?aria-checked=\{autoApprove\}/,
      'the control must be a real switch for assistive tech');
  });
});
