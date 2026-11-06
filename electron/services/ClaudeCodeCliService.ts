/**
 * ClaudeCodeCliService — use the user's own Claude Code login (Pro/Max plan)
 * as a text/vision provider by driving the official `claude` CLI in print mode.
 *
 * Why a CLI subprocess and not the OAuth token directly: Anthropic does not
 * allow third-party apps to reuse the Claude subscription's OAuth token, so
 * Natively never reads or stores it. The official `claude` binary owns the
 * login (`claude auth login`) and the token; we only spawn it, exactly like a
 * user running `claude -p` in a terminal. Usage counts against the user's
 * Claude plan limits, not against an API key.
 *
 * Invocation (see buildClaudeCodeArgs):
 *   claude -p --input-format stream-json --output-format stream-json
 *          --include-partial-messages --verbose --tools "" ...
 * The prompt (and any screenshots, as base64 image blocks) goes in as ONE
 * stream-json user message on stdin; text arrives as `content_block_delta`
 * events on stdout.
 *
 * Safety / isolation:
 *  - `--tools ""`: the model gets NO tools (no file, shell or web access), so a
 *    prompt-injected transcript cannot make it touch the machine.
 *  - `--strict-mcp-config`, `--disable-slash-commands`, `--setting-sources ""`,
 *    `--no-session-persistence`: ignore the user's MCP servers / skills /
 *    settings and leave no session files behind.
 *  - cwd is the OS temp dir so no project CLAUDE.md is picked up.
 *  - ANTHROPIC_API_KEY / ANTHROPIC_AUTH_TOKEN are stripped from the child env so
 *    a stray key in the shell cannot silently switch this provider from the
 *    subscription to metered API billing. (API-key users have the regular
 *    Claude provider.)
 */

import { spawn as nodeSpawn, type ChildProcessWithoutNullStreams } from 'child_process';
import os from 'os';
import sharp from 'sharp';
import {
  claudeCodeSearchDirs,
  defaultClaudeCodeResolveDeps,
  resolveClaudeCodeLaunch,
  type ClaudeCodeLaunch,
} from './claudeCodeExecutable';

// ── Messages (matched by isClaudeCodeAuthError; keep in one place) ───────────
export const CLAUDE_CODE_NOT_INSTALLED_MESSAGE =
  'Claude Code is not installed. Install it from https://claude.com/claude-code, then sign in from Settings → AI Providers.';
export const CLAUDE_CODE_NOT_SIGNED_IN_MESSAGE =
  'Not signed in to Claude Code. Please sign in from Settings → AI Providers.';

export function isClaudeCodeAuthError(err: unknown): boolean {
  const message = (err as { message?: unknown } | null | undefined)?.message;
  if (typeof message !== 'string') return false;
  return message.includes(CLAUDE_CODE_NOT_SIGNED_IN_MESSAGE)
    || message.includes(CLAUDE_CODE_NOT_INSTALLED_MESSAGE);
}

// ── Config ───────────────────────────────────────────────────────────────────
export interface ClaudeCodeCliConfig {
  enabled: boolean;
  /** '' / 'claude' = auto-detect; otherwise an absolute path to the binary. */
  path: string;
  /** Alias (`sonnet`, `opus`, `haiku`) or a full model name. */
  model: string;
  fastModel: string;
  /** Inactivity timeout: no output from the CLI for this long aborts the turn. */
  timeoutMs: number;
}

export const DEFAULT_CLAUDE_CODE_CLI_CONFIG: ClaudeCodeCliConfig = {
  enabled: false,
  path: 'claude',
  model: 'sonnet',
  fastModel: 'haiku',
  timeoutMs: 90_000,
};

/** Models offered in the picker. Aliases track the latest model of each tier. */
export const CLAUDE_CODE_MODEL_PRESETS: ReadonlyArray<{ id: string; name: string }> = [
  { id: 'sonnet', name: 'Claude Sonnet (latest)' },
  { id: 'opus', name: 'Claude Opus (latest)' },
  { id: 'haiku', name: 'Claude Haiku (latest)' },
  // Pinned versions. Opus 5.5 / Fable 5.1 are rejected by older Claude Code
  // builds with an "update required" error, which is shown to the user as-is.
  { id: 'claude-fable-5-1', name: 'Claude Fable 5.1' },
  { id: 'claude-opus-5-5', name: 'Claude Opus 5.5' },
  { id: 'claude-sonnet-5-5', name: 'Claude Sonnet 5.5' },
  { id: 'claude-haiku-5-5', name: 'Claude Haiku 5.5' },
  { id: 'claude-sonnet-4-6', name: 'Claude Sonnet 4.6' },
  { id: 'claude-opus-4-1', name: 'Claude Opus 4.1' },
  { id: 'claude-haiku-4-5', name: 'Claude Haiku 4.5' },
];

// A model value is passed as ONE argv element (no shell), but keep it to a
// conservative charset so a malformed settings value can't smuggle in a flag.
const MODEL_RE = /^[A-Za-z0-9][A-Za-z0-9._:\-[\]]{0,99}$/;

export interface ClaudeCodeRunOptions {
  prompt: string;
  model: string;
  timeoutMs: number;
  imagePaths?: string[];
  /** System prompt, passed via --system-prompt (replaces Claude Code's default). */
  instructions?: string;
  signal?: AbortSignal;
}

// ── Pure helpers (exported for tests) ────────────────────────────────────────

export function buildClaudeCodeArgs(model: string, instructions?: string): string[] {
  const args = [
    '-p',
    '--input-format', 'stream-json',
    '--output-format', 'stream-json',
    '--include-partial-messages',
    '--verbose',
    '--tools', '',
    '--strict-mcp-config',
    '--disable-slash-commands',
    '--setting-sources', '',
    '--no-session-persistence',
  ];
  if (model && MODEL_RE.test(model)) args.push('--model', model);
  if (instructions && instructions.trim()) args.push('--system-prompt', instructions);
  return args;
}

export interface ClaudeCodeImage { mediaType: string; base64: string }

/** The single stream-json user message written to stdin. */
export function buildClaudeCodeInput(prompt: string, images: ClaudeCodeImage[] = []): string {
  const content: unknown[] = [];
  for (const img of images) {
    content.push({ type: 'image', source: { type: 'base64', media_type: img.mediaType, data: img.base64 } });
  }
  content.push({ type: 'text', text: prompt });
  return JSON.stringify({ type: 'user', message: { role: 'user', content } }) + '\n';
}

export type ClaudeCodeStreamEvent =
  | { kind: 'delta'; text: string }
  | { kind: 'assistant-text'; text: string }
  | { kind: 'result'; ok: boolean; text: string }
  | { kind: 'ignore' };

/** Parse one stdout line of `--output-format stream-json`. Never throws. */
export function parseClaudeCodeLine(line: string): ClaudeCodeStreamEvent {
  const trimmed = line.trim();
  if (!trimmed) return { kind: 'ignore' };
  let ev: any;
  try { ev = JSON.parse(trimmed); } catch { return { kind: 'ignore' }; }
  if (ev?.type === 'stream_event') {
    const d = ev.event?.type === 'content_block_delta' ? ev.event.delta : null;
    if (d?.type === 'text_delta' && typeof d.text === 'string' && d.text) return { kind: 'delta', text: d.text };
    return { kind: 'ignore' };
  }
  if (ev?.type === 'assistant') {
    const blocks = Array.isArray(ev.message?.content) ? ev.message.content : [];
    const text = blocks.filter((b: any) => b?.type === 'text' && typeof b.text === 'string').map((b: any) => b.text).join('');
    return text ? { kind: 'assistant-text', text } : { kind: 'ignore' };
  }
  if (ev?.type === 'result') {
    return { kind: 'result', ok: ev.is_error !== true && ev.subtype === 'success', text: typeof ev.result === 'string' ? ev.result : '' };
  }
  return { kind: 'ignore' };
}

/** Map a CLI failure message to the actionable errors the UI recognises. */
export function classifyClaudeCodeError(message: string): string {
  if (/not logged in|please run \/login|invalid api key|authentication|oauth token has expired|401/i.test(message)) {
    return CLAUDE_CODE_NOT_SIGNED_IN_MESSAGE;
  }
  return message || 'Claude Code returned an error.';
}

// ── Process plumbing ─────────────────────────────────────────────────────────

export type SpawnFn = (command: string, args: string[], options: {
  cwd: string; env: NodeJS.ProcessEnv; windowsHide: boolean; stdio: ['pipe', 'pipe', 'pipe'];
}) => ChildProcessWithoutNullStreams;

export interface ClaudeCodeDeps {
  spawn: SpawnFn;
  resolve: (configured: string | undefined) => ClaudeCodeLaunch | null;
  platform: NodeJS.Platform;
  /** Kill the child and its descendants. Injectable for tests. */
  killTree: (child: ChildProcessWithoutNullStreams) => void;
}

function defaultKillTree(child: ChildProcessWithoutNullStreams): void {
  if (child.pid === undefined || child.killed) return;
  if (process.platform === 'win32') {
    // POSIX signals do not reach a Windows process tree; taskkill /T does.
    try {
      nodeSpawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' }).on('error', () => { try { child.kill(); } catch { /* gone */ } });
    } catch { try { child.kill(); } catch { /* gone */ } }
    return;
  }
  try { child.kill('SIGTERM'); } catch { /* gone */ }
  const t = setTimeout(() => { try { child.kill('SIGKILL'); } catch { /* gone */ } }, 2000);
  t.unref?.();
}

export const defaultClaudeCodeDeps = (): ClaudeCodeDeps => ({
  spawn: nodeSpawn as unknown as SpawnFn,
  resolve: (configured) => resolveClaudeCodeLaunch(configured, defaultClaudeCodeResolveDeps()),
  platform: process.platform,
  killTree: defaultKillTree,
});

function childEnv(launch: ClaudeCodeLaunch): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env, ...launch.env };
  delete env.ANTHROPIC_API_KEY;
  delete env.ANTHROPIC_AUTH_TOKEN;
  // Do not inherit "we are inside a Claude Code session" markers.
  delete env.CLAUDECODE;
  // GUI-launched macOS apps have a minimal PATH; make sure node/git shims that
  // sit next to the CLI are findable by it.
  const sep = process.platform === 'win32' ? ';' : ':';
  const extra = claudeCodeSearchDirs(defaultClaudeCodeResolveDeps()).join(sep);
  env.PATH = [env.PATH || env.Path || '', extra].filter(Boolean).join(sep);
  return env;
}

const IMAGE_MAX_EDGE = 1568; // Claude's recommended max long edge

async function encodeImage(imagePath: string): Promise<ClaudeCodeImage | null> {
  try {
    const buf = await sharp(imagePath)
      .resize(IMAGE_MAX_EDGE, IMAGE_MAX_EDGE, { fit: 'inside', withoutEnlargement: true })
      .jpeg({ quality: 85 })
      .toBuffer();
    return { mediaType: 'image/jpeg', base64: buf.toString('base64') };
  } catch {
    // Unreadable/corrupt capture: skip rather than ship an unvalidated blob.
    return null;
  }
}
// ── Service ──────────────────────────────────────────────────────────────────

export class ClaudeCodeCliService {
  public static normalizeConfig(config: Partial<ClaudeCodeCliConfig> = {}): ClaudeCodeCliConfig {
    const timeoutMs = Number(config.timeoutMs);
    const clean = (v: unknown, fallback: string) => (typeof v === 'string' && v.trim() ? v.trim() : fallback);
    const model = clean(config.model, DEFAULT_CLAUDE_CODE_CLI_CONFIG.model);
    const fastModel = clean(config.fastModel, DEFAULT_CLAUDE_CODE_CLI_CONFIG.fastModel);
    return {
      enabled: !!config.enabled,
      path: clean(config.path, DEFAULT_CLAUDE_CODE_CLI_CONFIG.path),
      model: MODEL_RE.test(model) ? model : DEFAULT_CLAUDE_CODE_CLI_CONFIG.model,
      fastModel: MODEL_RE.test(fastModel) ? fastModel : DEFAULT_CLAUDE_CODE_CLI_CONFIG.fastModel,
      timeoutMs: Number.isFinite(timeoutMs) && timeoutMs >= 1000 ? timeoutMs : DEFAULT_CLAUDE_CODE_CLI_CONFIG.timeoutMs,
    };
  }

  public static async run(configuredPath: string, options: ClaudeCodeRunOptions, deps: ClaudeCodeDeps = defaultClaudeCodeDeps()): Promise<string> {
    let out = '';
    for await (const chunk of this.stream(configuredPath, options, deps)) out += chunk;
    return out;
  }

  public static async *stream(
    configuredPath: string,
    options: ClaudeCodeRunOptions,
    deps: ClaudeCodeDeps = defaultClaudeCodeDeps(),
  ): AsyncGenerator<string, void, unknown> {
    if (options.signal?.aborted) throw new Error('Claude Code request aborted before start.');

    const launch = deps.resolve(configuredPath);
    if (!launch) throw new Error(CLAUDE_CODE_NOT_INSTALLED_MESSAGE);

    const images: ClaudeCodeImage[] = [];
    for (const p of options.imagePaths || []) {
      const encoded = await encodeImage(p);
      if (encoded) images.push(encoded);
    }

    const args = [...launch.prefixArgs, ...buildClaudeCodeArgs(options.model, options.instructions)];
    const child = deps.spawn(launch.command, args, {
      cwd: os.tmpdir(),
      env: childEnv(launch),
      windowsHide: true,
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    // ── Queue bridging child events to the async generator ──────────────────
    const queue: string[] = [];
    let wake: (() => void) | null = null;
    let finished = false;
    let failure: Error | null = null;
    let sawDelta = false;
    let lastAssistantText = '';
    let stdoutBuf = '';
    let stderrBuf = '';
    let timer: NodeJS.Timeout | undefined;

    const notify = () => { const w = wake; wake = null; w?.(); };
    const fail = (err: Error) => { if (!failure) failure = err; finished = true; deps.killTree(child); notify(); };
    const armTimer = () => {
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => fail(new Error(`Claude Code produced no output for ${Math.round(options.timeoutMs / 1000)}s.`)), options.timeoutMs);
    };
    const onAbort = () => fail(new Error('Claude Code request aborted.'));
    options.signal?.addEventListener('abort', onAbort, { once: true });
    armTimer();

    const handleLine = (line: string) => {
      const ev = parseClaudeCodeLine(line);
      if (ev.kind === 'delta') { sawDelta = true; queue.push(ev.text); notify(); }
      else if (ev.kind === 'assistant-text') { lastAssistantText = ev.text; }
      else if (ev.kind === 'result') {
        if (!ev.ok) { fail(new Error(classifyClaudeCodeError(ev.text))); return; }
        // Non-partial fallback: nothing streamed, so emit the final text once.
        if (!sawDelta) { const t = ev.text || lastAssistantText; if (t) { queue.push(t); notify(); } }
      }
    };

    child.stdout.on('data', (chunk: Buffer) => {
      armTimer();
      stdoutBuf += chunk.toString('utf8');
      let nl: number;
      while ((nl = stdoutBuf.indexOf('\n')) >= 0) {
        handleLine(stdoutBuf.slice(0, nl));
        stdoutBuf = stdoutBuf.slice(nl + 1);
      }
    });
    child.stderr.on('data', (chunk: Buffer) => { stderrBuf = (stderrBuf + chunk.toString('utf8')).slice(-4000); });
    child.on('error', (err: NodeJS.ErrnoException) => {
      fail(new Error(err.code === 'ENOENT' ? CLAUDE_CODE_NOT_INSTALLED_MESSAGE : `Could not start Claude Code: ${err.message}`));
    });
    child.on('close', (code) => {
      if (stdoutBuf.trim()) handleLine(stdoutBuf);
      stdoutBuf = '';
      if (!failure && code !== 0 && code !== null) {
        failure = new Error(classifyClaudeCodeError(stderrBuf.trim()) || `Claude Code exited with code ${code}.`);
      }
      finished = true;
      notify();
    });

    try {
      child.stdin.on('error', () => { /* child exited before reading; surfaced via close */ });
      child.stdin.write(buildClaudeCodeInput(options.prompt, images));
      child.stdin.end();

      while (true) {
        if (queue.length) { yield queue.shift() as string; continue; }
        if (finished) break;
        await new Promise<void>((resolve) => { wake = resolve; });
      }
      // Anything queued between the last delta and `finished`.
      while (queue.length) yield queue.shift() as string;
      if (failure) throw failure;
    } finally {
      if (timer) clearTimeout(timer);
      options.signal?.removeEventListener('abort', onAbort);
      if (!finished || child.exitCode === null) deps.killTree(child);
    }
  }

  // ── Account management (shells out to `claude auth ...`) ───────────────────

  private static runOnce(
    configuredPath: string,
    args: string[],
    timeoutMs: number,
    deps: ClaudeCodeDeps,
  ): Promise<{ code: number | null; stdout: string; stderr: string }> {
    return new Promise((resolve, reject) => {
      const launch = deps.resolve(configuredPath);
      if (!launch) { reject(new Error(CLAUDE_CODE_NOT_INSTALLED_MESSAGE)); return; }
      const child = deps.spawn(launch.command, [...launch.prefixArgs, ...args], {
        cwd: os.tmpdir(), env: childEnv(launch), windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'],
      });
      let stdout = ''; let stderr = '';
      const t = setTimeout(() => { deps.killTree(child); reject(new Error('Claude Code did not respond in time.')); }, timeoutMs);
      child.stdout.on('data', (c: Buffer) => { stdout += c.toString('utf8'); });
      child.stderr.on('data', (c: Buffer) => { stderr += c.toString('utf8'); });
      child.on('error', (err: NodeJS.ErrnoException) => {
        clearTimeout(t);
        reject(new Error(err.code === 'ENOENT' ? CLAUDE_CODE_NOT_INSTALLED_MESSAGE : err.message));
      });
      child.on('close', (code) => { clearTimeout(t); resolve({ code, stdout, stderr }); });
      child.stdin.on('error', () => { /* ignore */ });
      child.stdin.end();
    });
  }

  public static async getAuthStatus(configuredPath: string, deps: ClaudeCodeDeps = defaultClaudeCodeDeps()): Promise<{ installed: boolean; signedIn: boolean; method?: string; email?: string; error?: string }> {
    try {
      const { code, stdout, stderr } = await this.runOnce(configuredPath, ['auth', 'status'], 20_000, deps);
      try {
        const parsed = JSON.parse(stdout.trim());
        return { installed: true, signedIn: parsed?.loggedIn === true, method: parsed?.authMethod, email: parsed?.email };
      } catch {
        return { installed: true, signedIn: false, error: (stderr || stdout).trim() || `claude auth status exited with ${code}` };
      }
    } catch (e: any) {
      return { installed: e?.message !== CLAUDE_CODE_NOT_INSTALLED_MESSAGE, signedIn: false, error: e?.message };
    }
  }

  /** Opens the browser sign-in owned by the official CLI. Resolves when it exits. */
  public static async login(configuredPath: string, deps: ClaudeCodeDeps = defaultClaudeCodeDeps()): Promise<{ success: boolean; error?: string }> {
    try {
      const { code, stderr } = await this.runOnce(configuredPath, ['auth', 'login'], 300_000, deps);
      return code === 0 ? { success: true } : { success: false, error: stderr.trim() || 'Sign-in did not complete. Run `claude auth login` in a terminal.' };
    } catch (e: any) {
      return { success: false, error: e?.message };
    }
  }

  public static async logout(configuredPath: string, deps: ClaudeCodeDeps = defaultClaudeCodeDeps()): Promise<{ success: boolean; error?: string }> {
    try {
      const { code, stderr } = await this.runOnce(configuredPath, ['auth', 'logout'], 30_000, deps);
      return code === 0 ? { success: true } : { success: false, error: stderr.trim() || 'Sign-out failed.' };
    } catch (e: any) {
      return { success: false, error: e?.message };
    }
  }
}
