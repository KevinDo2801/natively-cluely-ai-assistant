// electron/services/__tests__/CodexNotificationMedia.test.mjs
//
// Live capture 2026-10 (chat overlay, Canva plugin): the connector produced an
// image, the model answered "Đã vẽ chú chó hình vuông như trên" ("drew the square
// dog above"), and the overlay showed NOTHING — artifacts travel as structured
// App Server items, and only `item/agentMessage/delta` text used to be read.
//
// These tests pin the extractor that closes that gap, and the two properties that
// keep it from making the answer worse: it never mines the answer text (which
// would duplicate every URL the model writes), and it never repeats a URL the
// model already printed.

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { buildMediaBlock, collectMediaFromNotification, recoverAgentMessageText } from '../codexNotificationMedia.mjs';

const note = (method, params) => ({ method, params: { threadId: 'thread-1', ...params } });

describe('connector media extraction', () => {
  test('finds an image returned as a structured item', () => {
    const media = collectMediaFromNotification(note('item/completed', {
      item: { type: 'image', imageUrl: 'https://cdn.canva.com/dog-500.png', alt: 'dog' },
    }));
    assert.deepEqual(media, [{
      type: 'image',
      url: 'https://cdn.canva.com/dog-500.png',
      label: 'dog-500.png',
    }]);
  });

  test('finds an image wrapped the OpenAI way', () => {
    const media = collectMediaFromNotification(note('item/completed', {
      item: { content: [{ type: 'image_url', image_url: { url: 'https://example.com/render.webp' } }] },
    }));
    assert.equal(media[0].url, 'https://example.com/render.webp');
    assert.equal(media[0].type, 'image');
  });

  test('classifies a design/app URL as a link, not an image', () => {
    const media = collectMediaFromNotification(note('item/completed', {
      result: { url: 'https://www.canva.com/design/DAF123/view' },
    }));
    assert.deepEqual(media, [{
      type: 'link',
      url: 'https://www.canva.com/design/DAF123/view',
      label: 'view',
    }]);
  });

  // Live capture 2026-10 (Canva, second report): six template previews arrived as
  // extension-less image URLs on the Canva host. Extension sniffing plus the
  // design-host rule typed them as LINKS, so the user saw six opaque id strings
  // instead of the template images.
  test("the item's own type makes an extension-less URL an image", () => {
    const media = collectMediaFromNotification(note('item/completed', {
      item: { type: 'image', url: 'https://www.canva.com/preview/GfYkz11JD4TmnUb/' },
    }));
    assert.equal(media[0].type, 'image');
    assert.equal(media[0].url, 'https://www.canva.com/preview/GfYkz11JD4TmnUb/');
  });

  test('an image-typed wrapper makes its nested URLs images', () => {
    const media = collectMediaFromNotification(note('item/completed', {
      images: [{ url: 'https://media.canva.com/asset/isWfn0T7hrSar7_' }],
    }));
    assert.deepEqual(media.map(entry => entry.type), ['image']);
  });

  test('never mines the answer text itself', () => {
    assert.deepEqual(collectMediaFromNotification(note('item/agentMessage/delta', {
      delta: 'Here it is: https://cdn.canva.com/dog.png',
    })), [], 'mining the delta would duplicate every URL the model writes');
  });

  test('ignores non-http, data: and malformed URLs', () => {
    const media = collectMediaFromNotification(note('item/completed', {
      item: {
        a: 'data:image/png;base64,AAAA',
        b: 'file:///Users/me/dog.png',
        c: 'http://insecure.example.com/dog.png',
        d: 'https://ok.example.com/dog.png',
      },
    }));
    assert.deepEqual(media.map(entry => entry.url), ['https://ok.example.com/dog.png']);
  });

  test('dedupes repeats and caps the list', () => {
    const many = Array.from({ length: 12 }, (_, index) => `https://cdn.example.com/img-${index}.png`);
    const media = collectMediaFromNotification(note('item/completed', {
      images: [...many, many[0]],
    }));
    assert.equal(media.length, 6, 'a runaway item list must not flood the answer');
    assert.equal(new Set(media.map(entry => entry.url)).size, media.length);
  });

  test('an empty or malformed notification yields nothing', () => {
    assert.deepEqual(collectMediaFromNotification(null), []);
    assert.deepEqual(collectMediaFromNotification({ method: 'turn/completed', params: { threadId: 't' } }), []);
  });

  // Deliberate split: a TOOL RESULT's prose is mined (that is where a connector
  // often puts the design link), the ASSISTANT's prose never is.
  test('mines tool-result prose, never assistant prose', () => {
    assert.deepEqual(
      collectMediaFromNotification(note('item/completed', {
        item: { type: 'toolResult', message: 'sent to https://example.com/design' },
      })).map(entry => entry.url),
      ['https://example.com/design'],
    );
    assert.deepEqual(collectMediaFromNotification(note('item/completed', {
      item: { type: 'agentMessage', message: 'xem https://example.com/design' },
    })), []);
  });

  // The assistant's own words are never mined (its URLs already stream), but a
  // TOOL RESULT that carries the design URL only in its text is exactly the case
  // where the user otherwise gets prose with nothing clickable.
  test('mines a URL out of a tool result text, never out of the answer text', () => {
    const fromTool = collectMediaFromNotification(note('item/completed', {
      item: { type: 'toolResult', text: 'Created design: https://www.canva.com/design/DAF999/view' },
    }));
    assert.deepEqual(fromTool.map(entry => entry.url), ['https://www.canva.com/design/DAF999/view']);

    assert.deepEqual(collectMediaFromNotification(note('item/completed', {
      item: { type: 'agentMessage', text: 'Xem https://www.canva.com/design/DAF999/view nhé' },
    })), [], 'mining the agent message would duplicate what the model already wrote');
  });
});

describe('appending media to the answer', () => {
  test('renders an image as markdown and a link as a link', () => {
    const block = buildMediaBlock('Here is your dog:', [
      { type: 'image', url: 'https://cdn.canva.com/dog.png', label: 'dog.png' },
      { type: 'link', url: 'https://www.canva.com/design/DAF1/view', label: 'view' },
    ]);
    assert.equal(block, '\n\n![dog.png](https://cdn.canva.com/dog.png)\n[view](https://www.canva.com/design/DAF1/view)');
  });

  test('never repeats a URL the model already printed', () => {
    const block = buildMediaBlock('Done: ![dog](https://cdn.canva.com/dog.png)', [
      { type: 'image', url: 'https://cdn.canva.com/dog.png', label: 'dog.png' },
    ]);
    assert.equal(block, '');
  });

  // The Canva follow-up failed because the visible text of each link was a bare
  // short id ("GfYkz11JD4TmnUb"), which the user copied back as the "link". An
  // opaque label must show the URL instead, so there is something real to copy.
  test('an opaque id label shows the URL as the clickable text', () => {
    const block = buildMediaBlock('Chọn mẫu:', [
      { type: 'link', url: 'https://www.canva.com/templates/GfYkz11JD4TmnUb/', label: 'GfYkz11JD4TmnUb' },
    ]);
    assert.equal(block, '\n\n[https://www.canva.com/templates/GfYkz11JD4TmnUb/](https://www.canva.com/templates/GfYkz11JD4TmnUb/)');
  });

  test('a readable label is kept as-is', () => {
    const block = buildMediaBlock('Chọn mẫu:', [
      { type: 'link', url: 'https://example.com/designs/cat-template', label: 'cat-template' },
    ]);
    assert.equal(block, '\n\n[cat-template](https://example.com/designs/cat-template)');
  });

  test('appends only the URLs that are new', () => {
    const block = buildMediaBlock('see https://cdn.canva.com/dog.png', [
      { type: 'image', url: 'https://cdn.canva.com/dog.png', label: 'dog.png' },
      { type: 'image', url: 'https://cdn.canva.com/cat.png', label: 'cat.png' },
    ]);
    assert.equal(block, '\n\n![cat.png](https://cdn.canva.com/cat.png)');
  });

  test('is a no-op without media', () => {
    assert.equal(buildMediaBlock('an answer', []), '');
    assert.equal(buildMediaBlock('an answer', undefined), '');
  });
});

// Live capture 2026-10: a chat-overlay turn ended with ZERO tokens and the user
// got the canned "I don't have enough context from the allowed source to answer
// that yet." line, while the previous turn in the same session answered normally.
// A finished message delivered as an ITEM (not as deltas) explains it — and the
// streamed text must never be rewritten by the recovery.
describe('recovering a message delivered as an item', () => {
  const note = (method, params) => ({ method, params: { threadId: 'thread-1', ...params } });

  test('returns the whole text when nothing streamed', () => {
    assert.equal(
      recoverAgentMessageText(note('item/completed', { item: { type: 'agentMessage', text: 'Mèo 300×500 đã xong.' } })),
      'Mèo 300×500 đã xong.',
    );
  });

  test('joins a content-part message', () => {
    assert.equal(
      recoverAgentMessageText(note('item/completed', {
        item: { type: 'output_text', content: [{ type: 'output_text', text: 'part one ' }, { type: 'output_text', text: 'part two' }] },
      })),
      'part one part two',
    );
  });

  test('returns only the missing tail when deltas already streamed', () => {
    assert.equal(
      recoverAgentMessageText(
        note('item/completed', { item: { type: 'agentMessage', text: 'Hello world, done.' } }),
        'Hello world,',
      ),
      ' done.',
    );
  });

  test('never rewrites an answer that already streamed differently', () => {
    assert.equal(
      recoverAgentMessageText(
        note('item/completed', { item: { type: 'agentMessage', text: 'Redacted different text' } }),
        'What actually streamed',
      ),
      '',
    );
  });

  test('ignores the delta channel and non-message items', () => {
    assert.equal(recoverAgentMessageText(note('item/agentMessage/delta', { delta: 'x' })), '');
    assert.equal(recoverAgentMessageText(note('item/completed', { item: { type: 'toolCall', text: 'internal' } })), '');
    assert.equal(recoverAgentMessageText(note('turn/completed', { turn: { status: 'completed' } })), '');
  });
});
