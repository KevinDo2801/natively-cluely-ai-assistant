// electron/llm/modeReferencePassthrough.ts
//
// Guarantees that a SMALL reference file attached to the active mode reaches the
// model on typed chat, whatever language the question is in.
//
// WHY THIS EXISTS
// The V3 manual-chat path reads a mode's files only when its question classifier
// plans a retrieval, and the classifier's personal-question patterns are English
// ("my", "your", "candidate"). Live 2026-10-13, Technical Interview mode with a
// one-page résumé attached (modeAttachedFiles: 1):
//   "trường đại học của tôi là gì?"      → GENERAL_TECHNICAL / FAST, no retrieval
//   "kinh nghiệm của tôi là gì?"         → GENERAL_TECHNICAL / FAST, no retrieval
//   "who am I?"                          → GROUNDED, but lexical search found 0
// so the model answered "I don't have that information" about a file the user
// had attached on purpose.
//
// A file the user attached to a mode is theirs to be used, and a one-page file
// costs a few hundred tokens — so when V3 supplied NO evidence, the file is
// handed over directly (relevance-trimmed past the budget), exactly as the
// typed-chat-with-transcript path already does in chatOverlayContext.
//
// Pure: no I/O, no Electron. The caller decides when to apply it.

import { selectRelevantExcerpts } from '../../src/lib/chatRelevance';
import type { ProviderDataScope, ProviderDataScopePolicy } from './ProviderRouter';

export interface PassthroughFile {
  fileName?: string;
  content?: string;
}

export interface PassthroughLimits {
  /** Total characters of file text across all files. */
  totalChars: number;
  /** Cap per file. */
  perFileChars: number;
}

export const DEFAULT_PASSTHROUGH_LIMITS: PassthroughLimits = {
  totalChars: 8000,
  perFileChars: 4000,
};

export interface PassthroughInput {
  files: readonly PassthroughFile[];
  question: string;
  /** Evidence items V3 already gave the model this turn. Any evidence ⇒ no passthrough. */
  evidenceCount: number;
  /** True when V3's prompt carries a "no evidence found" statement the files must override. */
  overridesNoEvidenceNotice?: boolean;
  /** Live privacy toggles (undefined ⇒ allowed, matching the transport). */
  scopePolicy?: ProviderDataScopePolicy;
  limits?: Partial<PassthroughLimits>;
}

export type PassthroughSkip = 'has_evidence' | 'no_files' | 'scope_denied' | 'empty_question';

export interface PassthroughResult {
  /** Text to append to the user prompt; '' when nothing applies. */
  block: string;
  /** Scopes of the content included — merge into the stream's declared scopes. */
  dataScopes: ProviderDataScope[];
  files: number;
  chars: number;
  skipped?: PassthroughSkip;
}

const SCOPE: ProviderDataScope = 'reference_files';

const HEADING =
  '[REFERENCE FILES ATTACHED TO THE ACTIVE MODE — the user\'s own documents. '
  + 'Use them whenever the question is about the user, their background, or anything these files cover; '
  + 'ignore them for unrelated questions:]';

const OVERRIDE_NOTE =
  'Automatic search of these files returned nothing, but their text is included in full below. '
  + 'Where the question is about them, answer from this text and disregard any statement above that no evidence was found.';

const skip = (skipped: PassthroughSkip): PassthroughResult => ({ block: '', dataScopes: [], files: 0, chars: 0, skipped });

export function buildModeReferencePassthrough(input: PassthroughInput): PassthroughResult {
  if (input.evidenceCount > 0) return skip('has_evidence');
  if (!String(input.question ?? '').trim()) return skip('empty_question');

  const files = input.files.filter((f) => typeof f?.content === 'string' && f.content.trim().length > 0);
  if (files.length === 0) return skip('no_files');
  if (input.scopePolicy?.[SCOPE] === false) return skip('scope_denied');

  const limits: PassthroughLimits = { ...DEFAULT_PASSTHROUGH_LIMITS, ...input.limits };
  const total = files.reduce((n, f) => n + Math.min(f.content!.length, limits.perFileChars), 0);
  // Fair share when everything does not fit; files that fit are kept verbatim.
  const share = total <= limits.totalChars
    ? limits.perFileChars
    : Math.max(500, Math.floor(limits.totalChars / files.length));

  const parts: string[] = [];
  let chars = 0;
  for (const f of files) {
    const budget = Math.min(limits.perFileChars, share);
    const excerpt = selectRelevantExcerpts(f.content!, input.question, budget).text.trim();
    if (!excerpt) continue;
    parts.push(`[FILE: ${f.fileName || 'attached file'}]\n${excerpt}`);
    chars += excerpt.length;
  }
  if (parts.length === 0) return skip('no_files');

  const block = [
    HEADING,
    ...(input.overridesNoEvidenceNotice ? [OVERRIDE_NOTE] : []),
    parts.join('\n\n'),
  ].join('\n');
  return { block, dataScopes: [SCOPE], files: parts.length, chars };
}
