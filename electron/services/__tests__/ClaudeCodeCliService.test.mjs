import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import {
  ClaudeCodeCliService,
  buildClaudeCodeArgs,
  buildClaudeCodeInput,
  parseClaudeCodeLine,
  classifyClaudeCodeError,
  isClaudeCodeAuthError,
  CLAUDE_CODE_NOT_INSTALLED_MESSAGE,
  CLAUDE_CODE_NOT_SIGNED_IN_MESSAGE,
} from '../../../dist-electron/electron/services/ClaudeCodeCliService.js';
import { resolveClaudeCodeLaunch } from '../../../dist-electron/electron/services/claudeCodeExecutable.js';

// ── Executable resolution: BOTH platform branches, platform injected ─────────

const files = (list) => (p) => list.includes(p);

test('darwin: finds ~/.local/bin/claude even when PATH (GUI launch) lacks it', () => {
  const launch = resolveClaudeCodeLaunch('claude', {
    platform: 'darwin', env: { PATH: '/usr/bin:/bin' }, homedir: '/Users/me', execPath: '/Applications/Natively.app/x',
    exists: files(['/Users/me/.local/bin/claude']),
  });
  assert.equal(launch.command, '/Users/me/.local/bin/claude');
  assert.deepEqual(launch.prefixArgs, []);
  assert.deepEqual(launch.env, {});
});

test('darwin: Apple-silicon Homebrew location is probed', () => {
  const launch = resolveClaudeCodeLaunch('', {
    platform: 'darwin', env: { PATH: '/usr/bin' }, homedir: '/Users/me', execPath: '/x',
    exists: files(['/opt/homebrew/bin/claude']),
  });
  assert.equal(launch.command, '/opt/homebrew/bin/claude');
});

test('win32: prefers claude.exe and spawns it directly', () => {
  const launch = resolveClaudeCodeLaunch('claude', {
    platform: 'win32', env: { PATH: 'C:\\Windows' , APPDATA: 'C:\\Users\\me\\AppData\\Roaming' }, homedir: 'C:\\Users\\me', execPath: 'C:\\app\\Natively.exe',
    exists: files(['C:\\Users\\me\\.local\\bin\\claude.exe']),
  });
  assert.equal(launch.command, 'C:\\Users\\me\\.local\\bin\\claude.exe');
  assert.deepEqual(launch.prefixArgs, []);
});

test('win32: npm claude.cmd shim runs cli.js with the current runtime — no shell', () => {
  const dir = 'C:\\Users\\me\\AppData\\Roaming\\npm';
  const cliJs = `${dir}\\node_modules\\@anthropic-ai\\claude-code\\cli.js`;
  const launch = resolveClaudeCodeLaunch('claude', {
    platform: 'win32', env: { PATH: 'C:\\Windows', APPDATA: 'C:\\Users\\me\\AppData\\Roaming' }, homedir: 'C:\\Users\\me', execPath: 'C:\\app\\Natively.exe',
    exists: files([`${dir}\\claude.cmd`, cliJs]),
  });
  assert.equal(launch.command, 'C:\\app\\Natively.exe');
  assert.deepEqual(launch.prefixArgs, [cliJs]);
  assert.equal(launch.env.ELECTRON_RUN_AS_NODE, '1');
});

test('win32: a .cmd shim without cli.js is unusable (null), never shelled out', () => {
  const dir = 'C:\\Users\\me\\AppData\\Roaming\\npm';
  const launch = resolveClaudeCodeLaunch('claude', {
    platform: 'win32', env: { APPDATA: 'C:\\Users\\me\\AppData\\Roaming' }, homedir: 'C:\\Users\\me', execPath: 'x',
    exists: files([`${dir}\\claude.cmd`]),
  });
  assert.equal(launch, null);
});

test('explicit absolute path is honoured and never silently swapped for another install', () => {
  const deps = (list) => ({ platform: 'darwin', env: { PATH: '/usr/local/bin' }, homedir: '/Users/me', execPath: 'x', exists: files(list) });
  assert.equal(resolveClaudeCodeLaunch('/custom/claude', deps(['/custom/claude', '/usr/local/bin/claude'])).command, '/custom/claude');
  assert.equal(resolveClaudeCodeLaunch('/custom/claude', deps(['/usr/local/bin/claude'])), null);
});

test('unsupported platform fails loudly instead of using another OS path', () => {
  assert.throws(() => resolveClaudeCodeLaunch('claude', { platform: 'linux', env: {}, homedir: '/h', execPath: 'x', exists: () => false }), /Unsupported platform/);
});

// ── Pure helpers ──────────────────────────────────────────────────────────────

test('args disable tools/MCP/settings/persistence and pass system prompt + model', () => {
  const args = buildClaudeCodeArgs('sonnet', 'Be brief.');
  const at = (flag) => args[args.indexOf(flag) + 1];
  assert.ok(args.includes('-p'));
  assert.equal(at('--tools'), '', 'all tools must be disabled');
  assert.ok(args.includes('--strict-mcp-config'));
  assert.ok(args.includes('--no-session-persistence'));
  assert.equal(at('--setting-sources'), '');
  assert.equal(at('--output-format'), 'stream-json');
  assert.equal(at('--model'), 'sonnet');
  assert.equal(at('--system-prompt'), 'Be brief.');
});

test('a model value that looks like a flag is dropped, not forwarded', () => {
  assert.equal(buildClaudeCodeArgs('--dangerously-skip-permissions').includes('--dangerously-skip-permissions'), false);
  assert.equal(buildClaudeCodeArgs('--dangerously-skip-permissions').includes('--model'), false);
});

test('input is one stream-json user line with image blocks before the text', () => {
  const line = buildClaudeCodeInput('hi', [{ mediaType: 'image/jpeg', base64: 'AAA' }]);
  assert.ok(line.endsWith('\n'));
  const msg = JSON.parse(line);
  assert.equal(msg.type, 'user');
  assert.deepEqual(msg.message.content[0], { type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: 'AAA' } });
  assert.deepEqual(msg.message.content[1], { type: 'text', text: 'hi' });
});

test('parser: deltas, assistant text, results, and garbage', () => {
  const delta = JSON.stringify({ type: 'stream_event', event: { type: 'content_block_delta', delta: { type: 'text_delta', text: 'Hel' } } });
  assert.deepEqual(parseClaudeCodeLine(delta), { kind: 'delta', text: 'Hel' });
  assert.equal(parseClaudeCodeLine('not json').kind, 'ignore');
  assert.equal(parseClaudeCodeLine('').kind, 'ignore');
  assert.deepEqual(parseClaudeCodeLine(JSON.stringify({ type: 'result', subtype: 'success', is_error: false, result: 'done' })), { kind: 'result', ok: true, text: 'done' });
  assert.equal(parseClaudeCodeLine(JSON.stringify({ type: 'result', subtype: 'success', is_error: true, result: 'Not logged in · Please run /login' })).ok, false);
});

test('"Not logged in" maps to the actionable sign-in message', () => {
  const msg = classifyClaudeCodeError('Not logged in · Please run /login');
  assert.equal(msg, CLAUDE_CODE_NOT_SIGNED_IN_MESSAGE);
  assert.equal(isClaudeCodeAuthError(new Error(msg)), true);
  assert.equal(isClaudeCodeAuthError(new Error(CLAUDE_CODE_NOT_INSTALLED_MESSAGE)), true);
  assert.equal(isClaudeCodeAuthError(new Error('boom')), false);
});

test('normalizeConfig defaults, clamps, and rejects flag-like models', () => {
  const c = ClaudeCodeCliService.normalizeConfig({ enabled: true, model: '--bad', timeoutMs: 5 });
  assert.equal(c.enabled, true);
  assert.equal(c.model, 'sonnet');
  assert.equal(c.timeoutMs, 90000);
  assert.equal(ClaudeCodeCliService.normalizeConfig({ model: 'claude-opus-4-1' }).model, 'claude-opus-4-1');
});

// ── Streaming against a fake child process ───────────────────────────────────

function fakeChild({ lines = [], stderr = '', code = 0, hang = false }) {
  const child = new EventEmitter();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  const written = [];
  child.stdin = new PassThrough();
  child.stdin.on('data', (d) => written.push(d.toString()));
  child.pid = 1234;
  child.killed = false;
  child.exitCode = null;
  child.written = written;
  setImmediate(() => {
    if (hang) return;
    for (const l of lines) child.stdout.write(l + '\n');
    if (stderr) child.stderr.write(stderr);
    child.stdout.end();
    child.exitCode = code;
    child.emit('close', code);
  });
  return child;
}

const deltaLine = (text) => JSON.stringify({ type: 'stream_event', event: { type: 'content_block_delta', delta: { type: 'text_delta', text } } });
const okResult = (text = '') => JSON.stringify({ type: 'result', subtype: 'success', is_error: false, result: text });

function depsFor(child, spawned = []) {
  return {
    spawn: (command, args, opts) => { spawned.push({ command, args, opts }); return child; },
    resolve: () => ({ command: '/bin/claude', prefixArgs: ['PREFIX'], env: {}, resolvedPath: '/bin/claude' }),
    platform: 'darwin',
    killTree: (c) => { c.killed = true; },
  };
}

test('streams deltas in order and writes the prompt to stdin', async () => {
  const child = fakeChild({ lines: [deltaLine('Hel'), deltaLine('lo'), okResult('Hello')] });
  const spawned = [];
  let out = '';
  for await (const chunk of ClaudeCodeCliService.stream('claude', { prompt: 'say hi', model: 'haiku', timeoutMs: 5000, instructions: 'sys' }, depsFor(child, spawned))) out += chunk;
  assert.equal(out, 'Hello');
  assert.equal(spawned[0].command, '/bin/claude');
  assert.equal(spawned[0].args[0], 'PREFIX', 'launch.prefixArgs must come first (cli.js route on Windows)');
  assert.equal(spawned[0].opts.env.ANTHROPIC_API_KEY, undefined, 'API key must not leak into the subscription provider');
  assert.match(child.written.join(''), /"text":"say hi"/);
});

test('falls back to the final result text when no partial deltas were emitted', async () => {
  const child = fakeChild({ lines: [okResult('whole answer')] });
  assert.equal(await ClaudeCodeCliService.run('claude', { prompt: 'x', model: 'haiku', timeoutMs: 5000 }, depsFor(child)), 'whole answer');
});

test('not-logged-in result throws the actionable sign-in error', async () => {
  const child = fakeChild({ lines: [JSON.stringify({ type: 'result', subtype: 'success', is_error: true, result: 'Not logged in · Please run /login' })], code: 1 });
  await assert.rejects(
    ClaudeCodeCliService.run('claude', { prompt: 'x', model: 'haiku', timeoutMs: 5000 }, depsFor(child)),
    (e) => isClaudeCodeAuthError(e),
  );
});

test('missing install surfaces the install message', async () => {
  const deps = { ...depsFor(fakeChild({})), resolve: () => null };
  await assert.rejects(ClaudeCodeCliService.run('claude', { prompt: 'x', model: 'haiku', timeoutMs: 5000 }, deps), (e) => e.message === CLAUDE_CODE_NOT_INSTALLED_MESSAGE);
});

test('abort kills the process tree and rejects', async () => {
  const child = fakeChild({ hang: true });
  const ac = new AbortController();
  const p = ClaudeCodeCliService.run('claude', { prompt: 'x', model: 'haiku', timeoutMs: 5000, signal: ac.signal }, depsFor(child));
  setTimeout(() => ac.abort(), 20);
  await assert.rejects(p, /aborted/);
  assert.equal(child.killed, true);
});

test('inactivity timeout kills the process and rejects', async () => {
  const child = fakeChild({ hang: true });
  await assert.rejects(
    ClaudeCodeCliService.run('claude', { prompt: 'x', model: 'haiku', timeoutMs: 30 }, depsFor(child)),
    /no output/,
  );
  assert.equal(child.killed, true);
});

test('getAuthStatus parses `claude auth status` JSON', async () => {
  const child = fakeChild({ lines: [JSON.stringify({ loggedIn: true, authMethod: 'claude.ai', email: 'a@b.c' })] });
  const status = await ClaudeCodeCliService.getAuthStatus('claude', depsFor(child));
  assert.deepEqual(status, { installed: true, signedIn: true, method: 'claude.ai', email: 'a@b.c' });
});
