import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { findSafeHandle, sliceSafeHandleBlock } from './ipcTestUtils.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '../../..');
const read = relative => fs.readFileSync(path.join(root, relative), 'utf8');

// The options bag gained `domContextEnvelope` (the structured DOM payload that
// superseded the raw string). Each assertion below pinned the object as EXACTLY
// `{ promptInstruction?: string; domContext?: string }`, so adding a field broke
// three tests while the wiring they exist to protect — promptInstruction and
// domContext reaching the handler — was never at risk. Matched field-wise
// instead: both must be present, extra fields are allowed, and a REMOVED field
// still fails.
const OPTIONS_WITH_BOTH = /options\?: \{[^}]*promptInstruction\?: string[^}]*domContext\?: string[^}]*\}/;

test('dynamic action accept uses promptInstruction instead of display label/manual submit', () => {
  const source = read('src/components/NativelyInterface.tsx');
  const mountStart = source.indexOf('<DynamicActionBar');
  assert.ok(mountStart >= 0, 'DynamicActionBar should be mounted');
  const mountSource = source.slice(mountStart, source.indexOf('/>', mountStart) + 2);

  assert.match(mountSource, /handleWhatToSay\(action\.promptInstruction\)/);
  assert.doesNotMatch(mountSource, /setInputValue\(action\.label\)/);
  assert.doesNotMatch(mountSource, /handleManualSubmitRef\.current/);
});

test('what-to-say path forwards promptInstruction option to IntelligenceManager (UNIFIED run-intelligence)', () => {
  const source = read('electron/ipcHandlers.ts');
  // UNIFIED PIPELINE (C6): the channel registration is gone; the handler
  // lives as `const _generateWhatToSayHandler` (what_to_say branch).
  const constStart = source.indexOf('const _generateWhatToSayHandler = async (');
  assert.ok(constStart >= 0, '_generateWhatToSayHandler should exist');
  const constEnd = source.indexOf("safeHandle('run-intelligence'", constStart);
  const handlerSource = source.slice(constStart, constEnd > constStart ? constEnd : constStart + 30_000);

  assert.match(handlerSource, OPTIONS_WITH_BOTH);
  assert.match(handlerSource, /promptInstruction:[\s\S]{0,120}typeof options\?\.promptInstruction === 'string'[\s\S]{0,80}options\.promptInstruction[\s\S]{0,40}: undefined/);
  // The truncation moved from an inline `domContext:` property into a local
  // (`effectiveDomContext`) so the browser-envelope path can PREPEND a header to
  // it before forwarding. The cap itself is unchanged and is what matters here —
  // an untruncated domContext is how an unbounded page dump reaches the prompt.
  assert.match(
    handlerSource,
    /typeof options\?\.domContext === 'string'[\s\S]{0,80}options\.domContext\.substring\(0, DOM_CONTEXT_MAX_CHARS\)[\s\S]{0,40}: undefined/,
    'domContext must still be truncated to DOM_CONTEXT_MAX_CHARS before it reaches the prompt',
  );
});

test('preload and renderer type expose promptInstruction/domContext on the unified runIntelligence request', () => {
  const preload = read('electron/preload.ts');
  const types = read('src/types/electron.d.ts');

  const runIntelligenceType = types.match(/runIntelligence:[\s\S]{0,2000}?=> Promise</);
  assert.ok(runIntelligenceType, 'electron.d.ts must type runIntelligence');
  assert.match(runIntelligenceType[0], /promptInstruction\?: string/, 'runIntelligence request must expose promptInstruction');
  assert.match(runIntelligenceType[0], /domContext\?: string/, 'runIntelligence request must expose domContext');
  assert.match(preload, /runIntelligence: \(request: any\) => ipcRenderer\.invoke\('run-intelligence', request\)/);
});
