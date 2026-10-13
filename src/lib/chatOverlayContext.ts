// src/lib/chatOverlayContext.ts
//
// Shared context composer for the chat overlays (main chat + meeting chat).
//
// WHY: a typed question ("explain what she said") was answered with "I don't
// have the transcript" even mid-meeting. The manual_chat path WITHOUT
// `skipSystemPrompt` routes through Context Intelligence V3 (default ON), which
// DROPS the renderer-supplied `context` and re-derives evidence from its own
// retrieval ports — and in modes that do not authorize MEETING_TRANSCRIPT the
// live transcript is simply absent. The Recap quick action works because it
// uses the caller-owned path (`skipSystemPrompt + context`), which V3 skips.
//
// This helper composes the SAME caller-owned grounding for typed chat whenever
// a live meeting transcript exists, so every answer sees: the latest transcript
// (STT), the conversation (chat history + transcript), and reference files of
// the active mode when present. When there is no meeting transcript, callers
// fall back to their existing (non-caller-owned) behaviour unchanged.

import { isVagueChatQuestion } from './vagueQuestion.ts';
import {
  allocateFileBudgets,
  selectRelevantExcerpts,
} from './chatRelevance.ts';

export interface ChatOverlayFile {
  fileName: string;
  content: string;
}

export interface ComposedChatOverlayContext {
  /** Fully composed context string to pass as `context` with `skipSystemPrompt: true`. */
  context: string;
  /** True when a live meeting transcript was present (caller-owned path should be used). */
  hasTranscript: boolean;
  /** Number of reference files included in the composed context. */
  fileCount: number;
}

// Vague / referential question detection lives in its own self-contained module
// (multilingual) so the electron main process can share it with the renderer.
export { isVagueChatQuestion } from './vagueQuestion.ts';

/**
 * Reader-language hint for app-generated quick actions (Recap / Clarify /
 * Follow-up …). Those turns ride manual_chat with an ENGLISH instruction as
 * their message, so the model cannot see the user's own language — which is
 * why a Vietnamese user got English Recap/Clarify answers. The hint quotes
 * the user's most recent typed message; the model trivially detects its
 * language (no brittle diacritic heuristics in TS) and answers in it.
 */
export function buildReaderLanguageHint(lastTypedMessage: string): string {
  const sample = (lastTypedMessage ?? '').trim().replace(/\s+/g, ' ').slice(0, 80);
  if (!sample) return '';
  return `\n\nThe user's most recent typed message in this chat was: "${sample}". `
    + 'Respond in the language of that quoted message — that is the language the user reads. '
    + 'This explicit instruction overrides any other language guidance in this request '
    + '(e.g. "same language as the conversation").';
}

interface ElectronChatApi {
  getIntelligenceContext?: () => Promise<{ context: string; recapContext: string; lastAssistantMessage: string | null; activeMode: string }>;
  modesGetActive?: () => Promise<{ id: string; name: string; templateType: string; customContext: string; isActive: boolean; createdAt: string } | null>;
  modesGetReferenceFiles?: (modeId: string) => Promise<Array<{ id: string; modeId: string; fileName: string; content: string; createdAt: string }>>;
}

/**
 * Fetch the live transcript + active-mode reference files and compose the
 * caller-owned chat context. Returns `null` when there is no live transcript,
 * signalling the caller to keep its existing (non-caller-owned) behaviour.
 */
export async function fetchChatOverlayContext(
  chatHistory: string,
  api: ElectronChatApi,
  question?: string,
): Promise<ComposedChatOverlayContext | null> {
  let transcript = '';
  try {
    const intel = await api.getIntelligenceContext?.();
    transcript = intel?.recapContext ?? '';
  } catch { transcript = ''; }
  if (!transcript.trim()) return null;

  let files: ChatOverlayFile[] = [];
  let modeTemplateType: string | undefined;
  try {
    const activeMode = await api.modesGetActive?.();
    modeTemplateType = activeMode?.templateType || undefined;
    if (activeMode?.id) {
      const refs = await api.modesGetReferenceFiles?.(activeMode.id);
      files = (refs ?? []).map((f) => ({ fileName: f.fileName, content: f.content }));
    }
  } catch { /* files are optional */ }

  return {
    context: composeChatOverlayContext({ transcript, chatHistory, files, question, modeTemplateType }),
    hasTranscript: true,
    fileCount: files.length,
  };
}

const STUDY_PERSONA = 'You are a helpful study assistant for a student following a live lecture. '
  + 'Use the transcript and reference files below when they are relevant. The transcript is in '
  + 'chronological order — the NEWEST content is at the BOTTOM; when a question is about what is being '
  + 'said NOW, read the LAST lines of the transcript block, not the top. '
  + 'Answer in the language of the user\'s question: a Vietnamese question gets a Vietnamese answer, an '
  + 'English question gets an English answer. '
  + 'Write answers as structured notes that are easy to skim, and LET THE CONTENT CHOOSE THE SHAPE — '
  + 'never force the same template on every question: '
  + '- open with ONE short direct sentence that answers or names the topic; '
  + '- use bold-labeled sections (e.g. **Ý chính:**) with short bullets and nested bullets only where '
  + 'they genuinely help; put technical terms and key phrases in backticks, but NEVER put mathematical '
  + 'formulas in backticks. Write every formula as LaTeX using $...$ inline or $$...$$ on its own line '
  + '(for example, $2^2$, $(a+b)^2$, and $\\sqrt{x}$); bold only the few '
  + 'load-bearing words; '
  + '- when a table, schema, or code snippet clarifies the point (e.g. CREATE TABLE), show it in a '
  + 'small code block; '
  + '- when several distinct points were made, close with a compact **Tóm gọn:** takeaway of one or two '
  + 'lines; skip it when the answer is already short. '
  + 'For a vague question ("giải thích", "thầy nói gì", "anh ấy nói gì") explain ONLY the most recent '
  + 'thing being said (the last one or two statements at the bottom): a lead line plus a few bullets, '
  + 'then **Câu đang nói dở:** quoting the speaker\'s own words verbatim. If that last line is cut off '
  + 'or garbled, note it in one short phrase and mark your interpretation as an inference from the '
  + 'context. Do NOT add the quote section to plain factual or technical questions. '
  + 'When the user is Vietnamese but the lecture is in English, you MAY end with **Nói trong lớp:** '
  + 'followed by ONE short English sentence — the exact words the student could say aloud to the '
  + 'teacher — but only when the question is the kind the student might need to answer or respond to in '
  + 'class; skip it for pure comprehension notes. '
  + 'Keep answers short unless the user asks for a full explanation.';

/**
 * Persona for typed chat over a live transcript.
 *
 * The original (and still default) persona is a study assistant for a student in
 * a live lecture — it is what `general`, `lecture`, `seminar` and every custom
 * mode (custom modes are stored with the `general` template) keep getting, so
 * existing note-taking behaviour is unchanged. It is plainly wrong for modes
 * that are not lectures: an interview candidate or a salesperson was being
 * answered as "a student", with class-flavoured sections ("Nói trong lớp").
 * Those modes get a role-correct persona instead.
 *
 * Transcript labels are fixed by SessionTracker: `[ME]` is the user's mic and
 * `[INTERVIEWER]` is the OTHER side of the call whatever their real role is
 * (prospect, customer, candidate), which is why each persona restates it.
 */
const TRANSCRIPT_ORDER_NOTE = 'The transcript is in chronological order — the NEWEST content is at the BOTTOM; '
  + 'when a question is about what was just said or asked, read the LAST lines of the transcript block, not the top. ';

const PLAIN_ANSWER_STYLE = 'Answer in the language of the user\'s question. Open with ONE short direct sentence, '
  + 'then short bullets only where they genuinely help; write formulas as LaTeX ($...$) and code in small code '
  + 'blocks. Keep answers short unless the user asks for a full explanation.';

const INTERVIEW_PERSONA = 'You are a real-time interview copilot for the user, a candidate in a live interview. '
  + 'In the transcript, [INTERVIEWER] lines are what the other side said and [ME] lines are the user. '
  + TRANSCRIPT_ORDER_NOTE
  + 'When the user asks what to answer, draft a natural first-person answer they can say aloud. '
  + 'Ground every claim about the user\'s own background, experience or skills ONLY in the [CANDIDATE PROFILE] '
  + 'and reference-file blocks below; if those do not cover it, say so in one short phrase instead of inventing '
  + 'experience. Use the job description to shape emphasis, never as proof of experience. '
  + PLAIN_ANSWER_STYLE;

const MODE_PERSONAS: Readonly<Record<string, string>> = {
  'looking-for-work': INTERVIEW_PERSONA,
  'technical-interview': INTERVIEW_PERSONA
    + ' For coding or system-design questions give the approach first, then the code in a code block, '
    + 'then time and space complexity.',
  sales: 'You are a real-time sales-call copilot for the user, the seller. In the transcript, [INTERVIEWER] '
    + 'lines are what the prospect said and [ME] lines are the user. '
    + TRANSCRIPT_ORDER_NOTE
    + 'Take product facts, pricing and commitments ONLY from the reference files below; never invent a price, '
    + 'feature or promise they do not state — say it is not covered. Suggest discovery questions and objection '
    + 'handling when asked. '
    + PLAIN_ANSWER_STYLE,
  recruiting: 'You are a real-time interview-evaluation copilot for the user, the recruiter or interviewer. '
    + 'In the transcript, [INTERVIEWER] lines are what the other side — the candidate — said and [ME] lines '
    + 'are the user. '
    + TRANSCRIPT_ORDER_NOTE
    + 'Evaluate answers against the job description and candidate documents below; cite what the transcript or '
    + 'those documents actually say and do not assume facts about the candidate that neither states. '
    + PLAIN_ANSWER_STYLE,
  'call-center': 'You are a real-time support-call copilot for the user, the support agent. In the transcript, '
    + '[INTERVIEWER] lines are what the customer said and [ME] lines are the user. '
    + TRANSCRIPT_ORDER_NOTE
    + 'Treat the reference files (product docs, runbooks) as the authority; never promise a refund, timeline '
    + 'or policy they do not state. Propose clear next steps or an escalation when the issue is out of scope. '
    + PLAIN_ANSWER_STYLE,
  'team-meet': 'You are a meeting assistant for the user in a live team meeting. '
    + TRANSCRIPT_ORDER_NOTE
    + 'Track decisions, action items (owner and due date when stated) and open questions; mark anything the '
    + 'transcript does not state as unknown rather than guessing. '
    + PLAIN_ANSWER_STYLE,
};

/** Persona for a mode template type; the study persona for lecture-like and unknown modes. */
export function resolveChatPersona(modeTemplateType?: string | null): string {
  const key = String(modeTemplateType ?? '').trim().toLowerCase();
  return MODE_PERSONAS[key] ?? STUDY_PERSONA;
}

/** Per-file and total caps keep a large résumé/JD from blowing the context window. */
const PER_FILE_CHAR_CAP = 4000;
const FILES_SECTION_CHAR_CAP = 10000;

/**
 * Compose the caller-owned chat context from already-fetched parts.
 * Pure and side-effect free so it can be unit-tested without Electron.
 */
export function composeChatOverlayContext(input: {
  transcript: string;
  chatHistory: string;
  files?: ChatOverlayFile[];
  persona?: string;
  transcriptLabel?: string;
  /** The user's question, when known — bounds vague asks and ranks file excerpts. */
  question?: string;
  /**
   * Template type of the active mode (e.g. 'looking-for-work', 'sales'). Picks a
   * role-correct persona; absent / 'general' / 'lecture' keeps the study persona.
   * Ignored when the caller supplies its own `persona`.
   */
  modeTemplateType?: string | null;
}): string {
  const blocks: string[] = [];

  const transcript = (input.transcript ?? '').trim();
  const chatHistory = (input.chatHistory ?? '').trim();

  // A caller-supplied persona (MeetingChatOverlay) replaces the default
  // wholesale; the vague-question bound below still applies on top of it so
  // every overlay gets the same "most recent topic only" behaviour.
  let persona = (input.persona?.trim()) || resolveChatPersona(input.modeTemplateType);
  if (isVagueChatQuestion(input.question ?? '')) {
    persona += '\n\nThe question is vague or refers to what someone just said. '
      + 'If it does NOT name a specific topic, answer ONLY about what is being said RIGHT NOW '
      + '(the LAST one or two statements at the BOTTOM of the transcript block) and do not re-explain '
      + 'topics already covered earlier in this conversation. '
      + 'Never repeat the exact same **Câu đang nói dở:** quote you used in a previous answer.';
  }
  blocks.push(persona);

  if (transcript) {
    // IMPORTANT (2026-10): the recapContext blob is CHRONOLOGICAL — oldest
    // content first, NEWEST at the BOTTOM (SessionTracker.getRecapContext reads
    // the durable fullTranscript in commit order). The old label claimed
    // "latest first", so the model believed the TOP line was newest and kept
    // latching onto an OLD quote ("very simple problem…") and re-using it for
    // every vague "giải thích" question until the user corrected it. Say the
    // real order so the model reads the bottom for "what is being said now".
    const label = input.transcriptLabel?.trim()
      ?? '[MEETING TRANSCRIPT (real audio, chronological — NEWEST content at the BOTTOM):]';
    blocks.push(`${label}\n${transcript}`);
  }

  if (chatHistory) {
    blocks.push(`[CONVERSATION SO FAR:]\n${chatHistory}`);
  }

  const files = input.files?.filter((f) => f?.content?.trim()) ?? [];
  if (files.length > 0) {
    // Fair budget per file, then the passages that match the question rather
    // than the first N characters: a long résumé / JD / handout keeps the part
    // the user asked about even when it sits at the tail. Files that fit are
    // included verbatim, so small attachments are unchanged.
    const budgets = allocateFileBudgets(files, PER_FILE_CHAR_CAP, FILES_SECTION_CHAR_CAP);
    const fileParts: string[] = [];
    let omitted = false;
    files.forEach((f, i) => {
      if (budgets[i] <= 0) { omitted = true; return; }
      const excerpt = selectRelevantExcerpts(f.content, input.question, budgets[i]);
      fileParts.push(`[FILE: ${f.fileName}]\n${excerpt.text}`);
    });
    if (omitted) fileParts.push('...additional reference files omitted (context budget)');
    blocks.push(`[REFERENCE FILES:]\n${fileParts.join('\n\n')}`);
  }

  return blocks.join('\n\n');
}
