export interface ExtractedMedia {
  type: 'image' | 'link';
  url: string;
  label: string;
}

/**
 * Extract the media/links a Codex App Server notification produced, or [] when it
 * carried none. `item/agentMessage/*` notifications are ignored on purpose: that
 * text is the answer itself and is handled by the token stream.
 */
export function collectMediaFromNotification(
  notification: { method?: string; params?: unknown } | null | undefined,
): ExtractedMedia[];

/**
 * The markdown block to append to an answer for media the model did not already
 * print. Returns '' when nothing is new.
 */
export function buildMediaBlock(existingText: string, media: ExtractedMedia[]): string;

/**
 * The part of a finished agent message that arrived as an `item/completed`
 * notification rather than as streamed deltas — '' when there is nothing to add
 * (nothing finished in this notification, or the answer already streamed).
 */
export function recoverAgentMessageText(
  notification: { method?: string; params?: unknown } | null | undefined,
  streamedText?: string,
): string;
