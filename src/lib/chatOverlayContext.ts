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
    context: composeChatOverlayContext({ transcript, chatHistory, files }),
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
}): string {
  const blocks: string[] = [];

  const transcript = (input.transcript ?? '').trim();
  const chatHistory = (input.chatHistory ?? '').trim();

  const persona = input.persona?.trim()
    ?? 'You are a helpful meeting assistant answering a question during a live meeting. '
      + 'Use the transcript and reference files below as context when they are relevant. '
      + 'If the question is vague or points at no specific topic, prefer the MOST RECENT '
      + 'content in the transcript.';
  blocks.push(persona);

  if (transcript) {
    const label = input.transcriptLabel?.trim() ?? '[MEETING TRANSCRIPT (real audio, latest first):]';
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
