// Structural wiring assertions for the chat-source selection in
// electron/ipcHandlers.ts (gemini-chat-stream handler):
//   * ONE selector (electron/llm/chatSources.ts) feeds BOTH assembly paths
//   * the idle V3 path and the caller-owned (typed chat + live transcript) path
//   * earlier meetings are no longer a keyword-gated, separate answer
//   * truthful `_hasMeetingRag`
//
// The handler is thousands of lines and bound to Electron singletons, so — like
// ContextOsManualChatWiring.test.mjs — these pin the contract at the source
// level; behaviour of the pieces themselves is covered by their own unit tests
// (ChatSources, PastMeetingSource, ModeReferencePassthrough,
// CallerOwnedChatEnrichment2026_10, pastMeetingRecall, RetrievalCeiling).
//
// Run with: node --test electron/intelligence/__tests__/ManualChatMeetingEnrichmentWiring2026_10.test.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const repoRoot = process.cwd();
const ipc = fs.readFileSync(path.resolve(repoRoot, 'electron/ipcHandlers.ts'), 'utf8');
const ui = fs.readFileSync(path.resolve(repoRoot, 'src/components/NativelyInterface.tsx'), 'utf8');
const wiring = fs.readFileSync(path.resolve(repoRoot, 'electron/llm/chatSourcesWiring.ts'), 'utf8');

test('imports the shared source selector, the live-index probe and the scope type', () => {
  assert.match(ipc, /import \{ startChatSourcesForTurn \} from '\.\/llm\/chatSourcesWiring'/);
  assert.match(ipc, /isLiveMeetingRagQueryable/);
  assert.match(ipc, /import type \{ ProviderDataScope \} from '\.\/llm\/ProviderRouter'/);
});

test('earlier meetings are not a separate keyword-gated answer any more', () => {
  assert.doesNotMatch(ipc, /queryGlobal\(message, myController\.signal/, 'the keyword-gated standalone recall answer must be gone');
  assert.doesNotMatch(ipc, /PAST-MEETING RECALL/);
});

test('a question that names an earlier meeting is never answered from the live index', () => {
  const jit = ipc.indexOf('UNIFIED PIPELINE (C5): JIT RAG preflight');
  assert.ok(jit > 0);
  const gate = ipc.slice(jit, jit + 900);
  assert.match(gate, /!isPastMeetingRecallQuestion\(message\)/);
});

test('the idle V3 path starts the selector before composing and settles it with V3 facts', () => {
  const start = ipc.indexOf("startChatSourcesForTurn({\n              path: 'idle'");
  const compose = ipc.indexOf('const composed = await buildV3Prompt(');
  assert.ok(start > 0 && compose > start, 'sources must start BEFORE buildV3Prompt so they overlap its awaits');
  const settleAt = ipc.indexOf('chatSources.settle({');
  assert.ok(settleAt > compose);
  const tail = ipc.slice(settleAt, settleAt + 900);
  assert.match(tail, /evidenceCount: composed\.evidenceCount/);
  assert.match(tail, /overridesNoEvidenceNotice: composed\.fallbackUsed !== 'NONE'/);
  assert.match(tail, /v3Scopes = \[\.\.\.new Set<ProviderDataScope>\(\[\.\.\.v3Scopes, \.\.\.extra\.dataScopes\]\)\]/);
});

test('the live-transcript path starts the SAME selector only for typed chat', () => {
  assert.match(
    ipc,
    /callerOwnsPrompt && options\?\.chatSurface === true && typeof message === 'string' && context\)\s*\{\s*callerEnrichmentPromise = startChatSourcesForTurn\(\{\s*path: 'live-transcript'/,
    'quick actions / voice (no chatSurface) must be untouched',
  );
});

test('the selector result is awaited where the caller blob is restored, and its scopes reach the transport', () => {
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

test('a selector failure can never break the turn', () => {
  const restore = ipc.indexOf('await callerEnrichmentPromise');
  const around = ipc.slice(restore - 120, restore + 900);
  assert.match(around, /try \{/);
  assert.match(around, /catch \{ \/\* enrichment is additive/);
  const idle = ipc.slice(ipc.indexOf('chatSources.settle({') - 80, ipc.indexOf('chatSources.settle({') + 900);
  assert.match(idle, /catch \(srcErr\)/);
  assert.match(wiring, /catch \(err\)[\s\S]*startChatSources\(INERT_PLAN/, 'a wiring error must degrade to an inert plan');
});

test('every selected source is logged, so a skipped source is never silent', () => {
  assert.match(ipc, /console\.log\('\[ChatSources\]', extra\.report\)/);
  assert.match(ipc, /console\.log\('\[ChatSources\]', enrichment\.report\)/);
});

test('the selector never pulls a profile (Profile Intelligence was removed)', () => {
  assert.match(wiring, /profileSources: \[\]/);
});

test('_hasMeetingRag reflects the live index instead of a hard-coded false', () => {
  assert.doesNotMatch(ipc, /_hasMeetingRag = Boolean\(false\)/);
  assert.match(ipc, /const _hasMeetingRag = isLiveMeetingRagQueryable\(appState\.getRAGManager\?\.\(\)\)/);
});

test('renderer still marks typed chat as chatSurface and passes the question for file relevance', () => {
  assert.match(ui, /chatSurface: true/);
  assert.match(ui, /fetchChatOverlayContext\(chatHistoryContext, window\.electronAPI as any, userText\)/);
});
