// TEMPORARY smoke harness for the taskbar show/hide animation (win32).
// Standalone Electron app that mirrors the WindowHelper main-side logic
// (hook + shield + state machine + IPC round trips) against a real renderer
// implementing the LauncherAnimShell contract. Verifies:
//   1. SC_RESTORE hook → shield → open animation → window revealed on ready
//   2. renderer grows to identity; window bounds never change (no setBounds)
//   3. close animation → renderer parks at closed → minimize() only after done
//   4. reopen from the parked state animates again
// Deleted after use.
const { app, BrowserWindow, ipcMain } = require('electron');
const path = require('node:path');

const WM_SYSCOMMAND = 0x0112;
const SC_RESTORE = 0xf120;
const SC_MINIMIZE = 0xf020;
const MASK = 0xfff0;

let failures = 0;
const log = (...a) => console.log('[anim-smoke]', ...a);
const pass = (n) => log('PASS:', n);
const fail = (n, e) => { log('FAIL:', n, e ?? ''); failures += 1; };
const delay = (ms) => new Promise((r) => setTimeout(r, ms));

let win = null;
let restoreArmed = false;
let suppressed = false;
let animState = 'open'; // open | closed | opening | closing
let hookFn = null;

const PAYLOAD = { dx: 0, dy: 300, originX: '50%', originY: '100%', scale: 0.25 };

function install() {
  hookFn = (buf) => {
    if (buf.length < 4) return;
    const cmd = buf.readUInt32LE(0) & MASK;
    log('hook: WM_SYSCOMMAND cmd=0x' + cmd.toString(16) + ' state=' + animState);
    if (cmd === SC_RESTORE) {
      if (suppressed) {
        win.setOpacity(0);
      } else {
        win.setOpacity(0);
        restoreArmed = true;
      }
    } else if (cmd === SC_MINIMIZE) {
      if (animState !== 'open') return;
      suppressed = true;
      win.setOpacity(0);
    }
  };
  win.hookWindowMessage(WM_SYSCOMMAND, hookFn);
  win.on('restore', onRestoreOrShow);
  win.on('show', onRestoreOrShow);
  win.on('minimize', () => {
    if (suppressed) win.restore();
    else win.setOpacity(1);
  });
  ipcMain.on('launcher-anim-open-ready', (e) => {
    if (e.sender !== win.webContents) return;
    log('renderer: open-ready → reveal window');
    win.setOpacity(1);
  });
  ipcMain.on('launcher-anim-close-done', (e) => {
    if (e.sender !== win.webContents) return;
    log('renderer: close-done → minimize');
    animState = 'closed';
    suppressed = false;
    win.minimize();
  });
  return hookFn;
}

function onRestoreOrShow() {
  if (suppressed) {
    restoreArmed = false;
    startClose();
    return;
  }
  if (restoreArmed) {
    restoreArmed = false;
    startOpen();
    return;
  }
  if (animState === 'closed') startOpen();
}

function startOpen() {
  animState = 'opening';
  win.webContents.send('launcher-anim-open', PAYLOAD);
}

function startClose() {
  animState = 'closing';
  win.webContents.send('launcher-anim-close', PAYLOAD);
}

app.whenReady().then(async () => {
  win = new BrowserWindow({
    width: 1000,
    height: 750,
    minWidth: 800,
    minHeight: 600,
    frame: false,
    transparent: true,
    backgroundColor: '#000000',
    show: false,
    webPreferences: {
      preload: path.join(__dirname, 'anim-smoke-preload.cjs'),
    },
  });
  const hookFn = install();
  win.webContents.on('did-finish-load', async () => {
    await delay(300);
    try {
      await run();
    } catch (err) {
      log('ERROR:', err && err.stack ? err.stack : err);
      app.exit(1);
    }
  });
  await win.loadFile(path.join(__dirname, 'anim-smoke.html'));
});

async function evalShell() {
  return win.webContents.executeJavaScript(
    `(() => { const el = document.getElementById('shell'); const s = getComputedStyle(el); return { transform: s.transform, opacity: s.opacity }; })()`,
  );
}

async function run() {
  const boundsAt = () => {
    const b = win.getBounds();
    return `${b.width}x${b.height}@${b.x},${b.y}`;
  };
  const before = boundsAt();

  // ── TEST 1: taskbar restore → open animation ─────────────────────────────
  // Reach the minimized state WITHOUT triggering the SC_MINIMIZE round-trip
  // (unhook, minimize, rehook) — this models a window that was minimized by
  // the app's own end-of-close minimize().
  win.unhookWindowMessage(WM_SYSCOMMAND);
  win.minimize();
  win.hookWindowMessage(WM_SYSCOMMAND, hookFn);
  await delay(350);
  if (win.isMinimized()) pass('window minimized (test setup)');
  else fail('window minimized (test setup)');

  // The taskbar click: win.restore() goes through WM_SYSCOMMAND/SC_RESTORE,
  // exactly like a real taskbar-button click.
  win.restore();
  await delay(200);
  if (win.getOpacity() >= 0.99) pass('window revealed (opacity 1) after open-ready');
  else fail('window revealed', 'opacity=' + win.getOpacity());
  await delay(420); // let the 280ms transition finish
  const cs = await evalShell();
  log('renderer after open:', JSON.stringify(cs));
  if (cs.opacity === '1') pass('renderer opacity settled at 1');
  else fail('renderer opacity settled', cs.opacity);
  if (cs.transform === 'none' || cs.transform.includes('1, 0, 0, 1')) pass('renderer transform settled at identity');
  else fail('renderer transform settled', cs.transform);
  const after1 = boundsAt();
  if (after1 === before) pass('window bounds never changed during OPEN');
  else fail('bounds changed on OPEN', before + ' → ' + after1);

  // ── TEST 2: close animation → minimize only after done ───────────────────
  win.webContents.send('launcher-anim-close', PAYLOAD); // what minimizeWindow triggers
  await delay(150);
  if (win.isMinimized()) fail('minimized TOO EARLY (before close-done)');
  else pass('not minimized before close-done');
  await delay(400);
  if (win.isMinimized()) pass('minimized after close animation finished');
  else fail('minimized after close animation finished');
  const cs2 = await evalShell();
  log('renderer after close:', JSON.stringify(cs2));
  if (cs2.opacity === '0') pass('renderer parked at opacity 0');
  else fail('renderer parked at opacity 0', cs2.opacity);
  const after2 = boundsAt();
  if (after2 === before) pass('window bounds never changed during CLOSE');
  else fail('bounds changed on CLOSE', before + ' → ' + after2);

  // ── TEST 3: reopen from the parked (closed) state ────────────────────────
  win.restore();
  await delay(200);
  if (win.getOpacity() >= 0.99) pass('reopened from parked state');
  else fail('reopened from parked state', 'opacity=' + win.getOpacity());
  await delay(420);
  const cs3 = await evalShell();
  log('renderer after reopen:', JSON.stringify(cs3));
  if (cs3.opacity === '1') pass('renderer back to identity after reopen');
  else fail('renderer identity after reopen', cs3.opacity);

  finish();
}

function finish() {
  if (failures === 0) log('ALL CHECKS PASSED');
  else log(failures + ' CHECK(S) FAILED');
  app.exit(failures === 0 ? 0 : 1);
}

