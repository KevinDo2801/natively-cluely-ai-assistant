// electron/services/__tests__/CodexPluginAutoApproval.test.mjs
//
// Pure policy tests for the "Approve plugin actions automatically" setting.
//
// The module decides which incoming App Server interactions may be answered
// without the user. It must be deliberately conservative: only genuine yes/no
// confirmations are auto-accepted. Anything that carries user DATA (free text,
// secrets, a pick list without a negative side, a URL consent flow, a schema
// with required fields) must return null so the overlay card is still shown —
// auto-picking the first option there would write wrong data into the user's
// account.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildAutoApprovalResponse } from '../codexPluginAutoApproval.mjs';

const question = (overrides = {}) => ({
  id: 'confirm',
  header: 'Create event',
  isOther: false,
  isSecret: false,
  options: [
    { label: 'Yes', description: 'Create it' },
    { label: 'No', description: 'Cancel it' },
  ],
  ...overrides,
});

test('answers a yes/no confirmation with the affirmative option', () => {
  assert.deepEqual(buildAutoApprovalResponse({ kind: 'user_input', questions: [question()] }), {
    action: 'accept',
    values: { confirm: 'Yes' },
  });
});

test('accepts localized and verbose affirmative labels', () => {
  for (const label of ['Đồng ý', 'Allow', 'Approve', 'Continue']) {
    const response = buildAutoApprovalResponse({
      kind: 'user_input',
      questions: [question({ options: [{ label }, { label: 'Không' }] })],
    });
    assert.equal(response?.values.confirm, label, `${label} must be treated as the affirmative option`);
  }
});

test('leaves a secret question to the user', () => {
  assert.equal(buildAutoApprovalResponse({
    kind: 'user_input',
    questions: [question({ isSecret: true })],
  }), null);
});

test('leaves a free-text question to the user', () => {
  assert.equal(buildAutoApprovalResponse({
    kind: 'user_input',
    questions: [question({ options: [] })],
  }), null);
  assert.equal(buildAutoApprovalResponse({
    kind: 'user_input',
    questions: [question({ options: undefined })],
  }), null);
});

test('never guesses between data options (a 2-option pick list is not consent)', () => {
  assert.equal(buildAutoApprovalResponse({
    kind: 'user_input',
    questions: [question({
      options: [{ label: '5:00 PM' }, { label: '6:00 PM' }],
    })],
  }), null);
});

test('a confirmation mixed with a data question still reaches the card', () => {
  assert.equal(buildAutoApprovalResponse({
    kind: 'user_input',
    questions: [question(), question({ id: 'title', options: [{ label: 'LeetCode' }] })],
  }), null);
});

test('a question without an id cannot be answered', () => {
  assert.equal(buildAutoApprovalResponse({ kind: 'user_input', questions: [question({ id: '' })] }), null);
});

test('an interaction with no questions is accepted as-is', () => {
  assert.deepEqual(buildAutoApprovalResponse({ kind: 'user_input', questions: [] }), {
    action: 'accept',
    values: {},
  });
});

test('accepts a plain elicitation without required fields', () => {
  assert.deepEqual(buildAutoApprovalResponse({
    kind: 'elicitation',
    message: 'Create event?',
    requestedSchema: { type: 'object', properties: {} },
  }), { action: 'accept', values: {} });
});

test('leaves an elicitation that needs fields to the user', () => {
  assert.equal(buildAutoApprovalResponse({
    kind: 'elicitation',
    requestedSchema: { type: 'object', required: ['title'], properties: { title: { type: 'string' } } },
  }), null);
});

test('never fakes a URL consent flow', () => {
  assert.equal(buildAutoApprovalResponse({
    kind: 'elicitation',
    mode: 'url',
    url: 'https://chatgpt.com/apps/calendar/authorize',
  }), null);
  assert.equal(buildAutoApprovalResponse({ kind: 'elicitation', mode: 'url' }), null);
});

test('unknown or malformed interactions are never auto-accepted', () => {
  assert.equal(buildAutoApprovalResponse(null), null);
  assert.equal(buildAutoApprovalResponse(undefined), null);
  assert.equal(buildAutoApprovalResponse({ kind: 'something_else' }), null);
});
