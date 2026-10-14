// Evidence from earlier meetings is admitted by relevance, not by a keyword gate.
//
// Run with: npm run build:electron && node --test electron/llm/__tests__/PastMeetingSource.test.mjs

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const dist = path.resolve(process.cwd(), 'dist-electron/electron');
const { buildPastMeetingBlock } = await import(pathToFileURL(path.join(dist, 'llm/pastMeetingSource.js')).href);

const chunk = (meetingId, text, similarity = 0.4, startMs = 0) => ({ meetingId, text, similarity, startMs });

const searchOf = (chunks) => async () => chunks;

const run = (over = {}) => buildPastMeetingBlock({
  question: 'hôm qua thầy giảng gì về đạo hàm',
  explicit: false,
  deps: { search: searchOf([]) },
  ...over,
});

describe('past meeting source — lexical admission (no calibrated floor)', () => {
  test('admits a chunk that shares enough distinctive words, with no past-meeting keyword in the question', async () => {
    const r = await run({
      deps: {
        search: searchOf([
          chunk('m1', '[1:02] Thầy: hôm nay ta học đạo hàm của hàm hợp, quy tắc chuỗi.'),
          chunk('m2', '[0:10] Nhóm bàn về kế hoạch ra mắt sản phẩm quý sau.'),
        ]),
      },
    });
    assert.equal(r.admittedBy, 'lexical');
    assert.deepEqual(r.meetings, ['m1']);
    assert.match(r.block, /đạo hàm/);
    assert.doesNotMatch(r.block, /ra mắt sản phẩm/);
    assert.deepEqual(r.dataScopes, ['transcript']);
  });

  test('admits nothing when no chunk is actually about the question', async () => {
    const r = await run({
      deps: { search: searchOf([chunk('m2', '[0:10] Nhóm bàn về kế hoạch ra mắt sản phẩm quý sau.', 0.31)]) },
    });
    assert.equal(r.block, '');
    assert.equal(r.skipped, 'none_relevant');
    assert.equal(r.candidates, 1);
  });

  test('a one-word question needs only one shared word', async () => {
    const r = await run({
      question: 'Kubernetes?',
      deps: { search: searchOf([chunk('m1', 'We migrated the cluster to Kubernetes last sprint.')]) },
    });
    assert.deepEqual(r.meetings, ['m1']);
  });
});

describe('past meeting source — other admission rules', () => {
  test('an explicit past-meeting reference keeps the best-ranked chunks even without word overlap', async () => {
    const r = await run({
      explicit: true,
      deps: { search: searchOf([chunk('m1', 'Chúng ta chốt ngân sách hai trăm triệu.', 0.5)]) },
    });
    assert.equal(r.admittedBy, 'explicit');
    assert.deepEqual(r.meetings, ['m1']);
  });

  test('a calibrated cosine floor admits by similarity alone', async () => {
    const r = await run({
      semanticFloor: 0.69,
      question: 'what was agreed about pricing',
      deps: {
        search: searchOf([
          chunk('m1', 'Totally different wording here.', 0.8),
          chunk('m2', 'Pricing pricing pricing agreed agreed.', 0.5),
        ]),
      },
    });
    assert.equal(r.admittedBy, 'semantic_floor');
    assert.deepEqual(r.meetings, ['m1']);
  });
});

describe('past meeting source — guards', () => {
  test('never recalls an excluded meeting (the one happening now / the live index)', async () => {
    const r = await run({
      excludeMeetingIds: ['live-meeting-current', 'now'],
      deps: {
        search: searchOf([
          chunk('live-meeting-current', 'đạo hàm của hàm hợp, thầy giảng'),
          chunk('now', 'đạo hàm của hàm hợp, thầy giảng'),
        ]),
      },
    });
    assert.equal(r.block, '');
    assert.equal(r.skipped, 'no_candidates');
  });

  test('drops passages the prompt already carries', async () => {
    const text = 'Thầy giảng đạo hàm của hàm hợp bằng quy tắc chuỗi';
    const r = await run({ composedContext: `Transcript:\n${text}\nCâu hỏi tiếp theo`, deps: { search: searchOf([chunk('m1', text)]) } });
    assert.equal(r.block, '');
    assert.equal(r.skipped, 'none_relevant');
  });

  test('a denied transcript scope never even searches', async () => {
    let called = false;
    const r = await run({
      scopePolicy: { transcript: false },
      deps: { search: async () => { called = true; return []; } },
    });
    assert.equal(r.skipped, 'scope_denied');
    assert.equal(called, false);
  });

  test('a slow search is abandoned at the deadline', async () => {
    const r = await run({
      limits: { searchMs: 20 },
      deps: { search: () => new Promise((resolve) => setTimeout(() => resolve([chunk('m1', 'đạo hàm thầy giảng')]), 400)) },
    });
    assert.equal(r.timedOut, true);
    assert.equal(r.skipped, 'timeout');
    assert.equal(r.block, '');
  });

  test('a failing search adds nothing and does not throw', async () => {
    const r = await run({ deps: { search: async () => { throw new Error('embedding service down'); } } });
    assert.equal(r.skipped, 'failed');
    assert.equal(r.block, '');
  });

  test('no search function, or an empty question, is a clean skip', async () => {
    assert.equal((await buildPastMeetingBlock({ question: 'x y z', explicit: false, deps: {} })).skipped, 'no_search');
    assert.equal((await run({ question: '   ' })).skipped, 'empty_question');
  });
});

describe('past meeting source — output shape', () => {
  test('labels each meeting with its title and date, and caps meetings and size', async () => {
    const mk = (id) => chunk(id, `đạo hàm thầy giảng buổi ${id} `.repeat(20), 0.4);
    const r = await run({
      limits: { maxMeetings: 2, blockChars: 2000 },
      deps: {
        search: searchOf([mk('a'), mk('b'), mk('c')]),
        describeMeeting: (id) => ({ title: `Giải tích ${id}`, date: '2026-10-12T09:00:00.000Z' }),
      },
    });
    assert.equal(r.meetings.length, 2);
    assert.match(r.block, /--- "Giải tích a", 2026-10-12 ---/);
    assert.ok(r.block.length < 2000 + 600, 'block stays near the character budget');
  });

  test('a throwing meeting directory still yields a usable block', async () => {
    const r = await run({
      deps: {
        search: searchOf([chunk('m1', 'đạo hàm thầy giảng')]),
        describeMeeting: () => { throw new Error('db closed'); },
      },
    });
    assert.match(r.block, /--- Earlier meeting ---/);
  });
});

describe('past meeting source — the latest finished meeting', () => {
  const latest = [
    chunk('m9', 'Speaker 1: Robot thắng cuộc đua trong chín giây đầu.', 1, 0),
    chunk('m9', 'Speaker 1: Hook ba giây đầu quyết định người xem ở lại.', 1, 5000),
  ];

  test('a generic question about "the meeting just now" gets that meeting, in order, with no word overlap', async () => {
    const r = await run({
      question: 'nội dung meeting vừa rồi là gì?',
      recent: true,
      semanticFloor: 0.69,
      deps: { latestMeeting: async () => latest, search: async () => { throw new Error('similarity search must not run'); } },
    });
    assert.equal(r.admittedBy, 'recent');
    assert.deepEqual(r.meetings, ['m9']);
    assert.ok(r.block.indexOf('Robot thắng') < r.block.indexOf('Hook ba giây'), 'transcript order is kept');
  });

  test('no finished meeting is reported distinctly from "nothing similar"', async () => {
    const r = await run({ recent: true, deps: { latestMeeting: async () => [] } });
    assert.equal(r.skipped, 'no_recent_meeting');
  });

  test('without a latest-meeting source the normal search still runs', async () => {
    const r = await run({ recent: true, deps: { search: searchOf([chunk('m1', 'đạo hàm thầy giảng')]) } });
    assert.equal(r.admittedBy, 'lexical');
  });

  test('a live meeting is never offered as the latest finished one', async () => {
    const r = await run({
      recent: true,
      excludeMeetingIds: ['m9'],
      deps: { latestMeeting: async () => latest },
    });
    assert.equal(r.block, '');
  });
});
