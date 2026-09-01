// electron/intelligence/unified/requestNormalizer.ts
//
// Pure mapping layer (no I/O, no singletons) between the legacy per-surface
// IPC/trigger payloads and the unified IntelligenceRequest. Every surface
// passes through here so the engine sees ONE shape.
//
// Behavioral rule (from the unification plan): `source` + `outputIntent` are
// the ONLY per-surface differences; mapping is deterministic and testable.

import type {
  IntelligenceRequest,
  IntelligenceSource,
  IntelligenceSurface,
  OutputIntent,
  StreamIntent,
} from './types';

// ── source → (outputIntent, streamIntent) ───────────────────────────────────

export interface SourceIntentMap {
  outputIntent: OutputIntent;
  /** Stream intent used when the request carries no explicit refinement intent. */
  streamIntent: StreamIntent;
}

const SOURCE_INTENT_MAP: Record<IntelligenceSource, SourceIntentMap> = {
  manual_chat: { outputIntent: 'assistant_answer', streamIntent: 'chat' },
  what_to_say: { outputIntent: 'speak_for_user', streamIntent: 'what_to_answer' },
  auto_transcript: { outputIntent: 'speak_for_user', streamIntent: 'what_to_answer' },
  recap: { outputIntent: 'summary', streamIntent: 'recap' },
  clarify: { outputIntent: 'clarification', streamIntent: 'clarify' },
  follow_up: { outputIntent: 'assistant_answer', streamIntent: 'rephrase' },
  follow_up_questions: { outputIntent: 'assistant_answer', streamIntent: 'follow_up_questions' },
  code_hint: { outputIntent: 'code', streamIntent: 'what_to_answer' },
  brainstorm: { outputIntent: 'assistant_answer', streamIntent: 'what_to_answer' },
  meeting_search: { outputIntent: 'assistant_answer', streamIntent: 'chat' },
  global_search: { outputIntent: 'assistant_answer', streamIntent: 'chat' },
  phone_mirror: { outputIntent: 'assistant_answer', streamIntent: 'chat' },
};

/** Canonical surface for a source (phone_mirror is the only phone surface). */
export function surfaceFor(source: IntelligenceSource): IntelligenceSurface {
  return source === 'phone_mirror' ? 'phone' : 'desktop';
}

/** The output intent a source always resolves to. */
export function outputIntentFor(source: IntelligenceSource): OutputIntent {
  return SOURCE_INTENT_MAP[source].outputIntent;
}

/** The stream intent a request resolves to (refinement intents override). */
export function streamIntentFor(request: Pick<IntelligenceRequest, 'source' | 'followUpIntent'>): StreamIntent {
  const base = SOURCE_INTENT_MAP[request.source].streamIntent;
  if (request.source === 'follow_up' && request.followUpIntent) {
    return normalizeRefinementIntent(request.followUpIntent);
  }
  return base;
}

/** Map a legacy follow-up refinement label to the canonical StreamIntent. */
export function normalizeRefinementIntent(intent: string): StreamIntent {
  const known: StreamIntent[] = [
    'shorten', 'rephrase', 'expand', 'add_example', 'more_confident',
    'more_casual', 'more_formal', 'simplify',
  ];
  if ((known as string[]).includes(intent)) return intent as StreamIntent;
  return 'rephrase';
}

// ── request normalization ───────────────────────────────────────────────────

export interface NormalizeRequestInput {
  source: IntelligenceSource;
  surface?: IntelligenceSurface;
  requestId?: string;
  text?: string;
  imagePaths?: string[];
  meetingId?: string;
  domContext?: string;
  domContextEnvelope?: unknown;
  screenContext?: unknown;
  promptInstruction?: string;
  skill?: { id: string; name: string; promptBlock: string };
  pinnedModeId?: string | null;
  followUpIntent?: string;
  confidence?: number;
  // Caller-owned prompt contract (quick actions route through manual_chat with
  // a composed system prompt): `context` is the caller's full prompt blob
  // (e.g. the Recap transcript) and `skipSystemPrompt` tells the handler to
  // use it AS the system prompt. These were DROPPED by this whitelist until
  // 2026-08-28 — the recap/clarify/follow-up quick actions silently fell back
  // to the rolling window (or V3 mode evidence) and never saw their composed
  // transcript, which is how "Recap" could answer "there is nothing to recap
  // yet" while the session held a full transcript.
  context?: string;
  skipSystemPrompt?: boolean;
  /** Typed-chat surface marker (manual_chat only) — see IntelligenceRequest. */
  chatSurface?: boolean;
  // auto_transcript extras
  questionId?: string;
  answerability?: number;
  dialogueAct?: string;
  isFollowUp?: boolean;
  endpointSource?: string;
  candidateGeneration?: number;
  reuseSpeculative?: boolean;
}

let fallbackRequestCounter = 0;

/** Deterministic id when the caller did not supply one (trace correlation). */
export function mintRequestId(): string {
  fallbackRequestCounter += 1;
  return `ui-${Date.now().toString(36)}-${fallbackRequestCounter.toString(36)}`;
}

/**
 * Build the canonical request from a legacy payload. Never throws — unknown
 * sources fall back to manual_chat so a bad caller can never kill a turn.
 */
export function normalizeRequest(input: NormalizeRequestInput): IntelligenceRequest {
  const source: IntelligenceSource = SOURCE_INTENT_MAP[input.source] ? input.source : 'manual_chat';
  const surface: IntelligenceSurface = input.surface ?? surfaceFor(source);

  return {
    requestId: input.requestId || mintRequestId(),
    source,
    surface,
    outputIntent: outputIntentFor(source),
    text: input.text,
    imagePaths: input.imagePaths && input.imagePaths.length > 0 ? input.imagePaths.slice(0, 5) : undefined,
    meetingId: input.meetingId,
    domContext: input.domContext,
    domContextEnvelope: input.domContextEnvelope,
    screenContext: input.screenContext as IntelligenceRequest['screenContext'],
    promptInstruction: input.promptInstruction,
    skill: input.skill,
    pinnedModeId: input.pinnedModeId,
    followUpIntent: input.followUpIntent,
    confidence: input.confidence,
    context: input.context,
    skipSystemPrompt: input.skipSystemPrompt,
    chatSurface: input.chatSurface,
    questionId: input.questionId,
    answerability: input.answerability,
    dialogueAct: input.dialogueAct,
    isFollowUp: input.isFollowUp,
    endpointSource: input.endpointSource,
    candidateGeneration: input.candidateGeneration,
    reuseSpeculative: input.reuseSpeculative,
  };
}

// ── legacy IPC payload shapers (one per removed channel) ────────────────────

/**
 * Manual typed chat (was: ipcHandlers gemini-chat-stream).
 */
export function manualChatRequest(input: {
  message: string;
  imagePaths?: string[];
  context?: string;
  skipSystemPrompt?: boolean;
  chatSurface?: boolean;
  pinnedModeId?: string | null;
  requestId?: string;
}): IntelligenceRequest & { legacyContext?: string; skipSystemPrompt?: boolean } {
  const req = normalizeRequest({ source: 'manual_chat', text: input.message, imagePaths: input.imagePaths, chatSurface: input.chatSurface, pinnedModeId: input.pinnedModeId, requestId: input.requestId });
  return { ...req, legacyContext: input.context, skipSystemPrompt: input.skipSystemPrompt };
}

/**
 * What-to-say button / hotkey (was: generate-what-to-say).
 */
export function whatToSayRequest(input: {
  question?: string;
  imagePaths?: string[];
  promptInstruction?: string;
  domContext?: string;
  domContextEnvelope?: unknown;
  screenContext?: unknown;
  pinnedModeId?: string | null;
  requestId?: string;
}): IntelligenceRequest {
  return normalizeRequest({
    source: 'what_to_say',
    text: input.question,
    imagePaths: input.imagePaths,
    promptInstruction: input.promptInstruction,
    domContext: input.domContext,
    domContextEnvelope: input.domContextEnvelope,
    screenContext: input.screenContext,
    pinnedModeId: input.pinnedModeId,
    requestId: input.requestId,
  });
}

/**
 * Quick actions (was: generate-recap / generate-clarify /
 * generate-follow-up / generate-follow-up-questions / generate-code-hint /
 * generate-brainstorm).
 */
export function quickActionRequest(input: {
  source: 'recap' | 'clarify' | 'follow_up' | 'follow_up_questions' | 'code_hint' | 'brainstorm';
  imagePaths?: string[];
  problemStatement?: string;
  followUpIntent?: string;
  userRequest?: string;
  pinnedModeId?: string | null;
  requestId?: string;
}): IntelligenceRequest {
  return normalizeRequest({
    source: input.source,
    text: input.problemStatement || input.userRequest,
    imagePaths: input.imagePaths,
    followUpIntent: input.followUpIntent,
    pinnedModeId: input.pinnedModeId,
    requestId: input.requestId,
  });
}

/**
 * Meeting/global search (was: rag:query-meeting / rag:query-global).
 */
export function searchRequest(input: {
  source: 'meeting_search' | 'global_search';
  query: string;
  meetingId?: string;
  pinnedModeId?: string | null;
  requestId?: string;
}): IntelligenceRequest {
  return normalizeRequest({
    source: input.source,
    text: input.query,
    meetingId: input.meetingId,
    pinnedModeId: input.pinnedModeId,
    requestId: input.requestId,
  });
}

/**
 * Phone-mirror chat command (was: PhoneMirrorService onPhoneCommand 'chat').
 */
export function phoneMirrorRequest(input: {
  message: string;
  pinnedModeId?: string | null;
  requestId?: string;
}): IntelligenceRequest {
  return normalizeRequest({
    source: 'phone_mirror',
    surface: 'phone',
    text: input.message,
    pinnedModeId: input.pinnedModeId,
    requestId: input.requestId,
  });
}
