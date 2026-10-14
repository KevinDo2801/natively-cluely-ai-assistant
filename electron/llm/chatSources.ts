// electron/llm/chatSources.ts
//
// ONE place that decides which sources a typed chat turn may draw on, by how
// relevant they are to the question — reference files, the live meeting, and
// earlier meetings.
//
// WHY THIS EXISTS
// Typed chat has two assembly paths (see ipcHandlers manual-chat):
//   live-transcript  the renderer composes the prompt (transcript + history +
//                    reference files); the main process only appends extras.
//   idle             no transcript; Context Intelligence V3 retrieves evidence.
// Each path used to make its OWN source decisions: reference files by a
// zero-evidence passthrough on one and a character cap on the other, earlier
// meetings by a keyword regex that diverted the whole turn into a separate RAG
// answer, the live meeting by a context-length heuristic. The same question got
// different sources depending on the path, and no turn ever said which sources
// it had considered. Here the decision is one pure function, `planChatSources`,
// and the two paths differ only in HOW the chosen sources are attached.
//
// The providers stay where they were (modeReferencePassthrough,
// callerOwnedChatEnrichment, pastMeetingSource); this module only decides, runs
// them concurrently, merges their blocks, and reports what happened.
//
// Pure: no Electron, no I/O. Production wiring is in chatSourcesWiring.ts.

import { isLatestMeetingQuestion, isPastMeetingRecallQuestion } from '../../src/lib/pastMeetingRecall';
import { tokenizeForRelevance } from '../../src/lib/chatRelevance';
import { isVagueChatQuestion } from '../../src/lib/vagueQuestion';
import type { ProviderDataScope, ProviderDataScopePolicy } from './ProviderRouter';
import type { EnrichmentResult } from './callerOwnedChatEnrichment';
import { buildModeReferencePassthrough, type PassthroughFile } from './modeReferencePassthrough';
import {
  buildPastMeetingBlock,
  type PastMeetingInput,
  type PastMeetingLimits,
  type PastMeetingResult,
} from './pastMeetingSource';

export type ChatPath = 'live-transcript' | 'idle';

export interface SourceDecision {
  use: boolean;
  /** Short machine-readable reason, logged so a skipped source is never silent. */
  why: string;
}

export interface ChatSourcePlan {
  path: ChatPath;
  referenceFiles: SourceDecision;
  liveMeeting: SourceDecision;
  pastMeetings: SourceDecision & { explicit: boolean; recent: boolean };
}

export interface PlanInput {
  path: ChatPath;
  question: string;
  hasImages: boolean;
  attachedFileCount: number;
  liveMeetingQueryable: boolean;
  pastMeetingsQueryable: boolean;
  /** A meeting is being recorded right now. "The meeting just now" then means the live one. */
  meetingActive?: boolean;
  scopePolicy?: ProviderDataScopePolicy;
}

const denied = (scope: ProviderDataScope, policy?: ProviderDataScopePolicy): boolean => policy?.[scope] === false;

export function planChatSources(input: PlanInput): ChatSourcePlan {
  const question = String(input.question ?? '').trim();
  const live = input.path === 'live-transcript';

  const referenceFiles: SourceDecision = live
    // chatOverlayContext already put the relevant parts of the files in the prompt.
    ? { use: false, why: 'renderer_composed' }
    : input.attachedFileCount === 0
      ? { use: false, why: 'no_files' }
      : denied('reference_files', input.scopePolicy)
        ? { use: false, why: 'scope_denied' }
        : { use: true, why: 'attached_to_mode' };

  const liveMeeting: SourceDecision = !live
    // V3's own meeting port owns the current meeting on this path.
    ? { use: false, why: 'v3_meeting_port' }
    : !input.liveMeetingQueryable
      ? { use: false, why: 'not_indexed' }
      : denied('transcript', input.scopePolicy)
        ? { use: false, why: 'scope_denied' }
        : { use: true, why: 'long_meeting_recall' };

  const explicit = Boolean(question) && isPastMeetingRecallQuestion(question);
  const recent = Boolean(question) && isLatestMeetingQuestion(question) && !input.meetingActive;
  const pastMeetings: SourceDecision & { explicit: boolean; recent: boolean } = (() => {
    if (!question) return { use: false, why: 'empty_question', explicit, recent };
    if (input.hasImages) return { use: false, why: 'screenshot_turn', explicit, recent };
    if (!input.pastMeetingsQueryable) return { use: false, why: 'rag_not_ready', explicit, recent };
    if (denied('transcript', input.scopePolicy)) return { use: false, why: 'scope_denied', explicit, recent };
    if (recent) return { use: true, why: 'latest_meeting', explicit, recent };
    if (explicit) return { use: true, why: 'names_past_meeting', explicit, recent };
    // "explain that" / "what did she say" point at the latest words, not at an old meeting.
    if (isVagueChatQuestion(question)) return { use: false, why: 'vague_followup', explicit, recent };
    if (tokenizeForRelevance(question).length === 0) return { use: false, why: 'no_content_words', explicit, recent };
    return { use: true, why: 'relevance_search', explicit, recent };
  })();

  return { path: input.path, referenceFiles, liveMeeting, pastMeetings };
}

// ── execution ───────────────────────────────────────────────────────────────

export interface ChatSourceDeps {
  /** Live-meeting recall (and nothing else) for the live-transcript path. */
  liveMeeting?: (composedContext: string) => Promise<EnrichmentResult>;
  /** Cross-meeting search plumbing for earlier meetings. */
  pastMeetings?: Pick<PastMeetingInput, 'excludeMeetingIds' | 'semanticFloor'> & { deps: PastMeetingInput['deps'] };
}

export interface ChatSourceContext {
  question: string;
  /** The caller-composed prompt already in flight (live-transcript path). */
  composedContext?: string;
  files: readonly PassthroughFile[];
  scopePolicy?: ProviderDataScopePolicy;
  limits?: { pastMeetings?: Partial<PastMeetingLimits> };
}

/** Facts only known after the idle path's V3 composition. */
export interface LateInput {
  evidenceCount: number;
  overridesNoEvidenceNotice?: boolean;
}

export interface ChatSourcesReport {
  path: ChatPath;
  plan: { referenceFiles: string; liveMeeting: string; pastMeetings: string };
  referenceFiles: { applied: boolean; files: number; chars: number; skipped: string | null };
  liveMeeting: { attempted: boolean; included: boolean; chunks: number; timedOut: boolean };
  pastMeetings: Omit<PastMeetingResult, 'block' | 'dataScopes'> & { used: boolean };
  ms: number;
}

export interface ChatSourcesResult {
  /** Text to append to the prompt; '' when nothing was selected. */
  block: string;
  /** Scopes of the content actually included — declare them to the transport. */
  dataScopes: ProviderDataScope[];
  report: ChatSourcesReport;
}

export interface PendingChatSources {
  plan: ChatSourcePlan;
  /** Resolves once every started source has finished; never rejects. */
  settle(late?: LateInput): Promise<ChatSourcesResult>;
}

const PAST_OVERRIDE_NOTE =
  'Automatic search of the active mode returned nothing relevant, but passages from earlier meetings are included below. '
  + 'Where the question is about those meetings, answer from them and disregard any statement above that no evidence was found.';

const NOT_ATTEMPTED_PAST: PastMeetingResult = {
  block: '', dataScopes: [], meetings: [], chunks: 0, candidates: 0, timedOut: false, ms: 0,
};

/**
 * Start every source the plan selected. Sources that do not depend on V3 (earlier
 * meetings, live-meeting recall) begin now and overlap whatever the caller awaits
 * next; the reference-file source needs V3's evidence count and runs in `settle`.
 */
export function startChatSources(plan: ChatSourcePlan, ctx: ChatSourceContext, deps: ChatSourceDeps): PendingChatSources {
  const t0 = Date.now();

  const livePromise: Promise<EnrichmentResult | null> =
    plan.liveMeeting.use && deps.liveMeeting
      ? deps.liveMeeting(ctx.composedContext ?? '').catch(() => null)
      : Promise.resolve(null);

  const pastPromise: Promise<PastMeetingResult> =
    plan.pastMeetings.use && deps.pastMeetings
      ? buildPastMeetingBlock({
          question: ctx.question,
          explicit: plan.pastMeetings.explicit,
          recent: plan.pastMeetings.recent,
          excludeMeetingIds: deps.pastMeetings.excludeMeetingIds,
          semanticFloor: deps.pastMeetings.semanticFloor,
          composedContext: ctx.composedContext,
          scopePolicy: ctx.scopePolicy,
          deps: deps.pastMeetings.deps,
          limits: ctx.limits?.pastMeetings,
        }).catch((): PastMeetingResult => ({ ...NOT_ATTEMPTED_PAST, skipped: 'failed' }))
      : Promise.resolve(NOT_ATTEMPTED_PAST);

  return {
    plan,
    async settle(late?: LateInput): Promise<ChatSourcesResult> {
      const [live, past] = await Promise.all([livePromise, pastPromise]);

      const reference = plan.referenceFiles.use && late
        ? buildModeReferencePassthrough({
            files: ctx.files,
            question: ctx.question,
            evidenceCount: late.evidenceCount,
            overridesNoEvidenceNotice: late.overridesNoEvidenceNotice,
            scopePolicy: ctx.scopePolicy,
          })
        : null;

      const pastBlock = past.block
        ? `${late?.overridesNoEvidenceNotice ? `${PAST_OVERRIDE_NOTE}\n` : ''}${past.block}`
        : '';

      const scopes = new Set<ProviderDataScope>();
      for (const s of live?.dataScopes ?? []) scopes.add(s);
      for (const s of past.dataScopes) scopes.add(s);
      for (const s of reference?.dataScopes ?? []) scopes.add(s);

      const { block: _pb, dataScopes: _ps, ...pastReport } = past;
      return {
        block: [live?.block ?? '', pastBlock, reference?.block ?? ''].filter(Boolean).join('\n\n'),
        dataScopes: [...scopes],
        report: {
          path: plan.path,
          plan: {
            referenceFiles: plan.referenceFiles.why,
            liveMeeting: plan.liveMeeting.why,
            pastMeetings: plan.pastMeetings.why,
          },
          referenceFiles: {
            applied: Boolean(reference?.block),
            files: reference?.files ?? 0,
            chars: reference?.chars ?? 0,
            skipped: reference ? (reference.skipped ?? null) : (plan.referenceFiles.use ? 'awaiting_v3' : plan.referenceFiles.why),
          },
          liveMeeting: live
            ? { ...live.meeting }
            : { attempted: false, included: false, chunks: 0, timedOut: false },
          pastMeetings: { ...pastReport, used: Boolean(past.block) },
          ms: Date.now() - t0,
        },
      };
    },
  };
}
