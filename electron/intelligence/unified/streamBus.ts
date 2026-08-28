// electron/intelligence/unified/streamBus.ts
//
// The ONE main-side stream registry for the unified pipeline. Replaces:
//   - ipcHandlers._chatStreamId / _chatStreamsBySender / _phoneChatLatestId
//   - IntelligenceEngine.currentGenerationId (delivery-side half)
//   - activeRAGQueries + abortPriorRAGQueriesOfClass
//   - chatStreamRegistry.abortAndInvalidateChatStreams
//
// Preserved semantics (regression-pinned by tests):
//   F-303 — supersession is SURFACE-SCOPED: a stream is keyed by
//           `${surface}:${intent}`, so a phone stream can never supersede a
//           desktop stream (and vice versa). Newest-wins applies per key.
//   R-17  — claim window: the surface is known before the id exists. The
//           renderer-side guard keeps its own claim; the bus exposes
//           claim/release so main-side consumers (phone publish) can consult it.
//   chatStreamRegistry — aborting an entry ALSO deletes it, so every
//           "is this id still current" check is deterministic after abort.
//   TokenBatchFlushNoTrailing — token events batch through setImmediate;
//           done/error/meta flush the pending batch FIRST, then emit.
//
// Delivery is decoupled: the bus emits typed events on an EventEmitter and
// main.ts (or any harness) subscribes and forwards to windows. The bus has
// zero Electron imports so it is fully unit-testable under plain node.

import { EventEmitter } from 'events';
import type { IntelligenceStreamEvent, IntelligenceSurface, StreamIntent } from './types';

export interface UnifiedStreamEntry {
  generationId: number;
  surface: IntelligenceSurface;
  intent: string;
  streamKey: string;
  controller: AbortController;
}

export function streamKeyFor(surface: IntelligenceSurface, intent: string): string {
  return `${surface}:${intent}`;
}

export interface BeginStreamOptions {
  /** Reuse a caller-provided controller (e.g. phone path). Defaults to a new one. */
  controller?: AbortController;
}

export interface BeginStreamResult {
  generationId: number;
  streamKey: string;
  controller: AbortController;
}

interface PendingToken {
  generationId: number;
  surface: IntelligenceSurface;
  intent: StreamIntent | string;
  streamKey: string;
  text: string;
}

/**
 * The bus itself: monotonic ids + per-streamKey newest-wins supersession +
 * deterministic abort-and-invalidate + typed event emission.
 */
export class IntelligenceStreamBus extends EventEmitter {
  private counter = 0;
  private readonly active = new Map<string, UnifiedStreamEntry>();
  private readonly claims = new Map<IntelligenceSurface, number>();

  // ── lifecycle ─────────────────────────────────────────────────────────────

  /**
   * Start a new generation for (surface, intent). Aborts AND deletes the
   * prior same-key entry deterministically (chatStreamRegistry semantics),
   * then mints the next monotonic id.
   */
  begin(
    surface: IntelligenceSurface,
    intent: string,
    options: BeginStreamOptions = {},
  ): BeginStreamResult {
    const streamKey = streamKeyFor(surface, intent);
    const prior = this.active.get(streamKey);
    if (prior) {
      try {
        prior.controller.abort();
      } catch {
        /* already finished — the delete below still must happen */
      }
      // Deleting while iterating is irrelevant here (single lookup), but the
      // delete-before-replace order is load-bearing for deterministic guards.
      this.active.delete(streamKey);
    }

    const generationId = ++this.counter;
    const controller = options.controller ?? new AbortController();
    this.active.set(streamKey, { generationId, surface, intent, streamKey, controller });
    return { generationId, streamKey, controller };
  }

  /** True when (generationId) is still the current generation for its key. */
  isCurrent(generationId: number, surface: IntelligenceSurface, intent: string): boolean {
    const entry = this.active.get(streamKeyFor(surface, intent));
    return entry !== undefined && entry.generationId === generationId;
  }

  currentFor(surface: IntelligenceSurface, intent: string): UnifiedStreamEntry | null {
    return this.active.get(streamKeyFor(surface, intent)) ?? null;
  }

  /** Remove the entry ONLY when it still belongs to this generation (idempotent). */
  end(generationId: number, surface: IntelligenceSurface, intent: string): void {
    const streamKey = streamKeyFor(surface, intent);
    const entry = this.active.get(streamKey);
    if (entry && entry.generationId === generationId) {
      this.active.delete(streamKey);
    }
  }

  /**
   * Abort + invalidate every active stream (optionally scoped to a surface —
   * the modes:set-active path invalidates all; a surface teardown its own).
   * Returns how many entries were invalidated.
   */
  abortAll(surface?: IntelligenceSurface): number {
    let invalidated = 0;
    for (const [key, entry] of this.active) {
      if (surface !== undefined && entry.surface !== surface) continue;
      try {
        entry.controller.abort();
      } catch {
        /* already finished — the delete below still must happen */
      }
      this.active.delete(key);
      invalidated += 1;
    }
    return invalidated;
  }

  // ── claim window (R-17) ───────────────────────────────────────────────────

  /** Mark a surface as having an in-flight request whose id is not yet minted. */
  claim(surface: IntelligenceSurface): void {
    this.claims.set(surface, Date.now());
  }

  releaseClaim(surface: IntelligenceSurface): void {
    this.claims.delete(surface);
  }

  hasClaim(surface: IntelligenceSurface): boolean {
    return this.claims.has(surface);
  }

  /** Full reset (session teardown / engine reset). */
  reset(): void {
    this.abortAll();
    this.claims.clear();
    this.counter = 0;
  }

  // ── event emission ────────────────────────────────────────────────────────

  private emitEvent(event: IntelligenceStreamEvent): void {
    this.emit('event', event);
  }

  emitStart(args: {
    generationId: number;
    surface: IntelligenceSurface;
    intent: StreamIntent | string;
  }): void {
    this.emitEvent({
      type: 'start',
      generationId: args.generationId,
      surface: args.surface,
      intent: args.intent,
      streamKey: streamKeyFor(args.surface, args.intent),
    });
  }

  emitToken(args: {
    generationId: number;
    surface: IntelligenceSurface;
    intent: StreamIntent | string;
    text: string;
  }): void {
    this.emitEvent({
      type: 'token',
      generationId: args.generationId,
      surface: args.surface,
      intent: args.intent,
      streamKey: streamKeyFor(args.surface, args.intent),
      text: args.text,
    });
  }

  emitDone(args: {
    generationId: number;
    surface: IntelligenceSurface;
    intent: StreamIntent | string;
    finalText?: string;
    incomplete?: boolean;
    incompleteReason?: string;
    emittedAt?: number;
    question?: string;
  }): void {
    this.emitEvent({
      type: 'done',
      generationId: args.generationId,
      surface: args.surface,
      intent: args.intent,
      streamKey: streamKeyFor(args.surface, args.intent),
      finalText: args.finalText,
      incomplete: args.incomplete,
      incompleteReason: args.incompleteReason,
      emittedAt: args.emittedAt,
      question: args.question,
    });
  }

  emitError(args: {
    generationId: number;
    surface: IntelligenceSurface;
    intent: StreamIntent | string;
    error: string;
  }): void {
    this.emitEvent({
      type: 'error',
      generationId: args.generationId,
      surface: args.surface,
      intent: args.intent,
      streamKey: streamKeyFor(args.surface, args.intent),
      error: args.error,
    });
  }

  emitMeta(args: {
    generationId: number;
    surface: IntelligenceSurface;
    intent: StreamIntent | string;
    metaKind: NonNullable<IntelligenceStreamEvent['metaKind']>;
    metaPayload?: unknown;
  }): void {
    this.emitEvent({
      type: 'meta',
      generationId: args.generationId,
      surface: args.surface,
      intent: args.intent,
      streamKey: streamKeyFor(args.surface, args.intent),
      metaKind: args.metaKind,
      metaPayload: args.metaPayload,
    });
  }
}

/**
 * Batches token events per flush tick (setImmediate by default) so a burst of
 * provider tokens costs one IPC send, while done/error/meta events flush the
 * pending batch FIRST and then emit immediately — the exact
 * flushBatchesBeforeFinal / TokenBatchFlushNoTrailing contract that the old
 * intelligence-token-batch path had.
 *
 * `schedule`/`cancel` are injectable so tests can drive the flush tick
 * deterministically without real setImmediate.
 */
export class IntelligenceStreamBatcher {
  private readonly pending: IntelligenceStreamEvent[] = [];
  private scheduled: unknown = null;

  constructor(
    private readonly onFlush: (events: IntelligenceStreamEvent[]) => void,
    private readonly schedule: (fn: () => void) => unknown = (fn) => setImmediate(fn),
    private readonly cancel: (handle: unknown) => void = (h) => clearImmediate(h as NodeJS.Immediate),
  ) {}

  /** Token events queue into the next flush; everything else flushes first. */
  push(event: IntelligenceStreamEvent): void {
    if (event.type === 'token') {
      this.pending.push(event);
      if (this.scheduled === null) {
        this.scheduled = this.schedule(() => this.flushNow());
      }
      return;
    }
    // start/done/error/meta: never trail behind pending tokens.
    this.flushNow();
    this.onFlush([event]);
  }

  /** Emit everything pending now and disarm the scheduled flush. */
  flushNow(): void {
    const handle = this.scheduled;
    this.scheduled = null;
    if (handle !== null) this.cancel(handle);
    if (this.pending.length === 0) return;
    const events = this.pending.splice(0, this.pending.length);
    this.onFlush(events);
  }

  /** Drop pending tokens and disarm (teardown / supersession cleanup). */
  cancelPending(): void {
    const handle = this.scheduled;
    this.scheduled = null;
    if (handle !== null) this.cancel(handle);
    this.pending.length = 0;
  }
}

/** Convenience: pipe a bus's events through a batcher (used by main.ts). */
export function pipeBusTo(
  bus: IntelligenceStreamBus,
  onFlush: (events: IntelligenceStreamEvent[]) => void,
  schedule?: (fn: () => void) => unknown,
): { batcher: IntelligenceStreamBatcher; unsubscribe: () => void } {
  const batcher = new IntelligenceStreamBatcher(onFlush, schedule);
  const handler = (event: IntelligenceStreamEvent) => batcher.push(event);
  bus.on('event', handler);
  return { batcher, unsubscribe: () => bus.off('event', handler) };
}
