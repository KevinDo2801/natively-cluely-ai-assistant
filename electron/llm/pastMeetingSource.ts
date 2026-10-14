// electron/llm/pastMeetingSource.ts
//
// Evidence from FINISHED meetings for a typed chat question, chosen by how
// relevant it is rather than by whether the question contains the right words.
//
// WHY THIS REPLACES THE KEYWORD GATE
// Past-meeting recall used to run only when a regex found a past-time marker AND
// a meeting noun together ("hôm qua" + "họp"). "tiết trước thầy dạy gì" or "bài
// giảng tuần trước" never matched, so the idle chat never searched old meetings
// at all, and nobody could tell it had skipped them. Here the search runs for
// any question that names something, and what is admitted is decided by the
// evidence itself.
//
// ADMISSION (first rule that applies)
//   explicit       the question names a past meeting (regex signal, now only a
//                  hint): keep the best-ranked chunks, as the old path did.
//   semantic_floor the active embedding space has a CALIBRATED cosine floor
//                  (semanticAdmissionGate): keep chunks at or above it.
//   lexical        everything else, including the local MiniLM space whose
//                  relevant and irrelevant cosines overlap too much to threshold
//                  (see semanticAdmissionGate): keep chunks that share enough
//                  distinctive words with the question.
//
// Bounded: one retrieval raced against a deadline; a miss, a timeout or an error
// adds nothing. Pure apart from the injected `search` / `describeMeeting`.

import { tokenizeForRelevance } from '../../src/lib/chatRelevance';
import type { ProviderDataScope, ProviderDataScopePolicy } from './ProviderRouter';
import { isCoveredByContext, withDeadline } from './callerOwnedChatEnrichment';

export interface PastMeetingChunk {
  meetingId: string;
  text: string;
  startMs?: number;
  similarity: number;
}

export interface PastMeetingLimits {
  /** Hard deadline for the cross-meeting search. */
  searchMs: number;
  topK: number;
  maxTokens: number;
  /** Cap on the characters of recalled text. */
  blockChars: number;
  /** Larger cap when the whole latest meeting is the subject. */
  recentBlockChars: number;
  maxMeetings: number;
  /** Shared distinctive words needed by the lexical rule (capped by the question's own count). */
  minSharedTokens: number;
  /** Fraction of a chunk's distinctive tokens already in the context ⇒ duplicate. */
  duplicateOverlap: number;
}

export const DEFAULT_PAST_MEETING_LIMITS: PastMeetingLimits = {
  searchMs: 1200,
  topK: 12,
  maxTokens: 1400,
  blockChars: 3200,
  recentBlockChars: 6000,
  maxMeetings: 3,
  minSharedTokens: 2,
  duplicateOverlap: 0.8,
};

export type PastMeetingAdmission = 'recent' | 'explicit' | 'semantic_floor' | 'lexical';
export type PastMeetingSkip =
  | 'scope_denied'
  | 'empty_question'
  | 'no_search'
  | 'timeout'
  | 'failed'
  | 'no_candidates'
  | 'none_relevant'
  | 'no_recent_meeting';

export interface PastMeetingInput {
  question: string;
  /** Regex signal that the question names a past meeting. A hint, not a gate. */
  explicit: boolean;
  /**
   * The question names the MOST RECENT finished meeting ("the meeting just now").
   * Such a question is generic and shares no words with the transcript, so
   * similarity cannot admit the right passages; recency selects them instead.
   */
  recent?: boolean;
  /** Meetings that must never be recalled (the one happening now, the live index). */
  excludeMeetingIds?: readonly string[];
  /** Calibrated cosine floor of the active embedding space; null/undefined ⇒ none. */
  semanticFloor?: number | null;
  /** Text already in the prompt: recalled chunks that repeat it are dropped. */
  composedContext?: string;
  /** Live privacy toggles (undefined ⇒ allowed, matching the transport). */
  scopePolicy?: ProviderDataScopePolicy;
  deps: {
    search?: (query: string, opts: { topK: number; maxTokens: number }) => Promise<PastMeetingChunk[]>;
    /** Passages of the latest finished meeting, in order; used when `recent` is set. */
    latestMeeting?: () => Promise<PastMeetingChunk[]>;
    describeMeeting?: (meetingId: string) => { title?: string; date?: string } | null;
    now?: () => number;
  };
  limits?: Partial<PastMeetingLimits>;
}

export interface PastMeetingResult {
  block: string;
  dataScopes: ProviderDataScope[];
  meetings: string[];
  chunks: number;
  candidates: number;
  /** Raw hits from the search, before exclusions — tells "nothing indexed" from "all excluded". */
  retrieved?: number;
  excluded?: number;
  admittedBy?: PastMeetingAdmission;
  timedOut: boolean;
  skipped?: PastMeetingSkip;
  ms: number;
}

const SCOPE: ProviderDataScope = 'transcript';

const HEADING =
  '[RELEVANT PASSAGES FROM EARLIER MEETINGS — recordings of OTHER, finished meetings, older than anything above. '
  + 'Use them only when the question is about those meetings; ignore them otherwise:]';

const isDistinctive = (t: string): boolean => t.length >= 3 || /[^\u0000-\u007f]/.test(t);

const distinctiveTokens = (text: string): string[] => [...new Set(tokenizeForRelevance(text).filter(isDistinctive))];

function formatDate(date: string | undefined): string {
  if (!date) return '';
  const d = new Date(date);
  return Number.isNaN(d.getTime()) ? '' : d.toISOString().slice(0, 10);
}

export async function buildPastMeetingBlock(input: PastMeetingInput): Promise<PastMeetingResult> {
  const now = input.deps.now ?? Date.now;
  const t0 = now();
  const limits: PastMeetingLimits = { ...DEFAULT_PAST_MEETING_LIMITS, ...input.limits };
  const done = (partial: Partial<PastMeetingResult>): PastMeetingResult => ({
    block: '',
    dataScopes: [],
    meetings: [],
    chunks: 0,
    candidates: 0,
    timedOut: false,
    ...partial,
    ms: now() - t0,
  });

  const question = String(input.question ?? '').trim();
  if (!question) return done({ skipped: 'empty_question' });
  if (input.scopePolicy?.[SCOPE] === false) return done({ skipped: 'scope_denied' });
  const recent = Boolean(input.recent && input.deps.latestMeeting);
  const search = recent ? undefined : input.deps.search;
  if (!recent && !search) return done({ skipped: 'no_search' });

  const res = await withDeadline(
    Promise.resolve().then(() => (recent
      ? input.deps.latestMeeting!()
      : search!(question, { topK: limits.topK, maxTokens: limits.maxTokens }))),
    limits.searchMs,
  );
  if (res.timedOut) return done({ skipped: 'timeout', timedOut: true });
  if (res.failed) return done({ skipped: 'failed' });

  const excluded = new Set(input.excludeMeetingIds ?? []);
  const retrieved = (res.value ?? []).length;
  const candidates = (res.value ?? []).filter(
    (c) => c && typeof c.text === 'string' && c.text.trim() && c.meetingId && !excluded.has(c.meetingId),
  );
  const excludedCount = retrieved - candidates.length;
  if (candidates.length === 0) {
    return done({ skipped: recent ? 'no_recent_meeting' : 'no_candidates', retrieved, excluded: excludedCount });
  }

  // Drop passages the prompt already carries (the live path's own transcript).
  let fresh = candidates;
  if (input.composedContext) {
    const contextTokens = new Set(tokenizeForRelevance(input.composedContext));
    fresh = candidates.filter((c) => !isCoveredByContext(c.text, contextTokens, limits.duplicateOverlap));
    if (fresh.length === 0) return done({ skipped: 'none_relevant', candidates: candidates.length });
  }

  const questionTokens = distinctiveTokens(question);
  const shared = new Map<PastMeetingChunk, number>();
  for (const c of fresh) {
    const tokens = new Set(tokenizeForRelevance(c.text));
    shared.set(c, questionTokens.filter((t) => tokens.has(t)).length);
  }

  let admittedBy: PastMeetingAdmission;
  let admitted: PastMeetingChunk[];
  if (recent) {
    admittedBy = 'recent';
    admitted = fresh;
  } else if (input.explicit) {
    admittedBy = 'explicit';
    admitted = fresh;
  } else if (typeof input.semanticFloor === 'number') {
    admittedBy = 'semantic_floor';
    admitted = fresh.filter((c) => c.similarity >= input.semanticFloor!);
  } else {
    admittedBy = 'lexical';
    const need = Math.min(limits.minSharedTokens, questionTokens.length);
    admitted = need > 0 ? fresh.filter((c) => (shared.get(c) ?? 0) >= need) : [];
  }
  if (admitted.length === 0) return done({ skipped: 'none_relevant', candidates: candidates.length, admittedBy });

  // Best chunks first, by shared words then cosine; whole meetings are then
  // ranked by their best chunk so a few meetings contribute coherent passages.
  const ranked = recent
    ? [...admitted]
    : [...admitted].sort((a, b) => (shared.get(b) ?? 0) - (shared.get(a) ?? 0) || b.similarity - a.similarity);
  const meetingOrder: string[] = [];
  for (const c of ranked) if (!meetingOrder.includes(c.meetingId)) meetingOrder.push(c.meetingId);
  const chosen = meetingOrder.slice(0, limits.maxMeetings);

  const sections: string[] = [];
  const usedMeetings: string[] = [];
  let used = 0;
  let chunkCount = 0;
  for (const meetingId of chosen) {
    const parts: string[] = [];
    for (const c of ranked.filter((x) => x.meetingId === meetingId).sort((a, b) => (a.startMs ?? 0) - (b.startMs ?? 0))) {
      const t = c.text.trim();
      if (used + t.length > (recent ? limits.recentBlockChars : limits.blockChars)) break;
      parts.push(t);
      used += t.length;
    }
    if (parts.length === 0) continue;
    let info: { title?: string; date?: string } | null = null;
    try { info = input.deps.describeMeeting?.(meetingId) ?? null; } catch { info = null; }
    const date = formatDate(info?.date);
    const label = `${info?.title ? `"${info.title}"` : 'Earlier meeting'}${date ? `, ${date}` : ''}`;
    sections.push(`--- ${label} ---\n${parts.join('\n')}`);
    usedMeetings.push(meetingId);
    chunkCount += parts.length;
  }
  if (sections.length === 0) return done({ skipped: 'none_relevant', candidates: candidates.length, admittedBy });

  return done({
    block: `${HEADING}\n${sections.join('\n\n')}`,
    dataScopes: [SCOPE],
    meetings: usedMeetings,
    chunks: chunkCount,
    candidates: candidates.length,
    retrieved,
    excluded: excludedCount,
    admittedBy,
  });
}
