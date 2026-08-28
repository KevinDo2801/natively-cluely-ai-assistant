// src/lib/intelligenceStreamGuard.mjs
//
// UNIFIED PIPELINE (C3): the ONE renderer-side supersession guard for the
// 'intelligence-stream' channel. Replaces chatStreamGuard.mjs
// (resolveChatStreamToken / resolveChatStreamDone / resolveLiveAnswerBatch /
// resolveChatStreamSurfaceError) with a single state machine keyed by
// streamKey = `${surface}:${intent}`.
//
// Preserved semantics (regression-pinned by the ported tests):
//   F-303 — supersession is surface-scoped. Each streamKey owns its state, so
//           a phone event never lands on a desktop key (and vice versa).
//   R-17  — claim window: the renderer marks a surface "claimed" the moment a
//           request is sent, BEFORE main mints the generation id. A token from
//           a DIFFERENT surface arriving in that window is rejected, so it
//           cannot adopt the empty placeholder this surface just reserved.
//   CR-01 — a `done` we do NOT honor (stale generation) still releases the
//           local processing state when it belongs to THIS surface, so the
//           spinner stops even though the row is not finalized.
//   newest-wins — within one streamKey, a higher generationId supersedes;
//           older ids are dropped. Id-less events (legacy emitters) are always
//           accepted and never change the adopted id.

/**
 * Per-streamKey guard state.
 * @typedef {{ adoptedId: number | null, claimedSurface: 'desktop' | 'phone' | null }} StreamGuardState
 */

/** @returns {StreamGuardState} */
export function createStreamGuardState() {
  return { adoptedId: null, claimedSurface: null };
}

/**
 * Decide a `token` event. Mirrors resolveChatStreamToken exactly, folded to
 * per-key state (the key already encodes surface scoping).
 * @param {StreamGuardState} active
 * @param {{ generationId?: number | null, surface?: 'desktop' | 'phone' }} event
 * @returns {{ accept: boolean, active: StreamGuardState }}
 */
export function resolveStreamToken(active, event) {
  const incomingId = typeof event.generationId === 'number' ? event.generationId : null;
  const surface = typeof event.surface === 'string' ? event.surface : 'desktop';

  if (incomingId === null) {
    // Backward-compatible: id-less tokens are always accepted and never change
    // the adopted id.
    return { accept: true, active };
  }

  if (active.adoptedId === null) {
    // R-17 claim window: a claim is "surface known, id not yet". A token from
    // a different surface must not win the empty slot this surface reserved.
    if (active.claimedSurface !== null && active.claimedSurface !== surface) {
      return { accept: false, active };
    }
    return { accept: true, active: { ...active, adoptedId: incomingId, claimedSurface: null } };
  }

  if (incomingId === active.adoptedId) return { accept: true, active };
  if (incomingId > active.adoptedId) {
    // A newer generation on the SAME key superseded the one we were rendering.
    return { accept: true, active: { ...active, adoptedId: incomingId } };
  }
  // An older, already-superseded stream is still trickling. Drop.
  return { accept: false, active };
}

/**
 * Decide a `done` event. `release` (CR-01) is set when a done is NOT honored
 * but still belongs to a request THIS surface started — the caller must stop
 * its own processing indicator even though the row is not finalized.
 * @param {StreamGuardState} active
 * @param {{ generationId?: number | null, surface?: 'desktop' | 'phone' }} event
 * @returns {{ honor: boolean, active: StreamGuardState, release: boolean }}
 */
export function resolveStreamDone(active, event) {
  const incomingId = typeof event.generationId === 'number' ? event.generationId : null;
  const surface = typeof event.surface === 'string' ? event.surface : 'desktop';

  if (incomingId === null) {
    // No id → backward-compatible: honor and clear.
    return { honor: true, active: { adoptedId: null, claimedSurface: null }, release: false };
  }

  if (active.adoptedId === null) {
    // Claim window: a done carrying an id while we hold a same-surface claim
    // belongs to the request we just started — adopt and honor.
    if (active.claimedSurface !== null && active.claimedSurface === surface) {
      return { honor: true, active: { adoptedId: null, claimedSurface: null }, release: true };
    }
    return { honor: false, active, release: false };
  }

  if (incomingId >= active.adoptedId) {
    return { honor: true, active: { adoptedId: null, claimedSurface: null }, release: false };
  }

  // Stale done for an already-superseded stream — ignore, keep current active,
  // but release the LOCAL spinner (CR-01) so it never spins forever.
  return { honor: false, active, release: true };
}

/**
 * Decide an `error` event. Phone-mirror errors are deliberately discarded from
 * a desktop row but must still RELEASE the guard when the phone surface owns
 * it (R-02): a provider that throws AFTER committing tokens never sends a
 * done, so without the release the guard stays pinned forever.
 * @param {StreamGuardState} active
 * @param {{ generationId?: number | null, surface?: 'desktop' | 'phone' }} event
 * @returns {{ accept: boolean, active: StreamGuardState, release: boolean }}
 */
export function resolveStreamError(active, event) {
  const incomingId = typeof event.generationId === 'number' ? event.generationId : null;
  const surface = typeof event.surface === 'string' ? event.surface : 'desktop';

  // Phone-mirror error on a desktop-owned key: never deface the row; release
  // only when the phone surface owns the guard.
  if (surface === 'phone') {
    const release = active.claimedSurface === 'phone' || active.adoptedId !== null;
    return { accept: false, active, release };
  }

  if (incomingId !== null && active.adoptedId !== null && incomingId !== active.adoptedId) {
    // Stale error for another generation — drop, keep current active.
    return { accept: false, active, release: false };
  }

  // An error always ends its own stream.
  return { accept: true, active: { adoptedId: null, claimedSurface: null }, release: true };
}

/**
 * Mark a surface as claimed (R-17): the renderer sent a request and is waiting
 * for main to mint the generation id. Releasing is implicit on adoption.
 * @param {StreamGuardState} active
 * @param {'desktop' | 'phone'} surface
 * @returns {StreamGuardState}
 */
export function claimStream(active, surface) {
  return { ...active, claimedSurface: surface };
}

/**
 * Small per-hook wrapper: one state object per streamKey, mutated in place.
 */
export class IntelligenceStreamGuard {
  constructor() {
    /** @type {Map<string, StreamGuardState>} */
    this.keys = new Map();
  }

  _state(streamKey) {
    let s = this.keys.get(streamKey);
    if (!s) {
      s = createStreamGuardState();
      this.keys.set(streamKey, s);
    }
    return s;
  }

  /**
   * @param {{ surface?: 'desktop' | 'phone' }} event
   */
  claim(event) {
    const surface = typeof event.surface === 'string' ? event.surface : 'desktop';
    const key = `${surface}:chat`;
    this.keys.set(key, claimStream(this._state(key), surface));
  }

  release(surface, intent = 'chat') {
    const key = `${surface}:${intent}`;
    this.keys.set(key, createStreamGuardState());
  }

  /**
   * @param {{ streamKey?: string, surface?: 'desktop' | 'phone', intent?: string, generationId?: number | null, type?: string }} event
   */
  resolve(event) {
    const surface = typeof event.surface === 'string' ? event.surface : 'desktop';
    const intent = typeof event.intent === 'string' ? event.intent : 'chat';
    const streamKey = event.streamKey || `${surface}:${intent}`;
    const state = this._state(streamKey);
    let decision;
    if (event.type === 'token') decision = resolveStreamToken(state, event);
    else if (event.type === 'done') decision = resolveStreamDone(state, event);
    else if (event.type === 'error') decision = resolveStreamError(state, event);
    else return { accept: true, honor: true, release: false, active: state };
    this.keys.set(streamKey, decision.active);
    return decision;
  }
}
