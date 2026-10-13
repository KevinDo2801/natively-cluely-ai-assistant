// src/lib/chatRelevance.ts
//
// Dependency-free relevance helpers shared by the renderer (reference files in
// the chat overlay) and the main process (profile / meeting excerpts).
//
// WHY THIS EXISTS
// The chat overlay used to include a reference file by taking its first 4000
// characters. A long résumé, JD or lecture handout therefore lost its TAIL no
// matter what the user asked. These helpers pick the passages that match the
// question instead, with three deliberate properties:
//
//   * Lossless when it fits. A text within budget is returned untouched, so
//     small files cost nothing and change nothing.
//   * No network, no model. Pure lexical BM25 over a few dozen passages is
//     sub-millisecond, so it can sit on the hot path of a typed question
//     without adding the latency that a semantic round-trip would.
//   * Unicode-aware. The V3 tokenizer (context-intelligence/retrieval/bm25.ts)
//     is ASCII-only — it deletes every non-[a-z0-9] character, which splits
//     "nghiệm" into "nghi" + "m" and erases CJK/Cyrillic entirely. That
//     tokenizer is pinned by a parity test, so this module carries its own.
//
// Self-contained on purpose: no relative imports, so both the Vite/renderer
// program and the electron program can import it.

const COMBINING_MARKS = /[̀-ͯ]/g;

/**
 * Lowercase and strip Latin diacritics so "Kinh nghiệm" and the telegraphed
 * "kinh nghiem" compare equal. Final NFC re-composes Hangul / kana that NFD
 * split, so CJK text survives unchanged.
 */
export function foldText(text: string): string {
  return String(text ?? '')
    .toLowerCase()
    .normalize('NFD')
    .replace(COMBINING_MARKS, '')
    .replace(/đ/g, 'd')
    .replace(/ı/g, 'i')
    .normalize('NFC');
}

const CJK_CLASS = '\\u3400-\\u4dbf\\u4e00-\\u9fff\\u3040-\\u30ff\\uac00-\\ud7af';
const WORD_RE = /[\p{L}\p{N}]+/gu;
const CJK_SEGMENT_RE = new RegExp(`[${CJK_CLASS}]+|[^${CJK_CLASS}]+`, 'gu');
const IS_CJK_RE = new RegExp(`^[${CJK_CLASS}]`, 'u');

// Deliberately tiny. BM25's IDF handles ordinary frequency; this only removes
// words that are noise even in a two-passage pool.
const STOPWORDS = new Set([
  'the', 'and', 'for', 'with', 'that', 'this', 'from', 'are', 'was', 'you', 'your',
  'what', 'who', 'how', 'did', 'does', 'have', 'has', 'about', 'can', 'will',
  'la', 'va', 'cua', 'cho', 'voi', 'mot', 'cac', 'nay', 'khong', 'duoc', 'trong',
  'den', 'tu', 'de', 'thi', 'nhung', 'gi', 'nao', 'sao',
]);

/** Unicode-aware word tokens; CJK runs become character bigrams. */
export function tokenizeForRelevance(text: string): string[] {
  const out: string[] = [];
  for (const m of foldText(text).matchAll(WORD_RE)) {
    for (const seg of m[0].match(CJK_SEGMENT_RE) ?? []) {
      if (IS_CJK_RE.test(seg)) {
        if (seg.length === 1) out.push(seg);
        else for (let i = 0; i < seg.length - 1; i++) out.push(seg.slice(i, i + 2));
      } else if ((seg.length > 1 || /\p{N}/u.test(seg)) && !STOPWORDS.has(seg)) {
        out.push(seg);
      }
    }
  }
  return out;
}

export interface RelevancePassage {
  id: string;
  text: string;
}

export interface ScoredPassage {
  id: string;
  score: number;
}

/**
 * Okapi BM25 over a small pool, IDF computed over THAT pool (a handful of
 * passages from one document, not a corpus). Returns every passage, best first;
 * score 0 means "no query term present".
 */
export function rankPassagesByQuery(passages: readonly RelevancePassage[], query: string): ScoredPassage[] {
  const K1 = 1.5;
  const B = 0.75;
  const qTerms = [...new Set(tokenizeForRelevance(query))];
  const docs = passages.map((p) => {
    const tf = new Map<string, number>();
    const terms = tokenizeForRelevance(p.text);
    for (const t of terms) tf.set(t, (tf.get(t) ?? 0) + 1);
    return { id: p.id, tf, len: terms.length };
  });
  const N = docs.length || 1;
  const avgdl = docs.reduce((s, d) => s + d.len, 0) / N || 1;
  const df = new Map<string, number>();
  for (const d of docs) for (const t of d.tf.keys()) df.set(t, (df.get(t) ?? 0) + 1);

  return docs
    .map((d) => {
      let score = 0;
      for (const t of qTerms) {
        const f = d.tf.get(t);
        if (!f) continue;
        const n = df.get(t) ?? 0;
        const idf = Math.max(0, Math.log(1 + (N - n + 0.5) / (n + 0.5)));
        score += idf * ((f * (K1 + 1)) / (f + K1 * (1 - B + B * (d.len / avgdl))));
      }
      return { id: d.id, score };
    })
    .sort((a, b) => b.score - a.score);
}

const SENTENCE_SPLIT_RE = /(?<=[.!?。！？])\s+/u;

function hardSplit(text: string, size: number): string[] {
  const out: string[] = [];
  for (let i = 0; i < text.length; i += size) out.push(text.slice(i, i + size));
  return out;
}

/**
 * Split a document into passages of roughly `target` characters on paragraph,
 * line and sentence boundaries (hard-splitting only unbroken text), merging
 * tiny neighbours so a bullet list does not become one passage per bullet.
 */
export function splitIntoPassages(text: string, target = 600): string[] {
  const body = String(text ?? '').replace(/\r\n?/g, '\n').trim();
  if (!body) return [];

  const pieces: string[] = [];
  for (const block of body.split(/\n{2,}/)) {
    const b = block.trim();
    if (!b) continue;
    if (b.length <= target * 1.6) { pieces.push(b); continue; }
    for (const line of b.split('\n')) {
      const l = line.trim();
      if (!l) continue;
      if (l.length <= target * 1.6) { pieces.push(l); continue; }
      for (const sentence of l.split(SENTENCE_SPLIT_RE)) {
        const s = sentence.trim();
        if (!s) continue;
        if (s.length <= target * 1.6) pieces.push(s);
        else pieces.push(...hardSplit(s, target));
      }
    }
  }

  const merged: string[] = [];
  let buf = '';
  for (const piece of pieces) {
    if (buf && buf.length + piece.length + 1 > target) { merged.push(buf); buf = ''; }
    buf = buf ? `${buf}\n${piece}` : piece;
    if (buf.length >= target) { merged.push(buf); buf = ''; }
  }
  if (buf) merged.push(buf);
  return merged;
}

export const TRUNCATION_MARKER = '[...truncated]';

export interface ExcerptResult {
  text: string;
  /** True when some of the source text was omitted. */
  truncated: boolean;
  /** Characters of source text kept (markers excluded). */
  keptChars: number;
}

/**
 * Fit `text` into `budgetChars`, preferring the passages that match `query`.
 *
 *  1. Within budget → returned unchanged (lossless).
 *  2. Otherwise keep the head (title / identity / summary — the part that makes
 *     the rest interpretable), then the best-matching passages, then fill any
 *     remaining room in document order. With no query signal this degrades to
 *     "head + earliest content" — exactly the old truncation, never worse.
 *  3. Kept passages are emitted in document order; every omitted stretch is
 *     marked, so the model can tell the excerpt is partial.
 *
 * `budgetChars` bounds the kept source text; markers add a few characters.
 */
export function selectRelevantExcerpts(text: string, query: string | undefined, budgetChars: number): ExcerptResult {
  const source = String(text ?? '');
  const budget = Math.max(0, Math.floor(budgetChars));
  if (source.length <= budget) return { text: source, truncated: false, keptChars: source.length };
  if (budget === 0) return { text: TRUNCATION_MARKER, truncated: true, keptChars: 0 };

  const passages = splitIntoPassages(source, Math.max(200, Math.min(700, Math.floor(budget / 4))));
  if (passages.length === 0) return { text: '', truncated: false, keptChars: 0 };

  const kept = new Set<number>();
  let used = 0;

  // Head: always, but never more than 30% of the budget.
  const headCap = Math.max(1, Math.floor(budget * 0.3));
  const head = passages[0].length > headCap ? passages[0].slice(0, headCap) : passages[0];
  passages[0] = head;
  kept.add(0);
  used += head.length;

  if (query && query.trim()) {
    const ranked = rankPassagesByQuery(
      passages.map((p, i) => ({ id: String(i), text: p })),
      query,
    );
    for (const r of ranked) {
      if (r.score <= 0) break;
      const i = Number(r.id);
      if (kept.has(i)) continue;
      if (used + passages[i].length > budget) continue;
      kept.add(i);
      used += passages[i].length;
    }
  }

  for (let i = 0; i < passages.length && used < budget; i++) {
    if (kept.has(i)) continue;
    if (used + passages[i].length > budget) continue;
    kept.add(i);
    used += passages[i].length;
  }

  const order = [...kept].sort((a, b) => a - b);
  let out = '';
  let prev = -1;
  for (const i of order) {
    if (prev === -1) out = passages[i];
    else out += (i === prev + 1 ? '\n' : `\n${TRUNCATION_MARKER}\n`) + passages[i];
    prev = i;
  }
  if (prev < passages.length - 1) out += `\n${TRUNCATION_MARKER}`;
  return { text: out, truncated: true, keptChars: used };
}

export interface BudgetedFile {
  fileName: string;
  content: string;
}

/**
 * Split a total budget across files fairly: short files keep everything they
 * have, long ones share what is left (never above `perFileCap`). Returns the
 * per-file budget in input order.
 */
export function allocateFileBudgets(
  files: readonly BudgetedFile[],
  perFileCap: number,
  totalCap: number,
): number[] {
  const budgets = new Array<number>(files.length).fill(0);
  const order = files
    .map((f, i) => ({ i, len: f.content.length }))
    .sort((a, b) => a.len - b.len);
  let remaining = Math.max(0, totalCap);
  let left = order.length;
  for (const { i, len } of order) {
    const share = Math.floor(remaining / Math.max(1, left));
    const give = Math.max(0, Math.min(len, perFileCap, share));
    budgets[i] = give;
    remaining -= give;
    left -= 1;
  }
  return budgets;
}
