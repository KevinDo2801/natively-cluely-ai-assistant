import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '../../..');
const read = (relative) => fs.readFileSync(path.join(root, relative), 'utf8');

test('launcher renders every shared audio mode and passes the selection into Start', () => {
  const launcher = read('src/components/Launcher.tsx');
  const app = read('src/App.tsx');

  assert.match(launcher, /AUDIO_SOURCE_MODES\.map\(\(source\)/);
  assert.match(launcher, /setMeetingAudioSource\?\.\(source\)/);
  assert.match(launcher, /onStartMeeting\(audioSource\)/);
  assert.match(app, /audio:\s*\{\s*inputDeviceId,\s*outputDeviceId,\s*source:\s*audioSource\s*\}/);
});

test('main process gates permissions, capture startup, and route watcher by selected source', () => {
  const main = read('electron/main.ts');

  assert.match(main, /normalizeAudioSourceMode\(metadata\?\.audio\?\.source\s*\?\?\s*storedAudioSource\)/);
  assert.match(main, /!this\._ambientChatEnabled\s*&&\s*captureMicrophone/);
  assert.match(main, /!this\._ambientChatEnabled\s*&&\s*captureSystemAudio/);
  assert.match(main, /startCaptureChannels\('startMeeting',\s*audioSource\)/);
  assert.match(main, /if\s*\(captureSystemAudio\)\s*this\.startDefaultOutputWatcher\(\)/);
  assert.match(main, /audioSourceIncludesMicrophone\(this\._activeAudioSource\)/);
  assert.match(main, /audioSourceIncludesSystem\(this\._activeAudioSource\)/);
});

test('audio source preference is validated and persisted through IPC', () => {
  const settings = read('electron/services/SettingsManager.ts');
  const ipc = read('electron/ipc/settingsFlags.ts');
  const preload = read('electron/preload.ts');

  assert.match(settings, /meetingAudioSource\?:\s*AudioSourceMode/);
  assert.match(ipc, /safeHandle\('get-meeting-audio-source'/);
  assert.match(ipc, /safeHandle\('set-meeting-audio-source'/);
  assert.match(ipc, /isAudioSourceMode\(source\)/);
  assert.match(preload, /ipcRenderer\.invoke\('set-meeting-audio-source',\s*source\)/);
});
