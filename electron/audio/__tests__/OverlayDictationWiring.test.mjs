import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '..', '..', '..');
const read = (path) => readFileSync(resolve(root, path), 'utf8');

test('overlay dictation is wired from composer through the existing audio stack', () => {
  const renderer = read('src/components/NativelyInterface.tsx');
  const preload = read('electron/preload.ts');
  const ipc = read('electron/ipcHandlers.ts');
  const main = read('electron/main.ts');

  assert.match(renderer, /aria-label=\{\s*dictationState === 'idle' \? 'Dictate'/);
  assert.match(renderer, /Pause and transcribe/);
  assert.match(renderer, /<Pause className=/);
  assert.match(renderer, /onDictationLevel/);
  assert.match(renderer, /dictationLevels\.map/);
  assert.match(renderer, /setInputValue\(\(current\)[\s\S]*spokenText/);

  for (const channel of ['dictation:start', 'dictation:stop', 'dictation:cancel']) {
    assert.match(preload, new RegExp(channel.replace(':', '\\:')));
    assert.match(ipc, new RegExp(channel.replace(':', '\\:')));
  }
  assert.match(preload, /ipcRenderer\.on\('dictation:level'/);
  assert.match(preload, /ipcRenderer\.on\('dictation:finished'/);
  assert.match(main, /new MicrophoneCapture\(requestedDeviceId\)/);
  assert.match(main, /createSTTProvider\('user'\)/);
});

// The composer reuses its TWO existing controls instead of adding a second row
// of action buttons: the dictate slot becomes Pause (review path) and the send
// slot becomes the up arrow (transcribe-and-send path).
test('the composer exposes both a review-only and a transcribe-and-send stop', () => {
  const renderer = read('src/components/NativelyInterface.tsx');

  assert.match(
    renderer,
    /if \(dictationState === 'recording'\) void runStopDictation\(false\);/,
    'the pause slot must transcribe into the composer without sending',
  );
  assert.match(
    renderer,
    /if \(dictationState === 'recording'\) void runStopDictation\(true\);/,
    'the send slot must transcribe AND send',
  );

  // Icon swap: Mic → Pause → spinner on the dictate slot, ArrowRight → ArrowUp
  // → spinner on the send slot. The Pause/ArrowUp branch keys on
  // `dictationState !== 'idle'` (not `=== 'recording'`) so the icon does not flip
  // back during the brief transcription window that follows a stop.
  assert.match(
    renderer,
    /dictateSlotBusy\s*\?\s*<RefreshCw[\s\S]{0,140}?dictationState !== 'idle'[\s\S]{0,140}?<Pause[\s\S]{0,140}?<Mic/,
    'the dictate slot must render Mic → Pause → spinner',
  );
  assert.match(
    renderer,
    /sendSlotBusy\s*\?\s*<RefreshCw[\s\S]{0,140}?dictationState !== 'idle'[\s\S]{0,140}?<ArrowUp[\s\S]{0,140}?<ArrowRight/,
    'the send slot must render ArrowRight → ArrowUp → spinner',
  );

  // The deferred submit must not read a stale composer value: handleManualSubmit
  // closes over `inputValue`, so the send flag has to be set on finish and then
  // consumed by a post-render effect.
  assert.match(
    renderer,
    /if \(options\?\.send\) dictationSendPendingRef\.current = true/,
    'the transcribe-and-send path must arm the deferred-send flag',
  );
  assert.match(
    renderer,
    /if \(!dictationSendPendingRef\.current\) return;[\s\S]{0,500}?handleManualSubmitRef\.current\(\)/,
    'a post-render effect must consume the flag and submit',
  );
  // …and the stop handler itself must never submit: it runs before React has
  // written the transcript into inputValue, so it would send the previous draft.
  const stopHandler = renderer.slice(
    renderer.indexOf('const runStopDictation'),
    renderer.indexOf('const cancelDictation'),
  );
  assert.ok(stopHandler.length > 0, 'runStopDictation must exist');
  assert.ok(
    !stopHandler.includes('handleManualSubmit'),
    'runStopDictation must not submit inline — it would read the pre-update composer',
  );
});

// The recording row carries ONLY Cancel + the waveform. Its previous stop/send
// buttons were removed so the actions live on the composer's existing controls;
// re-adding a button there would duplicate every action.
test('the recording row holds only the cancel button and the waveform', () => {
  const renderer = read('src/components/NativelyInterface.tsx');

  const rowStart = renderer.indexOf("{dictationState !== 'idle' && (");
  const waveIdx = renderer.indexOf('dictationLevels.map');
  assert.ok(rowStart > 0 && waveIdx > rowStart, 'the recording row must exist');

  const rowHead = renderer.slice(rowStart, waveIdx);
  assert.equal(
    (rowHead.match(/<button/g) || []).length,
    1,
    'the recording row must contain exactly one button (cancel)',
  );
  assert.match(rowHead, /aria-label="Cancel dictation"/);

  // Both stop actions must live AFTER the waveform — i.e. in the composer row
  // BELOW it, not inside the recording row.
  const stopReviewIdx = renderer.indexOf('runStopDictation(false)');
  const stopSendIdx = renderer.indexOf('runStopDictation(true)');
  assert.ok(stopReviewIdx > waveIdx, 'the review stop must live in the composer row, not the recording row');
  assert.ok(stopSendIdx > waveIdx, 'the send stop must live in the composer row, not the recording row');
});

// The dictate control sits in the composer's bottom row, grouped with the send
// arrow. It must NOT be absolutely positioned over the textarea: in that slot it
// covered the input's right edge (and the ↵ hint that the textarea's `pr-10`
// reserves for it).
test('the dictate button sits in the composer row, immediately left of send', () => {
  const renderer = read('src/components/NativelyInterface.tsx');

  // Anchored on the slot's own labels rather than on `data-dictation-control`,
  // whose FIRST occurrence in the file is the mousedown predicate that reads the
  // attribute, not a button.
  const dictateIdx = renderer.indexOf("dictationState === 'idle' ? 'Dictate'");
  const sendIdx = renderer.indexOf("dictationState === 'idle' ? 'Send'");
  assert.ok(dictateIdx > 0, 'the dictate control must exist');
  assert.ok(sendIdx > 0, 'the send control must exist');
  assert.ok(dictateIdx < sendIdx, 'dictate must render to the LEFT of send');

  // Adjacency, asserted structurally rather than by character distance: the send
  // control must be the VERY NEXT button after the dictate control, so nothing
  // can be inserted between them without failing here.
  const dictateBtnStart = renderer.lastIndexOf('<button', dictateIdx);
  const segment = renderer.slice(dictateBtnStart, sendIdx);
  assert.equal(
    (segment.match(/<button/g) || []).length,
    2,
    'send must be the next control after dictate — same row cluster, nothing between them',
  );

  // The button element itself: normal flow, not the moved-out-of overlay slot.
  const element = renderer.slice(renderer.lastIndexOf('<button', dictateIdx), dictateIdx);
  assert.ok(
    !/\babsolute\b/.test(element),
    'the dictate button must not overlay the input — it belongs in the composer row',
  );

  // …and the ↵ affordance it displaced must be back in the textarea's right slot.
  assert.match(
    renderer,
    /!inputValue && dictationState === 'idle' && \([\s\S]{0,300}?absolute right-3[\s\S]{0,200}?<span className="text-\[10px\]">↵<\/span>/,
    'the Enter-to-send hint must be restored in the slot the dictate button vacated',
  );
});

// Cmd+B collapses the shell without unmounting it (the OS window is hidden and
// the subtree goes `inert`), so the unmount cleanup never runs. Without an
// explicit collapse guard the microphone stays live behind a hidden panel.
test('collapsing the overlay ends an in-flight dictation', () => {
  const renderer = read('src/components/NativelyInterface.tsx');
  assert.match(
    renderer,
    /if \(isExpanded \|\| !dictationActiveRef\.current\) return;[\s\S]{0,200}?cancelDictation\(\);/,
    'an in-flight dictation must be cancelled when the overlay collapses',
  );
});

test('raw dictation audio never crosses into the renderer', () => {
  const ipc = read('electron/ipcHandlers.ts');
  const preload = read('electron/preload.ts');
  assert.doesNotMatch(ipc, /dictation:(?:audio|chunk|pcm)/);
  assert.doesNotMatch(preload, /dictation:(?:audio|chunk|pcm)/);
});
