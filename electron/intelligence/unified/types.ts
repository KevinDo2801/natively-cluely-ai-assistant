// electron/intelligence/unified/types.ts
//
// Unified Intelligence Pipeline — canonical request & stream types.
//
// The unification goal: every chat surface (typed manual chat, What-to-Answer,
// quick actions, auto-answer from transcript, meeting/global search, and
// phone-mirror) becomes ONE engine with ONE request shape and ONE stream
// channel. The only differences between surfaces are `source`, `surface`,
// `outputIntent` and the resulting answer contract — never the architecture.
//
// These types deliberately REUSE the existing planning/context vocabulary
// (AnswerType, VoicePerspective, ProfileContextPolicy, TurnSurface,
// TurnContextContract) instead of inventing a parallel enum set.

import type { ScreenContext } from '../../services/screen/ScreenContextService';

// ── Surfaces & sources ──────────────────────────────────────────────────────

/** The physical/logical surface that originated the request. */
export type IntelligenceSurface = 'desktop' | 'phone';

/** The product surface that originated the request (what the user was doing). */
export type IntelligenceSource =
  | 'manual_chat'
  | 'what_to_say'
  | 'auto_transcript'
  | 'recap'
  | 'clarify'
  | 'follow_up'
  | 'follow_up_questions'
  | 'code_hint'
  | 'brainstorm'
  | 'meeting_search'
  | 'global_search'
  | 'phone_mirror';

/**
 * What KIND of output the user expects. Drives the answer contract only —
 * the pipeline behind every intent is identical.
 */
export type OutputIntent =
  | 'assistant_answer'   // explain/answer the question (manual chat, searches)
  | 'speak_for_user'     // first-person candidate answer (what_to_say, auto)
  | 'summary'            // recap the conversation so far
  | 'clarification'      // ask a clarifying question
  | 'coaching'           // negotiation coaching card
  | 'code';              // code hint / coding answer

/** Stream intent label attached to every token so the renderer routes rows. */
export type StreamIntent =
  | 'chat'
  | 'what_to_answer'
  | 'recap'
  | 'clarify'
  | 'follow_up_questions'
  | 'shorten'
  | 'rephrase'
  | 'expand'
  | 'add_example'
  | 'more_confident'
  | 'more_casual'
  | 'more_formal'
  | 'simplify';

// ── The one request shape ───────────────────────────────────────────────────

export interface IntelligenceRequest {
  /** Unique per request — shared with IntelligenceTrace / PiLatencyTrace. */
  requestId: string;
  source: IntelligenceSource;
  surface: IntelligenceSurface;
  outputIntent: OutputIntent;

  /** The typed/spoken question. Undefined for what_to_say/recap/… (inferred). */
  text?: string;
  /** Screenshot paths attached to the request. */
  imagePaths?: string[];
  /** Meeting id for meeting_search (and RAG scope for meeting surfaces). */
  meetingId?: string;

  // Attached context (mirrors the legacy WTA/manual options).
  domContext?: string;
  domContextEnvelope?: unknown;
  screenContext?: ScreenContext;
  promptInstruction?: string;
  skill?: { id: string; name: string; promptBlock: string };

  /** Mode id pinned at t0 — a mid-request modes:set-active must not split the answer. */
  pinnedModeId?: string | null;
  /** Refinement intent for follow_up (shorten/rephrase/expand/…). */
  followUpIntent?: string;
  /** Trigger confidence (what_to_say / auto_transcript). */
  confidence?: number;

  // ── legacy manual-chat transport seams (removed once every caller is native) ──
  /** Renderer-composed conversation context (was the `context` arg). */
  context?: string;
  /** Caller-owned prompt contract (was options.skipSystemPrompt === true && context). */
  skipSystemPrompt?: boolean;
  /** Typed-chat surface marker (manual_chat only): the answer is READ in the
   *  chat panel, so the scannable chat layout attaches even on the
   *  caller-owned path. Set only by the typed-question call sites; quick
   *  actions and voice/answer-now leave it unset. */
  chatSurface?: boolean;
  /** Answer-surface language policy (manual_chat only, 2026-10): 'speak'
   *  marks questions the user will ASK/Say in the live conversation (e.g.
   *  Follow-up Questions put to the teacher) — they match the language being
   *  spoken, NOT the language the user typed. Absent/'reader' → user's own
   *  typed language (default). */
  languageSurface?: 'reader' | 'speak';

  // ── auto_transcript (Auto Answer V3) metadata ─────────────────────────────
  questionId?: string;
  answerability?: number;
  dialogueAct?: string;
  isFollowUp?: boolean;
  endpointSource?: string;
  candidateGeneration?: number;
  reuseSpeculative?: boolean;
}

// ── The one stream shape ────────────────────────────────────────────────────

/**
 * The unified stream event. Replaces:
 *   - gemini-stream-token/done/error   (manual chat, phone mirror)
 *   - rag:stream-chunk/complete/error  (meeting/global/live RAG answering)
 *   - intelligence-token-batch + the per-intent finalize channels
 *
 * `streamKey = "${surface}:${intent}"` — the renderer applies newest-wins
 * supersession PER streamKey (preserving F-303: desktop and phone never
 * supersede each other; R-17 claim window; CR-01 release semantics).
 */
export type IntelligenceStreamEventType =
  | 'start'
  | 'token'
  | 'done'
  | 'error'
  | 'meta';

export interface IntelligenceStreamEvent {
  type: IntelligenceStreamEventType;
  /** Monotonic, allocated by the bus. Old generations are always dropped. */
  generationId: number;
  surface: IntelligenceSurface;
  /** StreamIntent — which row/queue the renderer routes this into. */
  intent: StreamIntent | string;
  /** `${surface}:${intent}` — the supersession key (F-303). */
  streamKey: string;

  // type === 'token'
  text?: string;
  // type === 'done'
  finalText?: string;
  incomplete?: boolean;
  incompleteReason?: string;
  /** Wall-clock emit time for the renderer's stale-answer label (30s). */
  emittedAt?: number;
  /** Original question the answer belongs to (late-answer labeling). */
  question?: string;
  // type === 'error'
  error?: string;
  // type === 'meta'
  metaKind?: 'code_verified' | 'code_correction' | 'coaching' | 'scaffold_discard' | 'late_answer';
  metaPayload?: unknown;
}

/** The wire envelope for the 'intelligence-stream' channel (1..n events). */
export type IntelligenceStreamPacket = IntelligenceStreamEvent[];

// ── Result of a unified run ─────────────────────────────────────────────────

export interface UnifiedRunResult {
  /** True when the run was accepted and started streaming/emitting. */
  started: boolean;
  generationId: number | null;
  streamKey: string | null;
  /** Deferred/synchronous final answer (legacy IPC invoke compatibility). */
  answer?: string | null;
  question?: string | null;
  /** Non-fatal diagnostics (vision provider used, screen-context status…). */
  diagnostics?: Record<string, unknown>;
  error?: string;
}
