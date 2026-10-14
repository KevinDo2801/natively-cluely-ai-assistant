// One decision point for which sources a typed chat turn draws on; the two
// assembly paths differ only in how the chosen sources are attached.
//
// Run with: npm run build:electron && node --test electron/llm/__tests__/ChatSources.test.mjs

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const dist = path.resolve(process.cwd(), 'dist-electron/electron');
const { planChatSources, startChatSources } = await import(pathToFileURL(path.join(dist, 'llm/chatSources.js')).href);

const basePlan = {
  path: 'idle',
  question: 'trường đại học của tôi là gì?',
  hasImages: false,
  attachedFileCount: 1,
  liveMeetingQueryable: false,
  pastMeetingsQueryable: true,
};

describe('planChatSources — the single decision', () => {
  test('idle: attached files are in play; the live meeting belongs to V3', () => {
    const p = planChatSources(basePlan);
    assert.deepEqual(p.referenceFiles, { use: true, why: 'attached_to_mode' });
    assert.deepEqual(p.liveMeeting, { use: false, why: 'v3_meeting_port' });
  });

  test('live-transcript: the renderer already composed the files; live-meeting recall is eligible', () => {
    const p = planChatSources({ ...basePlan, path: 'live-transcript', liveMeetingQueryable: true });
    assert.deepEqual(p.referenceFiles, { use: false, why: 'renderer_composed' });
    assert.deepEqual(p.liveMeeting, { use: true, why: 'long_meeting_recall' });
  });

  test('no files and denied scopes are reported, not silent', () => {
    assert.equal(planChatSources({ ...basePlan, attachedFileCount: 0 }).referenceFiles.why, 'no_files');
    assert.equal(planChatSources({ ...basePlan, scopePolicy: { reference_files: false } }).referenceFiles.why, 'scope_denied');
    assert.equal(
      planChatSources({ ...basePlan, path: 'live-transcript', liveMeetingQueryable: true, scopePolicy: { transcript: false } }).liveMeeting.why,
      'scope_denied',
    );
  });

  test('earlier meetings are weighed for an ordinary question, with no keyword needed', () => {
    const p = planChatSources({ ...basePlan, question: 'tiết trước thầy dạy gì về đạo hàm' });
    assert.deepEqual(p.pastMeetings, { use: true, why: 'relevance_search', explicit: false, recent: false });
  });

  test('a question that names a past meeting is flagged explicit', () => {
    const p = planChatSources({ ...basePlan, question: 'what did we decide in last week\'s call?' });
    assert.deepEqual(p.pastMeetings, { use: true, why: 'names_past_meeting', explicit: true, recent: false });
  });

  test('"the meeting just now" selects the latest meeting by recency, unless a meeting is live', () => {
    const q = 'nội dung meeting vừa rồi là gì?';
    assert.deepEqual(planChatSources({ ...basePlan, question: q }).pastMeetings, { use: true, why: 'latest_meeting', explicit: false, recent: true });
    const live = planChatSources({ ...basePlan, question: q, meetingActive: true }).pastMeetings;
    assert.equal(live.recent, false, 'during a live meeting "just now" means the live transcript');
  });

  test('earlier meetings are skipped for screenshots, vague follow-ups, no index and denied scope', () => {
    assert.equal(planChatSources({ ...basePlan, hasImages: true }).pastMeetings.why, 'screenshot_turn');
    assert.equal(planChatSources({ ...basePlan, question: 'explain that' }).pastMeetings.why, 'vague_followup');
    assert.equal(planChatSources({ ...basePlan, pastMeetingsQueryable: false }).pastMeetings.why, 'rag_not_ready');
    assert.equal(planChatSources({ ...basePlan, scopePolicy: { transcript: false } }).pastMeetings.why, 'scope_denied');
    assert.equal(planChatSources({ ...basePlan, question: '  ' }).pastMeetings.why, 'empty_question');
  });
});

const resume = { fileName: 'Resume.pdf', content: 'Kiet Do. University of South Florida. Skills: TypeScript.' };
const lectureChunk = { meetingId: 'm1', text: '[1:02] Thầy: đạo hàm của hàm hợp dùng quy tắc chuỗi.', similarity: 0.4, startMs: 0 };

const pastDeps = (chunks = [lectureChunk]) => ({
  excludeMeetingIds: ['live-meeting-current'],
  semanticFloor: null,
  deps: { search: async () => chunks },
});

describe('startChatSources — one set of sources, merged', () => {
  test('idle: earlier meetings and the mode file are both attached, with both scopes declared', async () => {
    const plan = planChatSources({ ...basePlan, question: 'thầy giảng gì về đạo hàm của hàm hợp' });
    const r = await startChatSources(plan, { question: 'thầy giảng gì về đạo hàm của hàm hợp', files: [resume] }, { pastMeetings: pastDeps() })
      .settle({ evidenceCount: 0 });
    assert.match(r.block, /RELEVANT PASSAGES FROM EARLIER MEETINGS/);
    assert.match(r.block, /REFERENCE FILES ATTACHED TO THE ACTIVE MODE/);
    assert.ok(r.block.indexOf('EARLIER MEETINGS') < r.block.indexOf('REFERENCE FILES'));
    assert.deepEqual([...r.dataScopes].sort(), ['reference_files', 'transcript']);
    assert.equal(r.report.pastMeetings.used, true);
    assert.equal(r.report.referenceFiles.applied, true);
  });

  test('V3 evidence suppresses the file but not the earlier-meeting passages', async () => {
    const q = 'thầy giảng gì về đạo hàm của hàm hợp';
    const r = await startChatSources(planChatSources({ ...basePlan, question: q }), { question: q, files: [resume] }, { pastMeetings: pastDeps() })
      .settle({ evidenceCount: 3 });
    assert.doesNotMatch(r.block, /REFERENCE FILES/);
    assert.match(r.block, /EARLIER MEETINGS/);
    assert.deepEqual(r.dataScopes, ['transcript']);
    assert.equal(r.report.referenceFiles.skipped, 'has_evidence');
  });

  test('when V3 said "no evidence", the earlier-meeting block carries an override note', async () => {
    const q = 'thầy giảng gì về đạo hàm của hàm hợp';
    const r = await startChatSources(planChatSources({ ...basePlan, question: q, attachedFileCount: 0 }), { question: q, files: [] }, { pastMeetings: pastDeps() })
      .settle({ evidenceCount: 0, overridesNoEvidenceNotice: true });
    assert.match(r.block, /disregard any statement above that no evidence was found/);
  });

  test('live-transcript: only live-meeting recall and earlier meetings; never the files', async () => {
    const q = 'thầy giảng gì về đạo hàm của hàm hợp';
    const plan = planChatSources({ ...basePlan, path: 'live-transcript', question: q, liveMeetingQueryable: true });
    const live = async () => ({
      block: '[RELEVANT EARLIER MOMENTS FROM THIS MEETING]\nx',
      dataScopes: ['transcript'],
      profile: { included: false, chars: 0, docs: [], withheld: [] },
      meeting: { attempted: true, included: true, chunks: 1, timedOut: false },
      ms: 1,
    });
    const r = await startChatSources(plan, { question: q, composedContext: 'Transcript so far', files: [resume] }, { liveMeeting: live, pastMeetings: pastDeps() }).settle();
    assert.ok(r.block.indexOf('THIS MEETING') < r.block.indexOf('EARLIER MEETINGS'));
    assert.doesNotMatch(r.block, /REFERENCE FILES/);
    assert.equal(r.report.liveMeeting.included, true);
  });

  test('a failing live-meeting source cannot break the turn or the other sources', async () => {
    const q = 'thầy giảng gì về đạo hàm của hàm hợp';
    const plan = planChatSources({ ...basePlan, path: 'live-transcript', question: q, liveMeetingQueryable: true });
    const r = await startChatSources(plan, { question: q, composedContext: 'T', files: [] }, {
      liveMeeting: async () => { throw new Error('boom'); },
      pastMeetings: pastDeps(),
    }).settle();
    assert.match(r.block, /EARLIER MEETINGS/);
    assert.equal(r.report.liveMeeting.attempted, false);
  });

  test('nothing selected → empty block, empty scopes, and the report says why', async () => {
    const q = 'explain that';
    const r = await startChatSources(planChatSources({ ...basePlan, question: q, attachedFileCount: 0 }), { question: q, files: [] }, {}).settle({ evidenceCount: 0 });
    assert.equal(r.block, '');
    assert.deepEqual(r.dataScopes, []);
    assert.equal(r.report.plan.pastMeetings, 'vague_followup');
    assert.equal(r.report.plan.referenceFiles, 'no_files');
  });

  test('a denied reference_files scope keeps the file out even when V3 had no evidence', async () => {
    const q = 'trường đại học của tôi là gì?';
    const plan = planChatSources({ ...basePlan, question: q, scopePolicy: { reference_files: false } });
    const r = await startChatSources(plan, { question: q, files: [resume], scopePolicy: { reference_files: false } }, {}).settle({ evidenceCount: 0 });
    assert.doesNotMatch(r.block, /REFERENCE FILES/);
    assert.equal(r.report.plan.referenceFiles, 'scope_denied');
  });
});
