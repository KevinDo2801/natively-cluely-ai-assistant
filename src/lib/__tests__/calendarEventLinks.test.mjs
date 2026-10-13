import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { stripCalendarEventLinks } from '../calendarEventLinks.ts';
import { normalizeFinalizedMarkdownMath, renderStreamingMarkdown } from '../streamingMarkdown.ts';

const GCAL = 'https://calendar.google.com/calendar/event?eid=abc123';

describe('stripCalendarEventLinks', () => {
  it('removes bare event citation links to Google Calendar', () => {
    const src = `Hôm qua có họp.\n\n[event](${GCAL})\n[event](${GCAL})\n`;
    assert.equal(stripCalendarEventLinks(src).trim(), 'Hôm qua có họp.');
  });

  it('removes inline citations and the space before them', () => {
    assert.equal(
      stripCalendarEventLinks(`Advising lúc 11:30 [event](${GCAL}) qua Teams.`),
      'Advising lúc 11:30 qua Teams.',
    );
  });

  it('accepts the www.google.com/calendar URL shape', () => {
    assert.equal(
      stripCalendarEventLinks('Họp [event](https://www.google.com/calendar/event?eid=x) xong.'),
      'Họp xong.',
    );
  });

  it('keeps links with other labels or other hosts', () => {
    const keep = `[Agenda](${GCAL}) and [event](https://example.com/e/1)`;
    assert.equal(stripCalendarEventLinks(keep), keep);
  });

  it('hides a half-streamed trailing event link', () => {
    assert.equal(stripCalendarEventLinks('Xong. [event](https://calendar.go'), 'Xong.');
    assert.equal(stripCalendarEventLinks('Xong. [event]'), 'Xong.');
  });

  it('is a no-op for text without event links', () => {
    assert.equal(stripCalendarEventLinks('plain text'), 'plain text');
    assert.equal(stripCalendarEventLinks(''), '');
  });
});

describe('calendar event links never reach rendered output', () => {
  const src = `Họp hôm qua.\n\n[event](${GCAL})\n`;
  it('finalized path', () => {
    assert.ok(!normalizeFinalizedMarkdownMath(src).includes('[event]'));
  });
  it('streaming path', () => {
    const html = renderStreamingMarkdown(src);
    assert.ok(!html.includes('event</a>'));
    assert.ok(html.includes('Họp hôm qua.'));
  });
});
