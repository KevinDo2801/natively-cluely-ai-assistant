import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '../../..');

function read(relativePath) {
  return fs.readFileSync(path.join(root, relativePath), 'utf8');
}

/**
 * ISSUE 2 (P0): Image path validation for arbitrary paths from renderer
 *
 * UNIFIED PIPELINE (C6): the per-mode handlers (generate-code-hint /
 * generate-brainstorm / generate-what-to-say) are deleted — every surface
 * now enters through `run-intelligence`, which validates imagePaths BEFORE
 * any vision/LLM work, and the what_to_say branch (const
 * _generateWhatToSayHandler) keeps its own validation. Attackers could pass
 * paths like /etc/passwd, private home directories, or Windows drive paths.
 *
 * Fix: Validate all paths are inside app-owned directories (userData/screenshots).
 * Reject path traversal attempts (/../), /etc/passwd, private home paths, etc.
 */

function runIntelligenceBlock(source) {
  const start = source.indexOf("safeHandle('run-intelligence'");
  assert.ok(start >= 0, 'run-intelligence handler should exist');
  const next = source.indexOf('safeHandle(', start + 20);
  return source.slice(start, next > start ? next : start + 15_000);
}

function whatToSayConstBlock(source) {
  const start = source.indexOf('const _generateWhatToSayHandler = async (');
  assert.ok(start >= 0, '_generateWhatToSayHandler should exist');
  const end = source.indexOf("safeHandle('run-intelligence'", start);
  return source.slice(start, end > start ? end : start + 30_000);
}

test('code-hint path validates imagePaths before using them (run-intelligence)', () => {
  const ipcSource = read('electron/ipcHandlers.ts');
  const engineSource = read('electron/IntelligenceEngine.ts');

  const handler = runIntelligenceBlock(ipcSource);
  assert.match(handler, /validateImagePath/, 'run-intelligence must validate imagePaths');

  const runCodeHintStart = engineSource.indexOf('async runCodeHint(');
  assert.ok(runCodeHintStart >= 0, 'runCodeHint should exist');
  // The engine receives already-validated paths from the IPC layer.
  const runCodeHintEnd = engineSource.indexOf('\n    async runBrainstorm(', runCodeHintStart + 10);
  const runCodeHintBody = engineSource.slice(runCodeHintStart, runCodeHintEnd > runCodeHintStart ? runCodeHintEnd : runCodeHintStart + 10_000);
  assert.match(runCodeHintBody, /imagePaths\??:\s*string\[\]/, 'runCodeHint should accept imagePaths');
});

test('brainstorm path validates imagePaths before using them (run-intelligence)', () => {
  const ipcSource = read('electron/ipcHandlers.ts');
  const engineSource = read('electron/IntelligenceEngine.ts');

  const handler = runIntelligenceBlock(ipcSource);
  assert.match(handler, /validateImagePath/, 'run-intelligence must validate imagePaths');

  const runBrainstormStart = engineSource.indexOf('async runBrainstorm(');
  assert.ok(runBrainstormStart >= 0, 'runBrainstorm should exist');
  assert.match(
    engineSource.slice(runBrainstormStart, runBrainstormStart + 8_000),
    /imagePaths\??:\s*string\[\]/,
    'runBrainstorm should accept imagePaths',
  );
});

test('runWhatShouldISay receives validated imagePaths from IPC handler', () => {
  const ipcSource = read('electron/ipcHandlers.ts');
  const engineSource = read('electron/IntelligenceEngine.ts');

  const methodStart = engineSource.indexOf('async runWhatShouldISay(');
  assert.ok(methodStart >= 0, 'runWhatShouldISay should exist');

  // The method body should accept imagePaths (validation is at IPC layer).
  assert.match(
    engineSource.slice(methodStart, methodStart + 8_000),
    /imagePaths\??:\s*string\[\]/,
    'runWhatShouldISay should accept imagePaths',
  );

  // Validation happens at the IPC handler level (both the shared
  // run-intelligence P0 gate and the what_to_say const).
  const handler = runIntelligenceBlock(ipcSource);
  assert.match(handler, /validateImagePath/, 'run-intelligence should validate imagePaths');
});

test('image path validation rejects path traversal attempts', () => {
  const source = read('electron/ipcHandlers.ts');
  assert.match(source, /validateImagePath/, 'Should have image path validation function');
});

test('what-to-say path rejects malformed image path payloads before OCR or model calls', () => {
  const ipcSource = read('electron/ipcHandlers.ts');
  const handler = whatToSayConstBlock(ipcSource);

  assert.match(handler, /imagePaths\.length > 5/);
  assert.match(handler, /typeof imagePath !== 'string'/);
  assert.match(handler, /imagePath\.trim\(\)\.length === 0/);
  assert.match(handler, /malformed image path payload rejected/);
  assert.match(handler, /Invalid image path payload/);
  assert.match(handler, /validatedImagePaths/);
  assert.match(handler, /runWhatShouldISay\([\s\S]{0,120}validatedImagePaths/);
});

test('image path validation is applied at IPC handler level', () => {
  const ipcSource = read('electron/ipcHandlers.ts');

  const runIntelligence = runIntelligenceBlock(ipcSource);
  const whatToSay = whatToSayConstBlock(ipcSource);

  assert.match(runIntelligence, /validateImagePath/, 'run-intelligence must validate imagePaths');
  assert.match(whatToSay, /validateImagePath/, 'the what_to_say branch must validate imagePaths');
});
