/**
 * Connector media extraction for the Codex App Server stream.
 *
 * WHY THIS EXISTS
 * ---------------
 * The live chat only ever receives ONE kind of content from the App Server:
 * `item/agentMessage/delta` (text tokens). Capture 2026-10 (chat overlay,
 * Canva plugin): the connector produced an image, the model answered "Đã vẽ chú
 * chó hình vuông như trên" ("drew the square dog above") — and the overlay showed
 * no image at all, because the artifact travelled as a structured ITEM that
 * Natively dropped. The user sees prose pointing at nothing.
 *
 * This module pulls the URLs a connector turn produced out of the notification
 * payload and turns them into markdown appended to the answer, so the image or
 * link lands in the bubble through the rendering path that already exists
 * (CSP allows https/data images; the markdown renderer passes <img> through).
 *
 * Deliberately conservative:
 *   • only http(s) URLs are used (a data: URL blob would bloat the answer, and
 *     anything else is not renderable);
 *   • only subtree roots a connector result plausibly lives in are walked, so an
 *     unrelated internal endpoint cannot leak into the user's answer;
 *   • a URL the model already printed is never repeated.
 *
 * Pure and synchronous — unit-tested without Electron or the App Server.
 */

/** Subtree keys a connector result can live in (App Server shapes vary). */
const MEDIA_ROOTS = [
  'item', 'result', 'output', 'content', 'images', 'image', 'attachments',
  'attachment', 'artifacts', 'artifact', 'files', 'file', 'data', 'response',
  'resources', 'parts', 'items', 'urls', 'links', 'media',
];

const IMAGE_EXTENSION_RE = /\.(png|jpe?g|gif|webp|avif|svg|bmp)(\?|#|$)/i;
/** Roots whose NAME already says these URLs are images. */
const MEDIA_ROOTS_IMAGE_HINT = new Set(['images', 'image']);
/** Hosts whose bare (extension-less) URLs are almost always a rendered design/page. */
const DESIGN_HOST_RE = /(^|\.)(canva\.com|figma\.com|docs\.google\.com|drive\.google\.com|notion\.so|airtable\.com)$/i;

const MAX_MEDIA = 6;
const MAX_WALK_NODES = 400;
const MAX_WALK_DEPTH = 6;

/**
 * @typedef {{ type: 'image' | 'link', url: string, label: string }} ExtractedMedia
 */

/** Normalize a candidate URL, or null when it is not renderable. */
function normalizeUrl(value) {
  if (typeof value !== 'string') return null;
  const raw = value.trim().replace(/[)\],.;]+$/, '');
  if (!/^https:\/\//i.test(raw)) return null;
  try {
    const parsed = new URL(raw);
    if (parsed.protocol !== 'https:') return null;
    return parsed.toString();
  } catch {
    return null;
  }
}

function labelFor(url) {
  try {
    const parsed = new URL(url);
    const last = parsed.pathname.split('/').filter(Boolean).pop();
    return last ? decodeURIComponent(last) : parsed.hostname;
  } catch {
    return url;
  }
}

function classify(url, hintedImage = false) {
  // The ITEM's own type is the strongest signal: Canva hands over preview images
  // as extension-less (or query-signed) URLs, e.g. ".../<short-id>/" — keying off
  // the file extension alone typed them as plain LINKS, so the user got six
  // unclickable-looking id strings instead of the template images.
  if (hintedImage) return 'image';
  try {
    const host = new URL(url).hostname;
    if (IMAGE_EXTENSION_RE.test(url)) return 'image';
    if (DESIGN_HOST_RE.test(host)) return 'link';
    return 'link';
  } catch {
    return 'link';
  }
}

/** URLs embedded in a longer string ("Created design: https://…"). */
const URL_IN_TEXT_RE = /https:\/\/[^\s<>"'`)\]]+/gi;

/**
 * Every renderable URL in one string value: the value itself when it IS a URL, or
 * the URLs embedded in it. Connectors routinely return the design link inside a
 * sentence ("Created design: https://…"), which a whole-string test misses.
 */
function extractUrls(value) {
  const direct = normalizeUrl(value);
  if (direct) return [direct];
  if (typeof value !== 'string' || !value.includes('http')) return [];
  const found = [];
  for (const match of value.match(URL_IN_TEXT_RE) || []) {
    const url = normalizeUrl(match);
    if (url) found.push(url);
  }
  return found;
}

/** Pull every plausible URL out of one node, without walking into siblings twice. */
function collectFromNode(node, out, budget, hintedImage = false) {
  if (!node || budget.nodes-- <= 0) return;
  if (typeof node === 'string') {
    for (const url of extractUrls(node)) out.push({ url, hintedImage });
    return;
  }
  if (Array.isArray(node)) {
    for (const entry of node) collectFromNode(entry, out, budget, hintedImage);
    return;
  }
  if (typeof node !== 'object') return;

  // The ASSISTANT's own message text is never mined (the model writes its URLs
  // itself, and the token stream already carries them). Tool results and app
  // outputs ARE mined, including their text fields — a connector that puts the
  // design URL only inside its result payload is exactly the case where the
  // user otherwise gets prose with nothing clickable.
  const nodeType = String(node.type || '').toLowerCase().replace(/[_-]/g, '');
  if (nodeType === 'agentmessage' || nodeType === 'assistantmessage' || nodeType === 'outputtext') return;

  // An item that declares itself an image (type: 'image' / 'image_url' /
  // 'imageUrl') makes its URLs images, whatever their path looks like.
  const nodeHinted = hintedImage || nodeType.includes('image');
  for (const [key, value] of Object.entries(node)) {
    const keyHinted = nodeHinted || key.toLowerCase().includes('image');
    if (typeof value === 'string') {
      for (const url of extractUrls(value)) out.push({ url, hintedImage: keyHinted });
      continue;
    }
    collectFromNode(value, out, budget, keyHinted);
  }
}

/**
 * Extract the media/links a notification produced.
 *
 * @param {{ method?: string, params?: any } | null | undefined} notification
 * @returns {ExtractedMedia[]}
 */
export function collectMediaFromNotification(notification) {
  const params = notification?.params;
  if (!params || typeof params !== 'object') return [];
  // `item/agentMessage/delta` is the answer text itself — never mine it, or every
  // URL the model writes would be duplicated into the appended block.
  if (String(notification?.method || '').startsWith('item/agentMessage/')) return [];

  const budget = { nodes: MAX_WALK_NODES };
  const urls = [];
  for (const root of MEDIA_ROOTS) {
    if (!(root in params)) continue;
    collectFromNode(params[root], urls, budget, MEDIA_ROOTS_IMAGE_HINT.has(root));
    if (budget.nodes <= 0) break;
  }
  // Some shapes put the URL straight on params.
  const direct = normalizeUrl(params.url);
  if (direct) urls.push({ url: direct, hintedImage: false });

  const seen = new Set();
  const media = [];
  for (const entry of urls) {
    if (seen.has(entry.url)) continue;
    seen.add(entry.url);
    media.push({ type: classify(entry.url, entry.hintedImage), url: entry.url, label: labelFor(entry.url) });
    if (media.length >= MAX_MEDIA) break;
  }
  return media;
}

/**
 * Recover a FINISHED agent message delivered as an ITEM instead of deltas.
 *
 * Live capture 2026-10 (after the connector-artifact fix): one chat-overlay turn
 * produced no tokens at all and the user got the canned "I don't have enough
 * context from the allowed source to answer that yet." line, while the earlier
 * turn in the same session answered fine. A turn that ends with zero chunks means
 * the app-server never streamed the message through `item/agentMessage/delta` —
 * the finished text can arrive as `item/completed` instead, which Natively used
 * to drop on the floor.
 *
 * Returns only the part of the finished text that has NOT streamed yet:
 *   • nothing streamed        → the whole message
 *   • item text extends it    → the missing tail
 *   • anything else           → '' (never rewrite an answer that streamed)
 *
 * @param {{ method?: string, params?: any } | null | undefined} notification
 * @param {string} streamedText text already emitted for this turn
 * @returns {string}
 */
export function recoverAgentMessageText(notification, streamedText = '') {
  const method = String(notification?.method || '');
  // Only completion-style item notifications carry a finished message, and the
  // delta channel is never re-read (that would duplicate the answer).
  if (method !== 'item/completed' && method !== 'item/updated') return '';
  const params = notification?.params;
  const item = params?.item;
  if (!item || typeof item !== 'object') return '';

  const text = extractAgentMessageText(item);
  if (!text) return '';
  const streamed = String(streamedText || '');
  if (!streamed.trim()) return text;
  if (text.startsWith(streamed)) return text.slice(streamed.length);
  return '';
}

/** Text of an agent-message item, or '' when the item is something else. */
function extractAgentMessageText(item) {
  const type = String(item.type || '').toLowerCase().replace(/[_-]/g, '');
  const isAgentMessage = type === 'agentmessage' || type === 'assistantmessage' || type === 'outputtext';
  if (isAgentMessage && typeof item.text === 'string' && item.text.trim()) return item.text;
  if (!isAgentMessage) return '';
  if (Array.isArray(item.content)) {
    const joined = item.content
      .map(part => (part && typeof part === 'object' && typeof part.text === 'string' ? part.text : ''))
      .join('');
    if (joined.trim()) return joined;
  }
  return '';
}

/**
 * A link whose visible text would be an opaque identifier (Canva short ids like
 * "GfYkz11JD4TmnUb", asset hashes) tells the user nothing — and, worse, invites
 * copying the LABEL instead of the URL, which is exactly what happened in the
 * Canva session where the follow-up message had to be "here is the id". Those
 * entries show their URL as the clickable text instead.
 *
 * Shape: an unbroken run of ≥12 letters/digits/underscores. A readable slug
 * ("cat-template", "view", "dog.png") never matches, so ordinary labels survive.
 */
const OPAQUE_LABEL_RE = /^[A-Za-z0-9_]{12,}$/;
function visibleLabel(entry) {
  const label = String(entry.label || '');
  if (entry.type === 'link' && OPAQUE_LABEL_RE.test(label)) return entry.url;
  return label || entry.url;
}

/**
 * Build the markdown block to append to an answer, skipping anything the model
 * already printed (so a connector that DID hand over a URL is not repeated).
 *
 * @param {string} existingText full assistant text accumulated so far
 * @param {ExtractedMedia[]} media
 * @returns {string} '' when there is nothing new
 */
export function buildMediaBlock(existingText, media) {
  if (!Array.isArray(media) || media.length === 0) return '';
  const haystack = String(existingText || '').toLowerCase();
  const fresh = media.filter(entry => entry?.url && !haystack.includes(String(entry.url).toLowerCase()));
  if (fresh.length === 0) return '';
  const lines = fresh.map(entry => (entry.type === 'image'
    ? `![${entry.label || 'image'}](${entry.url})`
    : `[${visibleLabel(entry)}](${entry.url})`));
  return `\n\n${lines.join('\n')}`;
}
