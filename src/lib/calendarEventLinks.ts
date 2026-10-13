// Codex CLI's Google Calendar connector appends citation links labelled just
// "event" ("[event](https://…calendar…)") after each calendar fact. They add
// no information to the answer and render as a column of bare "event" links
// that open a calendar window, so they are removed from display text.
//
// Only the literal label "event" pointing at a Google Calendar URL is removed;
// every other link keeps rendering. An unfinished link at the end of the text
// is hidden too so the raw "[event](https://calen" never flashes mid-stream.

const EVENT_LINK_RE =
  /[ \t]*\[event\]\(\s*<?https?:\/\/[^)\s>]*(?:calendar\.google\.com|google\.com\/calendar)[^)\s>]*>?\s*\)/gi;
const TRAILING_PARTIAL_EVENT_LINK_RE = /[ \t]*\[event\](?:\([^)]*)?$/i;

export function stripCalendarEventLinks(text: string): string {
  if (!text || !/\[event\]/i.test(text)) return text;
  return text
    .replace(EVENT_LINK_RE, '')
    .replace(TRAILING_PARTIAL_EVENT_LINK_RE, '')
    .replace(/\n[ \t]*(?:\n[ \t]*){2,}/g, '\n\n');
}
