import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const read = (path) => readFileSync(new URL(path, import.meta.url), 'utf8');

test('overlay clipboard writes through Electron main-process clipboard', () => {
  const source = read('../../ipcHandlers.ts');

  assert.match(source, /import \{[^}]*\bclipboard\b[^}]*\} from 'electron'/);
  assert.match(source, /safeHandle\('clipboard:write-text'/);
  assert.match(source, /clipboard\.writeText\(text\)/);
  assert.match(source, /typeof text !== 'string'/);
});

test('preload exposes the clipboard IPC bridge', () => {
  const source = read('../../preload.ts');

  assert.match(source, /writeClipboardText:\s*\(text: string\)/);
  assert.match(source, /ipcRenderer\.invoke\('clipboard:write-text', text\)/);
});

test('chat code copy prefers the native bridge and only reports confirmed success', () => {
  const source = read('../../../src/components/NativelyInterface.tsx');

  assert.match(source, /electronAPI\?\.writeClipboardText\?\.\(code\)/);
  assert.match(source, /copiedSuccessfully = result\?\.success === true/);
  assert.match(source, /if \(copiedSuccessfully\) \{\s*setCopied\(true\)/);
});
