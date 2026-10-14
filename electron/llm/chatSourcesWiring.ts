// electron/llm/chatSourcesWiring.ts
//
// Production wiring for chatSources.ts: resolves the RAG index, the privacy
// toggles and the meeting directory from the running app and starts the source
// selection for one typed-chat turn. Lazy `require`s mirror the rest of
// ipcHandlers (these modules pull in Electron-bound singletons). Every failure
// degrades to "no extra sources" — the turn is never blocked or broken.

import type { PassthroughFile } from './modeReferencePassthrough';
import {
  planChatSources,
  startChatSources,
  type ChatPath,
  type ChatSourceDeps,
  type ChatSourcePlan,
  type PendingChatSources,
} from './chatSources';
import {
  LIVE_MEETING_RAG_ID,
  buildCallerOwnedChatEnrichment,
  isLiveMeetingRagQueryable,
  makeLiveMeetingSearch,
} from './callerOwnedChatEnrichment';
import type { PastMeetingChunk } from './pastMeetingSource';

export interface TurnSourcesArgs {
  path: ChatPath;
  question: string;
  /** The renderer-composed prompt (live-transcript path). */
  composedContext?: string;
  hasImages: boolean;
  /** The active mode's reference files (idle path). */
  files?: readonly PassthroughFile[];
  appState: any;
  /** Id of the meeting in progress, so it is never recalled as an "earlier" one. */
  liveMeetingId?: string | null;
}

const INERT_PLAN: ChatSourcePlan = {
  path: 'idle',
  referenceFiles: { use: false, why: 'wiring_failed' },
  liveMeeting: { use: false, why: 'wiring_failed' },
  pastMeetings: { use: false, why: 'wiring_failed', explicit: false, recent: false },
};

export function startChatSourcesForTurn(args: TurnSourcesArgs): PendingChatSources {
  const files = args.files ?? [];
  try {
    const { readProviderScopePolicy } = require('../context-intelligence/policies/provider-scope-policy');
    const scopePolicy = readProviderScopePolicy();

    const rag = args.appState?.getRAGManager?.();
    const ragReady = Boolean(rag?.isReady?.() && rag.getRetriever);

    const plan = planChatSources({
      path: args.path,
      question: args.question,
      hasImages: args.hasImages,
      attachedFileCount: files.length,
      liveMeetingQueryable: isLiveMeetingRagQueryable(rag),
      pastMeetingsQueryable: ragReady,
      meetingActive: Boolean(args.appState?.getIsMeetingActive?.()),
      scopePolicy,
    });

    const deps: ChatSourceDeps = {};

    if (plan.liveMeeting.use) {
      const searchLiveMeeting = makeLiveMeetingSearch(rag);
      deps.liveMeeting = (composedContext) => buildCallerOwnedChatEnrichment({
        question: args.question,
        composedContext,
        // Profile Intelligence was removed; this path no longer pulls a résumé.
        profileSources: [],
        scopePolicy,
        deps: { searchLiveMeeting },
      });
    }

    if (plan.pastMeetings.use) {
      const { formatChunkForContext } = require('../rag/SemanticChunker');
      const { resolveSemanticFloor, isSemanticAdmissionGateEnabled } = require('./semanticAdmissionGate');
      const spaceKey = rag.getEmbeddingPipeline?.()?.getActiveSpaceKey?.();
      deps.pastMeetings = {
        // The session tracker keeps the last meeting's id after it ends, so only
        // exclude it while a meeting is actually running; otherwise "the meeting
        // just now" would be hidden from its own recall.
        excludeMeetingIds: [
          LIVE_MEETING_RAG_ID,
          args.appState?.getIsMeetingActive?.() ? args.liveMeetingId : null,
        ].filter((x): x is string => Boolean(x)),
        semanticFloor: isSemanticAdmissionGateEnabled() ? resolveSemanticFloor(spaceKey) : null,
        deps: {
          search: async (query, opts): Promise<PastMeetingChunk[]> => {
            const res = await rag.getRetriever().retrieveGlobal(query, { topK: opts.topK, maxTokens: opts.maxTokens });
            return (res?.chunks ?? []).map((c: any) => ({
              meetingId: c.meetingId,
              text: formatChunkForContext(c),
              startMs: c.startMs,
              similarity: c.similarity,
            }));
          },
          latestMeeting: async (): Promise<PastMeetingChunk[]> => {
            const { DatabaseManager } = require('../db/DatabaseManager');
            const db = DatabaseManager.getInstance();
            // The newest FINISHED meeting that has any text (a meeting that was
            // started and abandoned empty must not shadow the one before it).
            const rows = db.getRecentMeetings(5) as Array<{ id: string }>;
            const raw = db.getDb();
            for (const m of rows) {
              if (m.id === LIVE_MEETING_RAG_ID) continue;
              const chunks = raw.prepare(
                'SELECT speaker, cleaned_text AS text, start_timestamp_ms AS startMs FROM chunks WHERE meeting_id = ? ORDER BY chunk_index',
              ).all(m.id) as Array<{ speaker: string; text: string; startMs: number }>;
              const lines = chunks.length > 0
                ? chunks.map((c) => ({ text: `${c.speaker}: ${c.text}`, startMs: c.startMs }))
                : (raw.prepare('SELECT speaker, content AS text, timestamp_ms AS startMs FROM transcripts WHERE meeting_id = ? ORDER BY timestamp_ms')
                    .all(m.id) as Array<{ speaker: string; text: string; startMs: number }>)
                    .map((t) => ({ text: `${t.speaker}: ${t.text}`, startMs: t.startMs }));
              if (lines.length === 0) continue;
              return lines.map((l) => ({ meetingId: m.id, text: l.text, startMs: l.startMs, similarity: 1 }));
            }
            return [];
          },
          describeMeeting: (meetingId) => {
            const { DatabaseManager } = require('../db/DatabaseManager');
            const m = DatabaseManager.getInstance().getMeetingDetails(meetingId);
            return m ? { title: m.title, date: m.date } : null;
          },
        },
      };
    }

    return startChatSources(plan, {
      question: args.question,
      composedContext: args.composedContext,
      files,
      scopePolicy,
    }, deps);
  } catch (err) {
    console.warn('[ChatSources] wiring failed — turn continues without extra sources:', (err as Error)?.message ?? err);
    return startChatSources(INERT_PLAN, { question: args.question, files }, {});
  }
}
