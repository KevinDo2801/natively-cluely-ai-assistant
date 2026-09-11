// electron/services/__tests__/ConnectorTurnDeadlineWiring.test.mjs
//
// Source-contract guard for the manual-chat (chat overlay) path: a turn that can
// reach a plugin/app connector must not be guillotined by the provider-shaped
// live-deadline budgets.
//
// The failure this pins (live, 2026-10): "Canva vẽ cho tôi ảnh con dog 500x500"
// hit `!manualFirstUseful && !fullResponse.trim()` in ipcHandlers → the canned
// "I don't have enough context from the allowed source to answer that yet." line,
// with zero tokens and a cancelled plugin interaction. Losing any one of the four
// links below silently restores it.

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '../../..');
const read = relative => fs.readFileSync(path.join(root, relative), 'utf8');

const ipcSource = read('electron/ipcHandlers.ts');
const deadlinesSource = read('electron/llm/liveDeadlines.ts');
const serviceSource = read('electron/services/CodexAppServerService.ts');

describe('connector turns vs the live deadline', () => {
  test('the deadline module owns the connector budgets', () => {
    assert.match(deadlinesSource, /export const PLUGIN_TURN_FIRST_USEFUL_TIMEOUT_MS = 5 \* 60_000;/);
    assert.match(deadlinesSource, /export const PLUGIN_TURN_INTER_TOKEN_STALL_MS = 5 \* 60_000;/);
    assert.match(deadlinesSource, /if \(isConnectorTurn\) return PLUGIN_TURN_FIRST_USEFUL_TIMEOUT_MS;/,
      'a connector turn must outrank the local/cloud/answer-type caps');
  });

  test('the driver can hold a fired deadline and keeps the in-flight pull', () => {
    assert.match(deadlinesSource, /shouldHoldDeadline\?: \(\) => boolean;/);
    assert.match(deadlinesSource, /if \(holds\(\)\) \{[\s\S]*?holdRearmAt = Date\.now\(\) \+ DEADLINE_HOLD_RECHECK_MS;[\s\S]*?continue;/,
      'a fired deadline must be re-armed, not honored, while something is in progress');
    assert.match(deadlinesSource, /const nextP: Promise<IteratorResult<string>> = pending \?\? iterator\.next\(\);/,
      'the pending next() must survive a hold, or its token is silently dropped');
  });

  test('the manual chat path passes the connector budget, stall guard and hold', () => {
    assert.match(ipcSource, /const connectorTurn = Boolean\(options\?\.codexApp\)[\s\S]*?getAutoApprovePlugins\(\)\);/,
      'a named plugin OR auto-approval (model may reach any connected plugin) must set the flag');
    assert.match(ipcSource, /firstUsefulDeadlineMs\(answerPlan\.answerType, usingLocalLlm, viaServerCascade, connectorTurn\)/,
      'the connector flag must reach the budget function');
    assert.match(ipcSource, /interTokenStallMs: PLUGIN_TURN_INTER_TOKEN_STALL_MS/);
    assert.match(ipcSource, /shouldHoldDeadline: \(\) => CodexAppServerService\.getInstance\(\)\.hasPendingInteraction\(\)/,
      'an unanswered confirmation card must hold the deadline instead of aborting the turn');
  });

  test('the App Server exposes the pending-interaction state and its own budget', () => {
    assert.match(serviceSource, /hasPendingInteraction\(threadId\?: string\): boolean \{/);
    assert.match(serviceSource, /const turnTimeoutMs = connectorTurnsAllowed[\s\S]*?PLUGIN_INTERACTION_TIMEOUT_MS/,
      'the inner idle timer is 60s by default — a running tool would fail a healthy connector turn');
    assert.match(serviceSource, /resetTimer\(isPluginInteraction \? Math\.max\(turnTimeoutMs, PLUGIN_INTERACTION_TIMEOUT_MS\) : turnTimeoutMs\);/);
  });
});

describe('connector artifacts vs the text-only stream', () => {
  test('the service reads artifacts from items and appends them to the answer', () => {
    assert.match(serviceSource, /import \{ buildMediaBlock, collectMediaFromNotification, recoverAgentMessageText \} from '\.\/codexNotificationMedia\.mjs';/);
    assert.match(serviceSource, /else \{[\s\S]*?collectMediaFromNotification\(message\)[\s\S]*?turnMedia\.push\(entry\)/,
      'media must be collected from item notifications (never from the answer-text delta)');
    assert.match(serviceSource, /const mediaBlock = buildMediaBlock\(chunks\.join\(''\), turnMedia\);[\s\S]*?if \(mediaBlock\) \{[\s\S]*?chunks\.push\(mediaBlock\);/,
      'the artifact block must be appended once the turn completes');
  });

  test('a message delivered as an item is recovered instead of showing the no-answer line', () => {
    assert.match(serviceSource, /lastFinishedMessageItem = message;/,
      'the finished item must be HELD, not streamed on arrival');
    assert.match(serviceSource, /const recovered = recoverAgentMessageText\(lastFinishedMessageItem, chunks\.join\(''\)\);/,
      'recovery must run at turn/completed only — running it on arrival duplicated the answer');
    assert.match(serviceSource, /\[CodexAppServer\]\[empty-turn\] status=/,
      'a zero-token turn must leave a diagnostic naming what actually arrived');
    assert.match(ipcSource, /\[ManualChat\]\[no-answer\] outcome=\$\{manualRaceOutcome\}/,
      'the canned no-answer line must log the race outcome and the route flags');
  });

  test('the instructions require the model to write the artifact URL', () => {
    assert.match(serviceSource, /When a connector produces something the user must SEE or OPEN/);
    assert.match(serviceSource, /Never say "shown above", "as above" or "the attached file"/,
      'the "as above" answer is the symptom this clause exists to stop');
  });

  test('raw notification logging is available behind an env switch', () => {
    assert.match(serviceSource, /const DEBUG_NOTIFICATIONS = process\.env\.NATIVELY_CODEX_DEBUG_NOTIFICATIONS === '1';/);
    assert.match(serviceSource, /\[CodexAppServer\]\[notify\]/);
  });
});
