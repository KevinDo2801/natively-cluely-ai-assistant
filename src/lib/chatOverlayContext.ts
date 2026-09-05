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

/**
 * Vague / referential questions ("giải thích", "anh ấy nói gì?", "explain
 * what she said", "tell me more") don't name a topic, so the model tends to
 * anchor on whichever transcript block is most "explainable" — often an older
 * story — and re-summarises the WHOLE topic instead of the last thing said.
 * Detected at composition time so the persona can bound the answer to the
 * MOST RECENT content and keep it short. English + Vietnamese patterns (the
 * Vietnamese ones include telegraphed no-diacritic spellings).
 */
const VAGUE_QUESTION_RE = /\b(explain|describe|summarize|repeat that|go on|continue|say that again|tell me (more|about)|what (did|does) (she|he|they|the (speaker|person|interviewer|candidate|teacher)|him|her|thay|co) (say|mean)|what was (that|this|it)|can you (say|repeat|clarify) (that|this|it)|giai thich|giải thích|nói gì|noi gi|noi gi?|đang nói|dang noi|nghĩa là|nghia la|ý (thầy|cô|anh|chị|người) (nói|muốn|dang))|thay (dang )?noi gi|thầy (đang )?nói gì\b/i;

export function isVagueChatQuestion(text: string): boolean {
  return VAGUE_QUESTION_RE.test(text ?? '');
}

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
  try {
    const activeMode = await api.modesGetActive?.();
    if (activeMode?.id) {
      const refs = await api.modesGetReferenceFiles?.(activeMode.id);
      files = (refs ?? []).map((f) => ({ fileName: f.fileName, content: f.content }));
    }
  } catch { /* files are optional */ }

  return {
    context: composeChatOverlayContext({ transcript, chatHistory, files, question }),
    hasTranscript: true,
    fileCount: files.length,
  };
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
  /** The user's question, when known — lets the persona bound vague asks. */
  question?: string;
}): string {
  const blocks: string[] = [];

  const transcript = (input.transcript ?? '').trim();
  const chatHistory = (input.chatHistory ?? '').trim();

  const basePersona = 'You are a helpful study assistant for a student following a live lecture. '
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
  // A caller-supplied persona (MeetingChatOverlay) replaces the default
  // wholesale; the vague-question bound below still applies on top of it so
  // every overlay gets the same "most recent topic only" behaviour.
  let persona = (input.persona?.trim()) || basePersona;
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
    const fileParts: string[] = [];
    let used = 0;
    for (const f of files) {
      if (used >= FILES_SECTION_CHAR_CAP) {
        fileParts.push('...additional reference files omitted (context budget)');
        break;
      }
      const body = f.content.length > PER_FILE_CHAR_CAP
        ? `${f.content.slice(0, PER_FILE_CHAR_CAP)}\n[...truncated]`
        : f.content;
      const part = `[FILE: ${f.fileName}]\n${body}`;
      fileParts.push(part);
      used += part.length;
    }
    blocks.push(`[REFERENCE FILES:]\n${fileParts.join('\n\n')}`);
  }

  return blocks.join('\n\n');
}
