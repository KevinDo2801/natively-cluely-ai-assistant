// electron/llm/callerOwnedChatEnrichment.ts
//
// Extra grounding for TYPED chat that already has a live transcript.
//
// WHY THIS EXISTS
// With a live transcript the renderer composes the whole prompt itself
// (`skipSystemPrompt + context`, see src/lib/chatOverlayContext.ts) and the main
// process deliberately does not re-assemble it — that is what fixed "I don't
// have the transcript". The price was that this path never saw anything V3
// supplies: the user's résumé / target JD (so "how does my experience fit?" in
// an interview had nothing to answer from) and any recall beyond the transcript
// window of a long meeting.
//
// WHY NOT JUST ROUTE THIS PATH THROUGH V3
// V3 is a full decision + retrieval + composition pipeline with several awaits
// before the first token (query embedding, retrieval attempts, a 14–17 KB system
// prompt). Users measured it as slow, and its own `timeoutMs` budget was never
// enforced. This module takes only the two pieces that were missing and keeps
// the cost bounded:
//
//   * Profile excerpts   — pure CPU over data already in memory: no network, no
//                          model call, sub-millisecond for a normal résumé.
//   * Live-meeting recall — one embedding round-trip, run ONLY when the
//                          transcript is long enough to have been cut, only for
//                          questions that name a topic, and raced against a hard
//                          deadline. A miss or timeout adds nothing.
//
// The caller starts this EARLY and awaits it just before streaming, so the work
// overlaps the rest of the handler's own awaits.
//
// Privacy: every block is checked against the live provider-data-scope toggles
// and the scopes actually included are returned so the transport is TOLD what
// it is sending (it cannot infer them from untagged prose).

import {
  renderProfileSections,
  type ProfileDocLike,
  type ProfileSection,
} from '../context-intelligence/retrieval/profile-retrieval-port';
import type { ProviderDataScope, ProviderDataScopePolicy } from './ProviderRouter';
import {
  rankPassagesByQuery,
  selectRelevantExcerpts,
  tokenizeForRelevance,
} from '../../src/lib/chatRelevance';
import { isVagueChatQuestion } from '../../src/lib/vagueQuestion';

export interface MeetingChunkLike {
  text: string;
  startMs?: number;
  similarity?: number;
}

export interface EnrichmentLimits {
  /** Profile budgets, in characters of source text. */
  resumeChars: number;
  jdChars: number;
  factChars: number;
  /** Composed-context size below which the whole meeting is assumed present. */
  longContextChars: number;
  /** Hard deadline for the live-meeting semantic search. */
  meetingSearchMs: number;
  /** Cap on the recalled-moments block. */
  meetingBlockChars: number;
  meetingTopK: number;
  meetingMaxTokens: number;
  /** Fraction of a chunk's distinctive tokens already in the context ⇒ duplicate. */
  duplicateOverlap: number;
}

export const DEFAULT_ENRICHMENT_LIMITS: EnrichmentLimits = {
  resumeChars: 3600,
  jdChars: 2200,
  factChars: 600,
  longContextChars: 14_000,
  meetingSearchMs: 900,
  meetingBlockChars: 3000,
  meetingTopK: 6,
  meetingMaxTokens: 900,
  duplicateOverlap: 0.8,
};

export interface EnrichmentDeps {
  /** Active profile docs. Called only when the mode opts in to profile sources. */
  loadProfileDocs?: () => ProfileDocLike[];
  /** Semantic search over the live meeting's indexed chunks. */
  searchLiveMeeting?: (
    query: string,
    opts: { topK: number; maxTokens: number },
  ) => Promise<MeetingChunkLike[]>;
  now?: () => number;
}

export interface EnrichmentInput {
  question: string;
  /** The caller-composed context that will be sent (sizes the transcript, dedupes recall). */
  composedContext: string;
  /** policy.profileSources of the active mode; empty ⇒ no profile at all. */
  profileSources: readonly string[];
  /** Live privacy toggles (undefined ⇒ everything allowed, matching the transport). */
  scopePolicy?: ProviderDataScopePolicy;
  deps: EnrichmentDeps;
  limits?: Partial<EnrichmentLimits>;
}

export interface EnrichmentResult {
  /** Text to append to the composed context; '' when there is nothing to add. */
  block: string;
  /** Scopes of the content actually included — pass as the stream's extraDataScopes. */
  dataScopes: ProviderDataScope[];
  profile: { included: boolean; chars: number; docs: string[]; withheld: ProviderDataScope[] };
  meeting: { attempted: boolean; included: boolean; chunks: number; timedOut: boolean };
  ms: number;
}

const EMPTY_RESULT = (ms = 0): EnrichmentResult => ({
  block: '',
  dataScopes: [],
  profile: { included: false, chars: 0, docs: [], withheld: [] },
  meeting: { attempted: false, included: false, chunks: 0, timedOut: false },
  ms,
});

const isDenied = (scope: ProviderDataScope, policy?: ProviderDataScopePolicy): boolean =>
  policy?.[scope] === false;

// ── profile ─────────────────────────────────────────────────────────────────

/**
 * Prior for a section when the question gives no lexical signal. This is what
 * keeps a Vietnamese question ("kinh nghiệm của tôi liên quan gì?") useful
 * against an English résumé: no term overlaps, so the overview — identity,
 * experience, skills — is included by priority instead of nothing at all.
 */
const SECTION_PRIOR: Readonly<Record<string, number>> = {
  identity: 0.55,
  experience: 0.5,
  role: 0.5,
  skills: 0.45,
  requirements: 0.45,
  projects: 0.4,
  achievements: 0.3,
  education: 0.3,
  compensation: 0.2,
  derived_salary: 0.0,
};

// Salary is a policy-only derived fact: it should appear when ASKED, and the
// question may be in any language while the section text is English.
const SALARY_INTENT_RE = /(?:salary|compensation|\bpay\b|\bctc\b|\blpa\b|luong|thu nhap|salario|sueldo|salaire|gehalt|stipendio|gaji|maas|зарплат|薪|工资|工資|給料|급여|वेतन|راتب)/iu;
const foldForIntent = (s: string): string => s.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/đ/g, 'd');

interface RenderedProfile {
  text: string;
  chars: number;
}

function renderProfileDoc(doc: ProfileDocLike, question: string, budget: number): RenderedProfile {
  const sections: ProfileSection[] = renderProfileSections(doc.kind, doc.structured);
  const salaryAsked = SALARY_INTENT_RE.test(foldForIntent(question)) || SALARY_INTENT_RE.test(question);

  if (sections.length === 0) {
    // No structured extraction — fall back to the raw parsed text, relevance-trimmed.
    const raw = (doc.rawText ?? '').trim();
    if (!raw) return { text: '', chars: 0 };
    const r = selectRelevantExcerpts(raw, question, budget);
    return { text: r.text, chars: r.keptChars };
  }

  const bm25 = new Map(
    rankPassagesByQuery(
      sections.map((s, i) => ({ id: String(i), text: `${s.section} ${s.text}` })),
      question,
    ).map((r) => [r.id, r.score]),
  );
  const maxLex = Math.max(0, ...bm25.values());

  const scored: Array<{ i: number; s: ProfileSection; score: number }> = [];
  sections.forEach((s, i) => {
    // The derived salary estimate is admitted by POLICY (the question asks for
    // it), never by lexical accident: its disclaimer text is a keyword magnet
    // for unrelated "experience / skills" questions (see profile-retrieval-port).
    if (s.boostKey === 'derived_salary' && !salaryAsked) return;
    const lex = maxLex > 0 ? (bm25.get(String(i)) ?? 0) / maxLex : 0;
    let prior = SECTION_PRIOR[s.boostKey] ?? 0.1;
    if (salaryAsked && (s.boostKey === 'derived_salary' || s.boostKey === 'compensation')) prior = 0.9;
    scored.push({ i, s, score: prior + lex });
  });

  // Whole profile fits → no ranking needed, keep document order, lose nothing.
  const total = scored.reduce((n, x) => n + x.s.text.length + x.s.section.length + 4, 0);
  const picked = new Set<number>();
  let used = 0;
  if (total <= budget) {
    for (const x of scored) { picked.add(x.i); used += x.s.text.length + x.s.section.length + 4; }
  } else {
    for (const x of [...scored].sort((a, b) => b.score - a.score)) {
      const cost = x.s.text.length + x.s.section.length + 4;
      if (used + cost <= budget) { picked.add(x.i); used += cost; continue; }
      // A section that does not fit whole may still contribute its relevant part.
      const room = budget - used - x.s.section.length - 4;
      if (room >= 300 && picked.size === 0) {
        sections[x.i] = { ...x.s, text: selectRelevantExcerpts(x.s.text, question, room).text };
        picked.add(x.i);
        used = budget;
      }
    }
  }

  const text = sections
    .map((s, i) => (picked.has(i) ? `- ${s.section}: ${s.text}` : ''))
    .filter(Boolean)
    .join('\n');
  return { text, chars: used };
}

const PROFILE_HEADINGS = {
  resume: "[CANDIDATE PROFILE — the user's own résumé (relevant excerpts):]",
  jd: "[TARGET JOB DESCRIPTION — shapes emphasis, NOT proof of the user's experience:]",
  fact: '[DERIVED PROFILE FACTS:]',
} as const;

const PROFILE_SCOPE: Readonly<Record<'resume' | 'jd' | 'fact', ProviderDataScope>> = {
  resume: 'profile_history',
  fact: 'profile_history',
  jd: 'reference_files',
};

const PROFILE_SOURCE_FOR_KIND: Readonly<Record<'resume' | 'jd' | 'fact', string>> = {
  resume: 'RESUME',
  jd: 'JOB_DESCRIPTION',
  fact: 'PROFILE_FACT',
};

function buildProfileBlock(input: EnrichmentInput, limits: EnrichmentLimits) {
  const out = { text: '', chars: 0, docs: [] as string[], scopes: new Set<ProviderDataScope>(), withheld: new Set<ProviderDataScope>() };
  if (!input.profileSources.length || !input.deps.loadProfileDocs) return out;

  let docs: ProfileDocLike[] = [];
  try { docs = input.deps.loadProfileDocs() ?? []; } catch { return out; }

  const budgets = { resume: limits.resumeChars, jd: limits.jdChars, fact: limits.factChars };
  const parts: string[] = [];
  // Résumé first, then JD, then derived facts: the same precedence V3 uses.
  for (const kind of ['resume', 'jd', 'fact'] as const) {
    if (!input.profileSources.includes(PROFILE_SOURCE_FOR_KIND[kind])) continue;
    const scope = PROFILE_SCOPE[kind];
    for (const doc of docs.filter((d) => d.kind === kind)) {
      if (isDenied(scope, input.scopePolicy)) { out.withheld.add(scope); continue; }
      const r = renderProfileDoc(doc, input.question, budgets[kind]);
      if (!r.text.trim()) continue;
      parts.push(`${PROFILE_HEADINGS[kind]}\n${r.text}`);
      out.chars += r.chars;
      out.docs.push(doc.sourceId);
      out.scopes.add(scope);
    }
  }
  out.text = parts.join('\n\n');
  return out;
}

// ── live meeting recall ─────────────────────────────────────────────────────

export async function withDeadline<T>(work: Promise<T>, ms: number): Promise<{ value?: T; timedOut: boolean; failed: boolean }> {
  // The loser of the race must never surface as an unhandled rejection (fatal
  // in the Electron main process).
  work.catch(() => { /* handled via the race below */ });
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<{ timedOut: true }>((resolve) => {
    timer = setTimeout(() => resolve({ timedOut: true }), ms);
  });
  try {
    const res = await Promise.race([work.then((value) => ({ value, timedOut: false as const })), deadline]);
    if ('value' in res) return { value: res.value, timedOut: false, failed: false };
    return { timedOut: true, failed: false };
  } catch {
    return { timedOut: false, failed: true };
  } finally {
    if (timer) clearTimeout(timer);
  }
}

const DISTINCTIVE_MIN_LEN = 4;

/** True when (nearly) every distinctive token of `text` already occurs in `contextTokens`. */
export function isCoveredByContext(text: string, contextTokens: ReadonlySet<string>, overlap: number): boolean {
  const toks = [...new Set(tokenizeForRelevance(text).filter((t) => t.length >= DISTINCTIVE_MIN_LEN || /[^\u0000-\u007f]/.test(t)))];
  if (toks.length === 0) return true;
  let hit = 0;
  for (const t of toks) if (contextTokens.has(t)) hit += 1;
  return hit / toks.length >= overlap;
}

async function buildMeetingBlock(input: EnrichmentInput, limits: EnrichmentLimits) {
  const out = { text: '', attempted: false, chunks: 0, timedOut: false };
  const search = input.deps.searchLiveMeeting;
  if (!search) return out;
  if (isDenied('transcript', input.scopePolicy)) return out;
  // Whole meeting already in context → nothing to recall, and no reason to pay for a search.
  if (input.composedContext.length < limits.longContextChars) return out;
  // "explain that" / "what did she say" refer to the LATEST words; semantic search
  // over the whole meeting would only fetch off-topic older material.
  if (isVagueChatQuestion(input.question)) return out;
  if (!input.question.trim()) return out;

  out.attempted = true;
  const res = await withDeadline(
    Promise.resolve().then(() => search(input.question, { topK: limits.meetingTopK, maxTokens: limits.meetingMaxTokens })),
    limits.meetingSearchMs,
  );
  out.timedOut = res.timedOut;
  const chunks = (res.value ?? []).filter((c) => c && typeof c.text === 'string' && c.text.trim());
  if (chunks.length === 0) return out;

  const contextTokens = new Set(tokenizeForRelevance(input.composedContext));
  const fresh = chunks
    .filter((c) => !isCoveredByContext(c.text, contextTokens, limits.duplicateOverlap))
    .sort((a, b) => (a.startMs ?? 0) - (b.startMs ?? 0));
  if (fresh.length === 0) return out;

  const parts: string[] = [];
  let used = 0;
  for (const c of fresh) {
    const t = c.text.trim();
    if (used + t.length > limits.meetingBlockChars) break;
    parts.push(t);
    used += t.length;
  }
  if (parts.length === 0) return out;
  out.chunks = parts.length;
  out.text = '[RELEVANT EARLIER MOMENTS FROM THIS MEETING — found by meaning across the whole meeting; '
    + 'they are OLDER than the transcript above and may use a different format:]\n'
    + parts.join('\n---\n');
  return out;
}

// ── entry point ─────────────────────────────────────────────────────────────

/**
 * Build the extra context block. Never throws: every failure degrades to "add
 * nothing", so enrichment can only ever improve a turn, never break it.
 */
export async function buildCallerOwnedChatEnrichment(input: EnrichmentInput): Promise<EnrichmentResult> {
  const now = input.deps.now ?? Date.now;
  const t0 = now();
  const limits: EnrichmentLimits = { ...DEFAULT_ENRICHMENT_LIMITS, ...input.limits };
  try {
    // Profile is synchronous CPU; start the (only) async piece first so the two overlap.
    const meetingP = buildMeetingBlock(input, limits).catch(() => ({ text: '', attempted: true, chunks: 0, timedOut: false }));
    const profile = (() => { try { return buildProfileBlock(input, limits); } catch { return null; } })();
    const meeting = await meetingP;

    const blocks = [profile?.text ?? '', meeting.text].filter(Boolean);
    const scopes = new Set<ProviderDataScope>(profile?.scopes ?? []);
    if (meeting.text) scopes.add('transcript');

    return {
      block: blocks.join('\n\n'),
      dataScopes: [...scopes],
      profile: {
        included: Boolean(profile?.text),
        chars: profile?.chars ?? 0,
        docs: profile?.docs ?? [],
        withheld: [...(profile?.withheld ?? [])],
      },
      meeting: {
        attempted: meeting.attempted,
        included: Boolean(meeting.text),
        chunks: meeting.chunks,
        timedOut: meeting.timedOut,
      },
      ms: now() - t0,
    };
  } catch {
    return EMPTY_RESULT(now() - t0);
  }
}

// ── production wiring ───────────────────────────────────────────────────────

/** Id the live indexer files the in-progress meeting under (see RAGManager.startLiveIndexing). */
export const LIVE_MEETING_RAG_ID = 'live-meeting-current';

/**
 * True when the live-meeting index can answer a query right now. Shared by the
 * enrichment wiring and by the source-availability flags in the manual-chat
 * handler so both describe the same fact.
 */
export function isLiveMeetingRagQueryable(ragManager: any): boolean {
  try {
    return Boolean(
      ragManager?.isReady?.()
      && ragManager.isLiveIndexingActive?.(LIVE_MEETING_RAG_ID)
      && ragManager.hasLiveChunks?.(),
    );
  } catch { return false; }
}

/**
 * Semantic search over the in-progress meeting's indexed chunks, or undefined
 * when that index cannot answer right now. Shared by this module's own wiring
 * and the unified chat-source selector so both ask the same index the same way.
 */
export function makeLiveMeetingSearch(
  rag: any,
): ((query: string, opts: { topK: number; maxTokens: number }) => Promise<MeetingChunkLike[]>) | undefined {
  if (!isLiveMeetingRagQueryable(rag)) return undefined;
  return async (query, opts) => {
    const { formatChunkForContext } = require('../rag/SemanticChunker');
    const res = await rag.getRetriever().retrieve(query, {
      meetingId: LIVE_MEETING_RAG_ID,
      topK: opts.topK,
      maxTokens: opts.maxTokens,
    });
    return (res?.chunks ?? []).map((c: any) => ({
      text: formatChunkForContext(c),
      startMs: c.startMs,
      similarity: c.similarity,
    }));
  };
}

/**
 * Resolve the active mode, profile docs and live-meeting index from the app and
 * start the enrichment. Lazy `require`s mirror the rest of ipcHandlers (these
 * modules pull in the Electron-bound singletons). Returns a promise that always
 * resolves; the caller awaits it just before streaming.
 */
export function startCallerOwnedChatEnrichment(args: {
  question: string;
  composedContext: string;
  appState: any;
  llmHelper: any;
}): Promise<EnrichmentResult> {
  try {
    const { ModesManager } = require('../services/ModesManager');
    const { resolveModePolicy, resolveModeIdOrWarn } = require('../context-intelligence/policies/mode-policy-registry');
    const { readProviderScopePolicy } = require('../context-intelligence/policies/provider-scope-policy');

    const modeInfo = ModesManager.getInstance().getActiveModeInfo?.() ?? null;
    const modeId = resolveModeIdOrWarn(modeInfo?.templateType ?? null, 'ipc/manual-chat-enrichment', { quietWhenAbsent: true });
    const policy = resolveModePolicy(modeId);

    const searchLiveMeeting = makeLiveMeetingSearch(args.appState?.getRAGManager?.());

    const loadProfileDocs = policy.profileSources?.length
      ? () => {
          const { collectV3ProfileSources } = require('../services/knowledge/v3ProfileSources');
          return collectV3ProfileSources(args.llmHelper?.getKnowledgeOrchestrator?.() ?? null).docs;
        }
      : undefined;

    return buildCallerOwnedChatEnrichment({
      question: args.question,
      composedContext: args.composedContext,
      profileSources: policy.profileSources ?? [],
      scopePolicy: readProviderScopePolicy(),
      deps: { loadProfileDocs, searchLiveMeeting },
    });
  } catch {
    return Promise.resolve(EMPTY_RESULT());
  }
}
