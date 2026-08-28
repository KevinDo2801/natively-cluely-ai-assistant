// UNIFIED PIPELINE (C3) — intelligenceStreamGuard tests.
// Ports the pinned semantics of chatStreamGuard.mjs onto the unified guard:
//   F-303 surface scoping, R-17 claim window, CR-01 release, newest-wins.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  createStreamGuardState,
  resolveStreamToken,
  resolveStreamDone,
  resolveStreamError,
  claimStream,
  IntelligenceStreamGuard,
} from '../intelligenceStreamGuard.mjs';

const token = (generationId, surface = 'desktop') => ({ type: 'token', generationId, surface });
const done = (generationId, surface = 'desktop') => ({ type: 'done', generationId, surface });
const error = (generationId, surface = 'desktop') => ({ type: 'error', generationId, surface });

describe('resolveStreamToken — newest wins', () => {
  test('id-less tokens are always accepted and never change the adopted id', () => {
    const active = createStreamGuardState();
    const d1 = resolveStreamToken(active, token(undefined));
    assert.equal(d1.accept, true);
    assert.equal(d1.active.adoptedId, null);
    const adopted = resolveStreamToken(active, token(5));
    assert.equal(adopted.active.adoptedId, 5);
    const d2 = resolveStreamToken(adopted.active, token(undefined));
    assert.equal(d2.accept, true);
    assert.equal(d2.active.adoptedId, 5, 'id-less token must not change the adopted id');
  });

  test('first id adopts; equal accepts; newer supersedes; older drops', () => {
    let active = createStreamGuardState();
    let d = resolveStreamToken(active, token(10));
    assert.equal(d.accept, true);
    assert.equal(d.active.adoptedId, 10);
    d = resolveStreamToken(d.active, token(10));
    assert.equal(d.accept, true);
    d = resolveStreamToken(d.active, token(11));
    assert.equal(d.accept, true);
    assert.equal(d.active.adoptedId, 11);
    d = resolveStreamToken(d.active, token(10));
    assert.equal(d.accept, false);
    assert.equal(d.active.adoptedId, 11, 'stale token must not change the adopted id');
  });

  test('R-17 claim window: a token from another surface is rejected while claimed', () => {
    const active = claimStream(createStreamGuardState(), 'desktop');
    const d = resolveStreamToken(active, token(7, 'phone'));
    assert.equal(d.accept, false, 'cross-surface token must not win the claimed slot');
    const ok = resolveStreamToken(active, token(7, 'desktop'));
    assert.equal(ok.accept, true);
    assert.equal(ok.active.adoptedId, 7);
    assert.equal(ok.active.claimedSurface, null, 'adoption clears the claim');
  });
});

describe('resolveStreamDone — honor/release semantics', () => {
  test('id-less done honors and clears (back-compat)', () => {
    const d = resolveStreamDone(createStreamGuardState(), done(undefined));
    assert.equal(d.honor, true);
    assert.equal(d.active.adoptedId, null);
  });

  test('done for the adopted id honors and clears', () => {
    const adopted = resolveStreamToken(createStreamGuardState(), token(4)).active;
    const d = resolveStreamDone(adopted, done(4));
    assert.equal(d.honor, true);
    assert.equal(d.active.adoptedId, null);
  });

  test('done for a NEWER id honors and clears', () => {
    const adopted = resolveStreamToken(createStreamGuardState(), token(4)).active;
    const d = resolveStreamDone(adopted, done(5));
    assert.equal(d.honor, true);
    assert.equal(d.active.adoptedId, null);
  });

  test('CR-01: stale done is NOT honored but releases the local surface', () => {
    const adopted = resolveStreamToken(createStreamGuardState(), token(6)).active;
    const d = resolveStreamDone(adopted, done(4));
    assert.equal(d.honor, false);
    assert.equal(d.release, true, 'a done for a superseded generation must release the local spinner');
    assert.equal(d.active.adoptedId, 6, 'stale done must not clear the live adopted id');
  });

  test('claim window done adopts and releases when surfaces match', () => {
    const claimed = claimStream(createStreamGuardState(), 'desktop');
    const d = resolveStreamDone(claimed, done(9, 'desktop'));
    assert.equal(d.honor, true);
    assert.equal(d.release, true);
    assert.equal(d.active.claimedSurface, null);
    assert.equal(d.active.adoptedId, null);
  });
});

describe('resolveStreamError — release + staleness', () => {
  test('phone error never defaces a desktop key but releases when phone owns it', () => {
    const adopted = resolveStreamToken(createStreamGuardState(), token(3, 'phone')).active;
    const d = resolveStreamError(adopted, error(null, 'phone'));
    assert.equal(d.accept, false);
    assert.equal(d.release, true);
  });

  test('stale numeric error is dropped and does not clear the adopted id', () => {
    const adopted = resolveStreamToken(createStreamGuardState(), token(8)).active;
    const d = resolveStreamError(adopted, error(5));
    assert.equal(d.accept, false);
    assert.equal(d.release, false);
    assert.equal(d.active.adoptedId, 8);
  });

  test('an error for the live generation ends the stream', () => {
    const adopted = resolveStreamToken(createStreamGuardState(), token(8)).active;
    const d = resolveStreamError(adopted, error(8));
    assert.equal(d.accept, true);
    assert.equal(d.release, true);
    assert.equal(d.active.adoptedId, null);
  });
});

describe('IntelligenceStreamGuard — per-streamKey isolation (F-303)', () => {
  test('desktop and phone chat streams never supersede each other', () => {
    const guard = new IntelligenceStreamGuard();
    const desktop = guard.resolve({ type: 'token', generationId: 100, surface: 'desktop', intent: 'chat' });
    const phone = guard.resolve({ type: 'token', generationId: 200, surface: 'phone', intent: 'chat' });
    assert.equal(desktop.accept, true);
    assert.equal(phone.accept, true);
    // A late desktop token (generation 100) must still be accepted on its own key.
    const lateDesktop = guard.resolve({ type: 'token', generationId: 100, surface: 'desktop', intent: 'chat' });
    assert.equal(lateDesktop.accept, true, 'phone generation must not supersede the desktop key');
    // A newer desktop token supersedes the old desktop id only.
    const newerDesktop = guard.resolve({ type: 'token', generationId: 101, surface: 'desktop', intent: 'chat' });
    assert.equal(newerDesktop.accept, true);
    const staleDesktop = guard.resolve({ type: 'token', generationId: 100, surface: 'desktop', intent: 'chat' });
    assert.equal(staleDesktop.accept, false);
  });

  test('different intents on the same surface are independent', () => {
    const guard = new IntelligenceStreamGuard();
    guard.resolve({ type: 'token', generationId: 1, surface: 'desktop', intent: 'chat' });
    const wta = guard.resolve({ type: 'token', generationId: 5, surface: 'desktop', intent: 'what_to_answer' });
    assert.equal(wta.accept, true);
    const chatAgain = guard.resolve({ type: 'token', generationId: 1, surface: 'desktop', intent: 'chat' });
    assert.equal(chatAgain.accept, true, 'WTA generation must not supersede the chat key');
  });

  test('done on one key does not clear another key', () => {
    const guard = new IntelligenceStreamGuard();
    guard.resolve({ type: 'token', generationId: 1, surface: 'desktop', intent: 'chat' });
    guard.resolve({ type: 'token', generationId: 9, surface: 'desktop', intent: 'what_to_answer' });
    const d = guard.resolve({ type: 'done', generationId: 1, surface: 'desktop', intent: 'chat' });
    assert.equal(d.honor, true);
    const wtaStill = guard.resolve({ type: 'token', generationId: 9, surface: 'desktop', intent: 'what_to_answer' });
    assert.equal(wtaStill.accept, true, 'the WTA key must survive the chat done');
  });
});
