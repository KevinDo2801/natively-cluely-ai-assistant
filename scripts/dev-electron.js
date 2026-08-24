#!/usr/bin/env node
/**
 * Auto-restarting dev loop for the Electron main process.
 *
 * What it does:
 *   1. Creates an esbuild watch context (via `scripts/build-electron.js`, the
 *      same transpile-only pipeline used by `npm run build:electron`), so every
 *      edit under `electron/` is rebuilt into `dist-electron/` in milliseconds.
 *   2. Launches `electron .` with NODE_ENV=development once the FIRST build
 *      lands. The renderer is served by the Vite dev server (HMR) started by
 *      `app:dev` — this script never runs the production renderer build, so
 *      `npm start` no longer needs a full `vite build`.
 *   3. Restarts Electron automatically every time a watch rebuild completes
 *      (esbuild `onEnd`, not filesystem polling — see build-electron.js).
 *      Renderer changes are applied instantly by Vite HMR; main-process
 *      changes restart the app in ~a second.
 *
 * Usage: `npm run dev:electron` (normally via `npm start` → `app:dev`).
 * Type-check separately: `npm run typecheck:electron` (esbuild is transpile-only).
 *
 * Testing: NATIVELY_DEV_ELECTRON_BIN=<node script> exercises the watch/restart
 * mechanics with a placeholder process instead of opening a real app window
 * (which would also collide with the app's single-instance lock).
 */

const { spawn } = require('node:child_process');
const path = require('node:path');
const treeKill = require('tree-kill');
const { createWatchContext, copyAssets } = require('./build-electron');

const rootDir = path.resolve(__dirname, '..');

// tree-kill maps SIGTERM -> `taskkill /pid <pid> /T` (WM_CLOSE) on Windows,
// which a hidden/minimized launcher may never answer. Force-kill there; the
// app persists continuously and is crash-safe, so this is fine for a dev loop.
const KILL_SIGNAL = process.platform === 'win32' ? 'SIGKILL' : 'SIGTERM';

let electronProc = null;
let buildCtx = null;
let restarting = false;
let restartPending = false;
let initialLaunchDone = false;
let shuttingDown = false;

const log = (...args) => console.log('[dev-electron]', ...args);

function spawnOptions() {
  return {
    cwd: rootDir,
    env: { ...process.env, NODE_ENV: 'development' },
    stdio: 'inherit',
    windowsHide: false,
  };
}

function spawnElectron() {
  if (shuttingDown) return;
  log('launching electron (NODE_ENV=development)...');
  // Requiring 'electron' from plain Node returns the path to the electron binary.
  const overrideBin = process.env.NATIVELY_DEV_ELECTRON_BIN;
  const electronPath = overrideBin || require('electron');
  const proc = overrideBin
    ? spawn(process.execPath, [electronPath, '.'], spawnOptions())
    : spawn(electronPath, ['.'], spawnOptions());

  proc.on('error', (err) => {
    log('failed to spawn electron:', err.message);
    cleanup(() => process.exit(1));
  });

  proc.on('exit', (code, signal) => {
    if (electronProc === proc) electronProc = null;
    if (shuttingDown) return;
    if (restarting) return; // exit caused by our own restart kill
    log(`electron exited unexpectedly (code=${code}, signal=${signal}) — stopping dev loop`);
    // Match `electron:dev` semantics: when the app quits on its own, tear down
    // the whole dev stack (concurrently --kill-others stops Vite too).
    cleanup(() => process.exit(code ?? 1));
  });

  electronProc = proc;
}

/**
 * Called by esbuild with the result of every build (initial + each rebuild).
 */
function onBuildEnd(result) {
  if (shuttingDown) return;
  if (result.errors.length) {
    // esbuild already printed the errors; keep the running app on the last
    // good build instead of restarting into a broken bundle.
    log('build finished with errors — keeping the running app unchanged.');
    return;
  }
  if (!initialLaunchDone) {
    initialLaunchDone = true;
    log('initial build ready — launching electron');
    spawnElectron();
    return;
  }
  restartElectron();
}

function restartElectron() {
  if (shuttingDown) return;
  if (restarting) {
    // A restart is already in flight; re-check when it finishes instead of
    // double-spawning Electron (the app holds a single-instance lock).
    restartPending = true;
    return;
  }
  if (!electronProc) {
    spawnElectron();
    return;
  }
  restarting = true;
  log('main-process code changed — restarting electron...');
  const old = electronProc;
  treeKill(old.pid, KILL_SIGNAL, () => {
    // Safety net in case SIGTERM was ignored (treeKill's callback does not
    // wait for the process to actually exit on POSIX).
    const guard = setTimeout(() => {
      if (electronProc === old) {
        try { process.kill(old.pid, 'SIGKILL'); } catch { /* already gone */ }
      }
    }, 3000);
    old.once('exit', () => clearTimeout(guard));

    const respawn = () => {
      if (shuttingDown) return;
      spawnElectron();
      restarting = false;
      if (restartPending) {
        restartPending = false;
        restartElectron();
      }
    };

    // Wait for the old process to really exit so the single-instance lock and
    // any ports/userData handles are released before the new instance starts.
    if (old.exitCode !== null || old.signalCode !== null) respawn();
    else old.once('exit', respawn);
  });
}

function cleanup(cb) {
  if (shuttingDown) {
    if (cb) cb();
    return;
  }
  shuttingDown = true;
  const tasks = [];
  if (electronProc && electronProc.pid) tasks.push((done) => treeKill(electronProc.pid, KILL_SIGNAL, () => done()));
  if (buildCtx) tasks.push((done) => buildCtx.dispose().then(done, done));
  let remaining = tasks.length;
  if (remaining === 0) {
    if (cb) cb();
    return;
  }
  for (const task of tasks) task(() => {
    remaining -= 1;
    if (remaining === 0 && cb) cb();
  });
}

process.on('SIGINT', () => cleanup(() => process.exit(0)));
process.on('SIGTERM', () => cleanup(() => process.exit(0)));
process.on('exit', () => {
  // Best-effort last resort so a killed terminal doesn't leave an orphan
  // Electron process holding the single-instance lock.
  if (electronProc && electronProc.pid) {
    try { process.kill(electronProc.pid, 'SIGKILL'); } catch { /* gone */ }
  }
});

async function main() {
  log('starting esbuild watch for electron main process...');
  try {
    buildCtx = await createWatchContext(onBuildEnd);
  } catch (err) {
    log('failed to start esbuild watch:', err.message);
    process.exit(1);
  }
  await buildCtx.watch();
  copyAssets();
  log('esbuild watch armed — waiting for the first build...');
  log('dev loop ready — edit files under electron/ and the app restarts itself; press Ctrl+C to stop.');
}

main();
