import assert from 'node:assert/strict';
import test from 'node:test';
import ts from 'typescript';
import fs from 'node:fs';
import vm from 'node:vm';

const sourceUrl = new URL('../codexPluginMentions.ts', import.meta.url);
const source = fs.readFileSync(sourceUrl, 'utf8');
const compiled = ts.transpileModule(source, {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
}).outputText;
const module = { exports: {} };
vm.runInNewContext(compiled, { module, exports: module.exports });

const { isSelectedPluginMentionIntact, toCodexPluginPrompt } = module.exports;
const gmail = { id: 'connector_2128aebfecb84f64a069897515042a44', name: 'Gmail' };

test('shows a friendly app name but submits the connector id to Codex', () => {
  assert.equal(
    toCodexPluginPrompt('@Gmail find unread mail', gmail),
    '@connector_2128aebfecb84f64a069897515042a44 find unread mail',
  );
});

test('supports plugin display names containing spaces', () => {
  const calendar = { id: 'connector_calendar', name: 'Google Calendar' };
  assert.equal(
    toCodexPluginPrompt('@Google Calendar what is next?', calendar),
    '@connector_calendar what is next?',
  );
});

test('does not rewrite text after the visible mention is edited', () => {
  assert.equal(toCodexPluginPrompt('@Gmailx find mail', gmail), '@Gmailx find mail');
  assert.equal(isSelectedPluginMentionIntact('@Gmail find mail', gmail), true);
  assert.equal(isSelectedPluginMentionIntact('@GitHub find mail', gmail), false);
});
