import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const source = fs.readFileSync(path.resolve(here, '../NativelyInterface.tsx'), 'utf8');

test('plugin picker stays in the measured overlay flow instead of a clipped fixed portal', () => {
  assert.match(
    source,
    /\{pluginPickerQuery !== null && \(\s*<PluginPicker/,
    'plugin picker should render inline whenever an @ query is active',
  );
  assert.doesNotMatch(
    source,
    /createPortal\(\s*<PluginPicker/,
    'plugin picker must not escape the measured shell through a portal',
  );
  assert.doesNotMatch(
    source,
    /function PluginPicker[\s\S]*?position:\s*['"]fixed['"]/,
    'plugin picker must not use fixed positioning outside BrowserWindow bounds',
  );
});

test('plugin picker exposes the ChatGPT-style discovery states', () => {
  assert.match(source, /id="codex-plugin-picker"/);
  assert.match(source, /plugin\.logoUrl/);
  assert.match(source, /No plugins found/);
  assert.match(source, /Type to search connected plugins/);
  assert.match(source, /aria-autocomplete="list"/);
});

test('plugin selection renders as an inline one-turn composer mention', () => {
  assert.match(source, /setSelectedPluginMention\(\{ id: plugin\.id, name: plugin\.name, logoUrl: plugin\.logoUrl \}\)/);
  assert.doesNotMatch(source, /setInputValue\(`@\$\{plugin\.id\} `\)/);
  assert.doesNotMatch(source, /plugin\.description \|\| `@\$\{plugin\.id\}`/);
  assert.match(source, /findExplicitlyMentionedCodexPlugin\(userText, availablePlugins\)/);
  assert.match(source, /codexApp: pluginForSubmit/);
  assert.match(source, /Plugin turns are actions, not Lecture\/Sales/);
  assert.match(source, /Do not guess permission or connection errors/);
  assert.match(source, /data-testid="selected-plugin-inline-mention"/);
  assert.match(source, /selectedPluginMentionInset/);
  assert.match(source, /<button\s+ref=\{composerPluginMentionElementRef\}\s+type="button"\s+data-testid="selected-plugin-inline-mention"/);
  assert.doesNotMatch(source, /ref=\{composerPluginMentionElementRef\}[\s\S]{0,160}Pick a different browser tab/);
  assert.match(source, /getBoundingClientRect\(\)\.width/);
  assert.match(source, /12 \+ composerPluginMentionWidth \+ 10/);
  assert.doesNotMatch(source, /Math\.min\(selectedPluginMention\.name\.length/);
  assert.match(source, /selected-plugin-inline-mention[\s\S]{0,500}text-\[13px\][\s\S]{0,100}leading-relaxed/);
  assert.doesNotMatch(source, /selected-plugin-inline-mention[\s\S]{0,500}h-\[21px\]/);
  assert.doesNotMatch(source, /Active for follow-up messages/);
  assert.match(source, /onClick=\{\(\) => setSelectedPluginMention\(null\)\}/);
  assert.match(source, /setInputValue\(''\);\s*setSelectedPluginMention\(null\);\s*setAttachedContext/);
});

test('sent plugin message preserves and renders the selected app mention', () => {
  assert.match(source, /pluginMention\?: SelectedCodexPluginMention/);
  assert.match(source, /pluginMention: explicitPluginForSubmit/);
  assert.match(source, /data-testid="sent-plugin-inline-mention"/);
  assert.match(source, /msg\.pluginMention\.name/);
  assert.match(source, /<span>\{msg\.text\}<\/span>/);
  assert.doesNotMatch(source, /sent-plugin-inline-mention[\s\S]{0,500}flex-1/);
  assert.match(source, /getSafePluginLogoUrl\(msg\.pluginMention\.logoUrl\)/);
});

test('plugin clarification follow-ups keep routing without a visible active badge', () => {
  assert.match(source, /activePluginForFollowups/);
  assert.match(source, /const pluginForSubmit = explicitPluginForSubmit \|\| activePluginForFollowups/);
  assert.match(source, /setActivePluginForFollowups\(explicitPluginForSubmit\)/);
  assert.doesNotMatch(source, /Active for follow-up messages/);
  assert.match(source, /pluginMention: explicitPluginForSubmit/);
});

test('plugin actions render a user-controlled confirmation card', () => {
  assert.match(source, /function CodexPluginInteractionCard/);
  assert.match(source, /onCodexPluginInteraction/);
  assert.match(source, /onCodexPluginInteractionClosed/);
  assert.match(source, /resolveCodexPluginInteraction/);
  assert.match(source, /Confirm plugin action/);
  assert.match(source, /void respond\('decline'\)/);
  assert.match(source, /void respond\('accept'\)/);
  assert.match(source, /property\.type === 'array'/);
  assert.match(source, /property\.oneOf/);
});
