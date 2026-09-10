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

test('plugin selection keeps the connector id out of the visible composer', () => {
  assert.match(source, /setInputValue\(`@\$\{plugin\.name\} `\)/);
  assert.doesNotMatch(source, /setInputValue\(`@\$\{plugin\.id\} `\)/);
  assert.doesNotMatch(source, /plugin\.description \|\| `@\$\{plugin\.id\}`/);
  assert.match(source, /text: codexSubmitText \|\| 'Analyze this screenshot'/);
});
