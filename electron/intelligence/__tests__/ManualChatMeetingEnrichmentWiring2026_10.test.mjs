// Structural wiring assertions for the 2026-10 chat-intelligence work in
// electron/ipcHandlers.ts (gemini-chat-stream handler):
//   * past-meeting recall preflight
//   * caller-owned (typed chat + live transcript) enrichment
//   * truthful `_hasMeetingRag`
//
// The handler is thousands of lines and bound to Electron singletons, so — like
// ContextOsManualChatWiring.test.mjs — these pin the contract at the source
// level; behaviour of the pieces themselves is covered by their own unit tests
// (CallerOwnedChatEnrichment2026_10, pastMeetingRecall, RetrievalCeiling).
//
// Run with: node --test electron/intelligence/__tests__/ManualChatMeetingEnrichmentWiring2026_10.test.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const repoRoot = process.cwd();
const ipc = fs.readFileSync(path.resolve(repoRoot, 'electron/ipcHandlers.ts'), 'utf8');
const ui = fs.readFileSync(path.resolve(repoRoot, 'src/components/NativelyInterface.tsx'), 'utf8');

test('imports the enrichment, recall detector and scope type', () => {
  assert.match(ipc, /startCallerOwnedChatEnrichment/);
  assert.match(ipc, /isLiveMeetingRagQueryable/);
  assert.match(ipc, /from '\.\.\/src\/lib\/pastMeetingRecall'/);
  assert.match(ipc, /import type \{ ProviderDataScope \} from '\.\/llm\/ProviderRouter'/);
});

test('past-meeting recall runs BEFORE the live-meeting JIT RAG preflight', () => {
  const recall = ipc.indexOf('PAST-MEETING RECALL');
  const jit = ipc.indexOf('UNIFIED PIPELINE (C5): JIT RAG preflight');
  assert.ok(recall > 0 && jit > 0, 'both blocks must exist');
  assert.ok(recall < jit, 'recall must be tried first so a question about an old meeting never lands on the live index');
});

test('past-meeting recall is strictly gated and falls through when nothing is found', () => {
  const block = ipc.slice(ipc.indexOf('PAST-MEETING RECALL'), ipc.indexOf('UNIFIED PIPELINE (C5): JIT RAG preflight'));
  assert.match(block, /!imagePaths\?\.length/, 'screenshot turns must not be diverted');
  assert.match(block, /!options\?\.codexApp/, 'plugin turns must not be diverted');
  assert.match(block, /isPastMeetingRecallQuestion\(message\)/);
  assert.match(block, /queryGlobal\(message, myController\.signal, \{ throwWhenEmpty: true \}\)/,
    'an empty search must fall through, not show the canned "nothing found" string');
  assert.match(block, /catch \{[\s\S]*normal path/, 'a failed search must fall through to the normal answer');
  assert.match(block, /_chatStreamsBySender\.get\(senderId\)\?\.streamId !== myStreamId/, 'must honour stream supersession');
});

test('enrichment starts only for typed chat on the caller-owned path', () => {
  assert.match(
    ipc,
    /callerOwnsPrompt && options\?\.chatSurface === true && typeof message === 'string' && context\)\s*\{\s*callerEnrichmentPromise = startCallerOwnedChatEnrichment\(/,
    'quick actions / voice (no chatSurface) must be untouched',
  );
});

test('enrichment is awaited where the caller blob is restored, and its scopes reach the transport', () => {
  const restore = ipc.indexOf('context = callerPromptContext;');
  assert.ok(restore > 0, 'restore site missing');
  const tail = ipc.slice(restore, restore + 1800);
  assert.match(tail, /await callerEnrichmentPromise/);
  assert.match(tail, /context = `\$\{callerPromptContext\}\\n\\n\$\{enrichment\.block\}`/);
  assert.match(tail, /callerEnrichmentScopes = enrichment\.dataScopes/);
  // The stream call must declare the scopes of what it carries (it used to pass []).
  assert.match(ipc, /callerEnrichmentScopes,\s*\/\/ extraDataScopes/);
  assert.doesNotMatch(
    ipc.slice(ipc.indexOf('const stream = llmHelper.streamChat('), ipc.indexOf('const stream = llmHelper.streamChat(') + 900),
    /\[\],\s*\/\/ extraDataScopes/,
    'manual chat must no longer hard-code empty extraDataScopes',
  );
});

test('enrichment failure can never break the turn', () => {
  const restore = ipc.indexOf('await callerEnrichmentPromise');
  const around = ipc.slice(restore - 120, restore + 900);
  assert.match(around, /try \{/);
  assert.match(around, /catch \{ \/\* enrichment is additive/);
});

test('_hasMeetingRag reflects the live index instead of a hard-coded false', () => {
  assert.doesNotMatch(ipc, /_hasMeetingRag = Boolean\(false\)/);
  assert.match(ipc, /const _hasMeetingRag = isLiveMeetingRagQueryable\(appState\.getRAGManager\?\.\(\)\)/);
});

test('renderer still marks typed chat as chatSurface and passes the question for file relevance', () => {
  assert.match(ui, /chatSurface: true/);
  assert.match(ui, /fetchChatOverlayContext\(chatHistoryContext, window\.electronAPI as any, userText\)/);
});
