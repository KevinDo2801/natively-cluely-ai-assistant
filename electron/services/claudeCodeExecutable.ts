/**
 * claudeCodeExecutable — locate the user's installed Claude Code CLI and decide
 * how to spawn it, per platform.
 *
 * Isolated from ClaudeCodeCliService so each OS branch is testable by injecting
 * `platform` (never by mutating process.platform) — see CLAUDE.md "Testing
 * requirements".
 *
 * Why this is non-trivial:
 *  - macOS: a GUI-launched Electron app inherits a minimal PATH (no Homebrew,
 *    no ~/.local/bin, no nvm), so `claude` is often NOT on PATH even though the
 *    user's terminal finds it. We probe the well-known install locations.
 *  - Windows: the native installer ships `claude.exe`; an npm install ships
 *    `claude.cmd` (+ `.ps1`). Node >= 20.12 refuses to spawn `.cmd` without a
 *    shell (EINVAL), and a shell would force us to quote a multi-line system
 *    prompt through cmd.exe. So for `.cmd` we resolve the package's `cli.js`
 *    and run it with the current runtime (ELECTRON_RUN_AS_NODE=1) instead — an
 *    argv array, no shell, no quoting.
 */

import fs from 'fs';
import os from 'os';
import path from 'path';

export type ClaudeCodePlatform = 'darwin' | 'win32';

export interface ClaudeCodeLaunch {
  /** Executable to hand to child_process.spawn. */
  command: string;
  /** Arguments that must precede the caller's own args (e.g. the cli.js path). */
  prefixArgs: string[];
  /** Extra environment needed to run `command` (ELECTRON_RUN_AS_NODE for cli.js). */
  env: Record<string, string>;
  /** The binary / script the user's install resolved to (for diagnostics). */
  resolvedPath: string;
}

export interface ClaudeCodeResolveDeps {
  platform: NodeJS.Platform;
  env: NodeJS.ProcessEnv;
  homedir: string;
  /** process.execPath — the runtime used to run an npm-installed cli.js. */
  execPath: string;
  exists: (p: string) => boolean;
}

export const defaultClaudeCodeResolveDeps = (): ClaudeCodeResolveDeps => ({
  platform: process.platform,
  env: process.env,
  homedir: os.homedir(),
  execPath: process.execPath,
  exists: (p) => {
    try { return fs.statSync(p).isFile(); } catch { return false; }
  },
});

/** The npm package that contains the Claude Code JS entry point. */
const NPM_PACKAGE_SEGMENTS = ['node_modules', '@anthropic-ai', 'claude-code', 'cli.js'];

function pathApi(platform: NodeJS.Platform): typeof path.posix {
  return (platform === 'win32' ? path.win32 : path.posix) as typeof path.posix;
}

/** Directories to scan, in priority order. PATH first, then known install homes. */
export function claudeCodeSearchDirs(deps: ClaudeCodeResolveDeps): string[] {
  const p = pathApi(deps.platform);
  const sep = deps.platform === 'win32' ? ';' : ':';
  const fromPath = (deps.env.PATH || deps.env.Path || '').split(sep).filter(Boolean);
  const dirs: string[] = [...fromPath];

  if (deps.platform === 'darwin') {
    dirs.push(
      p.join(deps.homedir, '.local', 'bin'),         // native installer
      p.join(deps.homedir, '.claude', 'local'),       // `claude migrate-installer` location
      '/opt/homebrew/bin',                            // Apple Silicon Homebrew
      '/usr/local/bin',                               // Intel Homebrew / npm -g
      p.join(deps.homedir, '.npm-global', 'bin'),
      p.join(deps.homedir, '.bun', 'bin'),
    );
  } else if (deps.platform === 'win32') {
    const appData = deps.env.APPDATA || p.join(deps.homedir, 'AppData', 'Roaming');
    const localAppData = deps.env.LOCALAPPDATA || p.join(deps.homedir, 'AppData', 'Local');
    dirs.push(
      p.join(deps.homedir, '.local', 'bin'),         // native installer
      p.join(appData, 'npm'),                         // npm -g
      p.join(localAppData, 'Programs', 'claude'),
      p.join(localAppData, 'Microsoft', 'WinGet', 'Links'),
    );
  }
  // De-duplicate while preserving order.
  return dirs.filter((d, i) => dirs.indexOf(d) === i);
}

function candidateNames(platform: NodeJS.Platform): string[] {
  // .exe before .cmd on purpose: the native binary is directly spawnable.
  return platform === 'win32' ? ['claude.exe', 'claude.cmd'] : ['claude'];
}

/**
 * Resolve how to launch Claude Code. `configured` is the user's Settings path
 * ('' / 'claude' means auto-detect). Returns null when nothing is found.
 */
export function resolveClaudeCodeLaunch(
  configured: string | undefined,
  deps: ClaudeCodeResolveDeps = defaultClaudeCodeResolveDeps(),
): ClaudeCodeLaunch | null {
  if (deps.platform !== 'darwin' && deps.platform !== 'win32') {
    throw new Error(`Unsupported platform: ${deps.platform}`);
  }
  const p = pathApi(deps.platform);
  const wanted = (configured || '').trim();
  let found: string | null = null;

  if (wanted && wanted !== 'claude' && p.isAbsolute(wanted)) {
    // An explicit absolute path wins and is NOT silently replaced by a
    // different install if it is wrong.
    found = deps.exists(wanted) ? wanted : null;
  } else {
    const names = wanted && wanted !== 'claude' ? [wanted] : candidateNames(deps.platform);
    outer: for (const dir of claudeCodeSearchDirs(deps)) {
      for (const name of names) {
        const candidate = p.join(dir, name);
        if (deps.exists(candidate)) { found = candidate; break outer; }
      }
    }
  }
  if (!found) return null;

  if (deps.platform === 'win32' && /\.(cmd|bat)$/i.test(found)) {
    // npm shim → run the package's cli.js with this runtime; no shell involved.
    const cliJs = p.join(p.dirname(found), ...NPM_PACKAGE_SEGMENTS);
    if (!deps.exists(cliJs)) return null;
    return {
      command: deps.execPath,
      prefixArgs: [cliJs],
      env: { ELECTRON_RUN_AS_NODE: '1' },
      resolvedPath: found,
    };
  }
  return { command: found, prefixArgs: [], env: {}, resolvedPath: found };
}
