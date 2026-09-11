// electron/llm/__tests__/ConnectorTurnDeadline.test.mjs
//
// Connector (plugin) turns are silent for a structural reason: the App Server
// emits no text while a tool call runs, and a write that needs a decision waits
// on the user's confirmation card. Live capture 2026-10 (chat overlay): "Canva vẽ
// cho tôi ảnh con dog 500x500" was killed at the 30s local first-useful cap with
// ZERO tokens, the user got the canned "I don't have enough context from the
// allowed source to answer that yet." line, and the abort then cancelled the
// in-flight plugin interaction so the action could never complete.
//
// These tests pin the three properties that make connected plugins usable:
//   1. a connector turn gets the connector budget, whatever the provider shape
//   2. a fired deadline is RE-ARMED while something is legitimately in progress
//   3. a held deadline never drops the token that was already in flight

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const {
  raceStreamWithDeadline, firstUsefulDeadlineMs,
  PLUGIN_TURN_FIRST_USEFUL_TIMEOUT_MS, PLUGIN_TURN_INTER_TOKEN_STALL_MS,
  LIVE_LOCAL_FIRST_USEFUL_TIMEOUT_MS, LIVE_PROVIDER_FIRST_USEFUL_HARD_TIMEOUT_MS,
} = await import(
  pathToFileURL(path.resolve(__dirname, '../../../dist-electron/electron/llm/index.js')).href
);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function* fakeStream(script, hangMs = 0) {
  for (const step of script) {
    await sleep(step.delayMs);
    yield step.value;
  }
  if (hangMs) { await sleep(hangMs); }
}

describe('connector-turn deadline budget', () => {
  test('a connector turn outranks the cloud, local and answer-type budgets', () => {
    for (const answerType of ['general_meeting_answer', 'lecture_answer', 'coding_answer', 'sales_answer']) {
      assert.equal(
        firstUsefulDeadlineMs(answerType, false, false, true),
        PLUGIN_TURN_FIRST_USEFUL_TIMEOUT_MS,
        `${answerType} on a connector turn must use the connector budget`,
      );
      assert.equal(
        firstUsefulDeadlineMs(answerType, true, false, true),
        PLUGIN_TURN_FIRST_USEFUL_TIMEOUT_MS,
        `${answerType} on a LOCAL connector turn must not fall back to the 30s local cap`,
      );
    }
  });

  test('the connector budget is longer than every provider-shaped cap', () => {
    assert.ok(PLUGIN_TURN_FIRST_USEFUL_TIMEOUT_MS > LIVE_LOCAL_FIRST_USEFUL_TIMEOUT_MS,
      'the connector budget must exceed the 30s local cap that killed the Canva turn');
    assert.ok(PLUGIN_TURN_FIRST_USEFUL_TIMEOUT_MS > LIVE_PROVIDER_FIRST_USEFUL_HARD_TIMEOUT_MS);
    assert.ok(PLUGIN_TURN_INTER_TOKEN_STALL_MS > 8000,
      'a multi-step connector answer is silent far longer than the 8s stall guard');
  });

  test('a non-connector turn keeps the existing budgets', () => {
    assert.equal(firstUsefulDeadlineMs('general_meeting_answer', false, false, false),
      LIVE_PROVIDER_FIRST_USEFUL_HARD_TIMEOUT_MS);
    assert.equal(firstUsefulDeadlineMs('general_meeting_answer', true, false, false),
      LIVE_LOCAL_FIRST_USEFUL_TIMEOUT_MS);
  });
});

describe('held deadlines', () => {
  test('a deadline is re-armed while the hold predicate is true, then fires', async () => {
    let holding = true;
    setTimeout(() => { holding = false; }, 150);
    const started = Date.now();
    const result = await raceStreamWithDeadline({
      stream: fakeStream([], 5000),
      firstUsefulDeadlineMs: 30,
      onToken: () => {},
      isUsefulYet: () => false,
      shouldHoldDeadline: () => holding,
    });
    const elapsed = Date.now() - started;
    assert.equal(result, 'first_useful_timeout', 'the guard still fires once nothing is in progress');
    assert.ok(elapsed >= 150, `the deadline must not fire while held (elapsed ${elapsed}ms)`);
  });

  test('a hold that outlives the deadline lets a late first token through', async () => {
    let holding = true;
    setTimeout(() => { holding = false; }, 400);
    const tokens = [];
    const result = await raceStreamWithDeadline({
      stream: fakeStream([{ delayMs: 120, value: 'a real answer arrives' }]),
      firstUsefulDeadlineMs: 60,
      onToken: (value) => { tokens.push(value); },
      isUsefulYet: () => tokens.length > 0,
      shouldHoldDeadline: () => holding,
    });
    assert.equal(result, 'done', 'the token must be delivered, not timed out at 60ms');
    assert.deepEqual(tokens, ['a real answer arrives']);
  });

  // REGRESSION PIN: the first version of the hold called iterator.next() again
  // after re-arming, leaving the raced-but-abandoned pull to resolve later with
  // its value dropped. On a real connector turn that silently ate the first
  // token — the exact failure the hold was added to prevent.
  test('a held deadline never drops the token that was already in flight', async () => {
    const tokens = [];
    let holding = true;
    // The token arrives well after the deadline would have fired; the hold is
    // still on at that moment and turns off afterwards.
    setTimeout(() => { holding = false; }, 400);
    const result = await raceStreamWithDeadline({
      stream: fakeStream([
        { delayMs: 150, value: 'LeetCode' },
        { delayMs: 5, value: ' event created.' },
      ]),
      firstUsefulDeadlineMs: 30,
      onToken: (value) => { tokens.push(value); },
      isUsefulYet: () => tokens.join('').length >= 5,
      shouldHoldDeadline: () => holding,
    });
    assert.deepEqual(tokens, ['LeetCode', ' event created.'],
      'holding must not swallow the in-flight pull');
    assert.equal(result, 'done');
  });

  test('a throwing hold predicate cannot break the stream (fails closed to firing)', async () => {
    const result = await raceStreamWithDeadline({
      stream: fakeStream([], 5000),
      firstUsefulDeadlineMs: 30,
      onToken: () => {},
      isUsefulYet: () => false,
      shouldHoldDeadline: () => { throw new Error('boom'); },
    });
    assert.equal(result, 'first_useful_timeout');
  });

  test('the hold also covers the inter-token guard after streaming began', async () => {
    const tokens = [];
    let holding = false;
    const stream = (async function* () {
      yield 'first five chars';
      // Mid-answer silence: a second connector tool call.
      await sleep(200);
      yield ' and the rest';
    })();
    setTimeout(() => { holding = true; }, 40);
    const result = await raceStreamWithDeadline({
      stream,
      firstUsefulDeadlineMs: 5000,
      interTokenStallMs: 40,
      onToken: (value) => { tokens.push(value); },
      isUsefulYet: () => tokens.length > 0,
      shouldHoldDeadline: () => holding,
    });
    assert.equal(result, 'done', 'a silently-running tool must not trip the stall guard');
    assert.equal(tokens.join(''), 'first five chars and the rest');
  });
});
