// Typed chat WITH a live transcript: profile + long-meeting recall enrichment.
//
// Run with: npm run build:electron && node --test electron/llm/__tests__/CallerOwnedChatEnrichment2026_10.test.mjs
//
// The enrichment is pure given injected deps, so every behaviour below is
// asserted without Electron, a database or an embedding model.

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const dist = path.resolve(process.cwd(), 'dist-electron/electron');
const {
  buildCallerOwnedChatEnrichment,
  DEFAULT_ENRICHMENT_LIMITS,
} = await import(pathToFileURL(path.join(dist, 'llm/callerOwnedChatEnrichment.js')).href);

const filler = (n, tag) => Array.from({ length: n }, (_, i) => `${tag} duty ${i}: coordinated delivery with stakeholders and kept documentation current.`);

const resumeDoc = (over = {}) => ({
  kind: 'resume',
  sourceId: 'psrc_resume',
  versionId: 'v1',
  fileName: 'Candidate Resume (Profile Intelligence)',
  structured: {
    identity: { name: 'Jane Doe', summary: 'Staff engineer focused on payments reliability.' },
    experience: [
      { role: 'Staff Engineer', company: 'Acme Payments', start_date: '2021', end_date: 'now', bullets: ['Led the ledger migration', 'Cut p99 latency by 40%'] },
      { role: 'Engineer', company: 'Globex', start_date: '2017', end_date: '2021', bullets: ['Built the Kafka ingestion pipeline'] },
    ],
    skills: { languages: ['Go', 'Python'], infra: ['Kafka', 'PostgreSQL'] },
    education: [{ degree: 'BSc', field: 'Computer Science', institution: 'State University' }],
    certifications: ['CKA Kubernetes administrator'],
  },
  ...over,
});

const jdDoc = () => ({
  kind: 'jd',
  sourceId: 'psrc_jd',
  versionId: 'v1',
  fileName: 'Target Job Description (Profile Intelligence)',
  structured: {
    title: 'Principal Engineer', company: 'Initech',
    requirements: ['10+ years backend', 'Distributed systems', 'Kubernetes in production'],
  },
});

const factDoc = () => ({
  kind: 'fact',
  sourceId: 'psrc_fact',
  versionId: 'v1',
  fileName: 'Derived profile facts (Profile Intelligence)',
  structured: { salary_estimate: { min: 150000, max: 190000, currency: 'USD', confidence: 'medium', role: 'Staff Engineer', location: 'Remote' } },
});

const INTERVIEW = ['RESUME', 'JOB_DESCRIPTION', 'PROFILE_FACT'];
const run = (over = {}) => buildCallerOwnedChatEnrichment({
  question: 'how does my experience fit this role?',
  composedContext: 'short transcript',
  profileSources: INTERVIEW,
  deps: { loadProfileDocs: () => [resumeDoc(), jdDoc(), factDoc()] },
  ...over,
});

describe('profile enrichment — opt-in and privacy', () => {
  test('a mode without profileSources gets NO profile and never even loads it', async () => {
    let loaded = false;
    const r = await run({ profileSources: [], deps: { loadProfileDocs: () => { loaded = true; return [resumeDoc()]; } } });
    assert.equal(loaded, false);
    assert.equal(r.block, '');
    assert.deepEqual(r.dataScopes, []);
  });

  test('interview mode includes the résumé with the heading the persona refers to', async () => {
    const r = await run();
    assert.match(r.block, /\[CANDIDATE PROFILE/);
    assert.match(r.block, /Acme Payments/);
    assert.match(r.block, /Jane Doe/);
    assert.equal(r.profile.included, true);
    assert.ok(r.dataScopes.includes('profile_history'));
  });

  test('the JD is labelled as emphasis-only and rides the reference_files scope', async () => {
    const r = await run();
    assert.match(r.block, /\[TARGET JOB DESCRIPTION — shapes emphasis, NOT proof/);
    assert.match(r.block, /Kubernetes in production/);
    assert.ok(r.dataScopes.includes('reference_files'));
  });

  test('profile_history denied → no résumé / facts leave the device, JD unaffected', async () => {
    const r = await run({ scopePolicy: { profile_history: false } });
    assert.doesNotMatch(r.block, /CANDIDATE PROFILE/);
    assert.doesNotMatch(r.block, /Acme Payments/);
    assert.match(r.block, /TARGET JOB DESCRIPTION/);
    assert.ok(!r.dataScopes.includes('profile_history'));
    assert.deepEqual(r.profile.withheld, ['profile_history']);
  });

  test('reference_files denied → JD withheld, résumé unaffected', async () => {
    const r = await run({ scopePolicy: { reference_files: false } });
    assert.match(r.block, /CANDIDATE PROFILE/);
    assert.doesNotMatch(r.block, /TARGET JOB DESCRIPTION/);
    assert.ok(!r.dataScopes.includes('reference_files'));
  });

  test('a mode that opts in to RESUME only does not receive the JD or facts', async () => {
    const r = await run({ profileSources: ['RESUME'] });
    assert.match(r.block, /CANDIDATE PROFILE/);
    assert.doesNotMatch(r.block, /TARGET JOB DESCRIPTION/);
    assert.doesNotMatch(r.block, /DERIVED PROFILE FACTS/);
  });
});

describe('profile enrichment — relevance and language', () => {
  test('a Vietnamese question against an English résumé still gets the overview', async () => {
    // No lexical overlap at all: the section prior must carry the turn.
    const r = await run({ question: 'kinh nghiệm của tôi liên quan gì?' });
    assert.match(r.block, /Acme Payments/);
    assert.match(r.block, /Globex/);
    assert.match(r.block, /Go, Python/);
  });

  test('when the profile exceeds its budget, the section the question is about wins', async () => {
    const big = resumeDoc();
    big.structured.experience = [
      ...filler(40, 'early').map((b, i) => ({ role: `Role ${i}`, company: `Company ${i}`, bullets: [b, b] })),
    ];
    const r = await run({
      question: 'do I have a kubernetes certification',
      deps: { loadProfileDocs: () => [big] },
      profileSources: ['RESUME'],
      limits: { resumeChars: 1200 },
    });
    assert.match(r.block, /CKA Kubernetes administrator/);
    assert.ok(r.profile.chars <= 1200);
  });

  test('the derived salary fact stays out unless salary is asked — in any language', async () => {
    const quiet = await run({ question: 'kinh nghiệm của tôi liên quan gì?' });
    assert.doesNotMatch(quiet.block, /DERIVED PROFILE FACTS/);
    for (const q of ['what is my expected salary', 'lương mong muốn của tôi là bao nhiêu', 'mi salario esperado', '期望工资是多少']) {
      const r = await run({ question: q });
      assert.match(r.block, /DERIVED PROFILE FACTS/, q);
      assert.match(r.block, /150,000/, q);
    }
  });

  test('profile text stays bounded', async () => {
    const r = await run();
    assert.ok(r.block.length < 9000, `block too large: ${r.block.length}`);
  });
});

describe('long-meeting recall', () => {
  const LONG = 'x '.repeat(DEFAULT_ENRICHMENT_LIMITS.longContextChars);
  const chunk = (text, startMs = 0) => ({ text, startMs, similarity: 0.7 });

  test('a short context never triggers (or pays for) a search', async () => {
    let calls = 0;
    const r = await run({ profileSources: [], deps: { searchLiveMeeting: async () => { calls++; return []; } } });
    assert.equal(calls, 0);
    assert.equal(r.meeting.attempted, false);
  });

  test('a long context with a topical question recalls older moments, labelled as older', async () => {
    const r = await run({
      profileSources: [],
      question: 'what budget did procurement approve for the vendor contract',
      composedContext: LONG,
      deps: { searchLiveMeeting: async () => [chunk('[3:10] Speaker: procurement approved a vendor contract budget of two hundred thousand', 190000)] },
    });
    assert.equal(r.meeting.included, true);
    assert.match(r.block, /RELEVANT EARLIER MOMENTS/);
    assert.match(r.block, /two hundred thousand/);
    assert.deepEqual(r.dataScopes, ['transcript']);
  });

  test('a chunk the transcript window already contains is not repeated', async () => {
    const said = 'procurement approved the vendor contract budget yesterday afternoon';
    const r = await run({
      profileSources: [],
      question: 'vendor contract budget',
      composedContext: `${LONG} [INTERVIEWER]: ${said}`,
      deps: { searchLiveMeeting: async () => [chunk(`[1:00] Speaker: ${said}`)] },
    });
    assert.equal(r.meeting.included, false);
    assert.equal(r.block, '');
  });

  test('vague "what did she say" questions skip recall (they mean the LATEST words)', async () => {
    let calls = 0;
    for (const q of ['what did she say', 'thầy đang nói gì', 'explain that']) {
      await run({ profileSources: [], question: q, composedContext: LONG, deps: { searchLiveMeeting: async () => { calls++; return []; } } });
    }
    assert.equal(calls, 0);
  });

  test('a slow search is abandoned at the deadline and adds nothing', async () => {
    const t0 = Date.now();
    const r = await run({
      profileSources: [],
      question: 'vendor contract budget',
      composedContext: LONG,
      limits: { meetingSearchMs: 40 },
      deps: { searchLiveMeeting: () => new Promise((resolve) => setTimeout(() => resolve([chunk('late answer')]), 400)) },
    });
    assert.ok(Date.now() - t0 < 300, 'must not wait for the slow search');
    assert.equal(r.meeting.timedOut, true);
    assert.equal(r.block, '');
  });

  test('a throwing / rejecting search is swallowed', async () => {
    const r1 = await run({ profileSources: [], question: 'vendor contract', composedContext: LONG, deps: { searchLiveMeeting: async () => { throw new Error('embed down'); } } });
    const r2 = await run({ profileSources: [], question: 'vendor contract', composedContext: LONG, deps: { searchLiveMeeting: () => { throw new Error('sync boom'); } } });
    assert.equal(r1.block, '');
    assert.equal(r2.block, '');
  });

  test('transcript scope denied → no search at all', async () => {
    let calls = 0;
    await run({
      profileSources: [], question: 'vendor contract', composedContext: LONG,
      scopePolicy: { transcript: false },
      deps: { searchLiveMeeting: async () => { calls++; return [chunk('x')]; } },
    });
    assert.equal(calls, 0);
  });

  test('recalled moments are capped', async () => {
    const many = Array.from({ length: 6 }, (_, i) => chunk(`unique topic ${i} ${'detail '.repeat(150)}`, i * 1000));
    const r = await run({
      profileSources: [], question: 'unique topic detail', composedContext: LONG,
      deps: { searchLiveMeeting: async () => many },
    });
    assert.ok(r.block.length <= DEFAULT_ENRICHMENT_LIMITS.meetingBlockChars + 300);
  });
});

describe('failure safety', () => {
  test('a throwing profile loader degrades to an empty result, never a throw', async () => {
    const r = await run({ deps: { loadProfileDocs: () => { throw new Error('db locked'); } } });
    assert.equal(r.block, '');
  });

  test('a malformed profile doc yields no block instead of an exception', async () => {
    const r = await run({ deps: { loadProfileDocs: () => [{ kind: 'resume', sourceId: 'x', versionId: 'v', fileName: 'f', structured: 'not-an-object' }] } });
    assert.equal(r.block, '');
  });

  test('raw text is used when a doc has no structured extraction', async () => {
    const r = await run({
      profileSources: ['RESUME'],
      question: 'kubernetes',
      deps: { loadProfileDocs: () => [{ kind: 'resume', sourceId: 'raw', versionId: 'v', fileName: 'f', structured: null, rawText: 'Jane Doe\nKubernetes platform lead at Acme.' }] },
    });
    assert.match(r.block, /Kubernetes platform lead/);
  });

  test('reports how long it took (for the [ManualChat] log line)', async () => {
    const r = await run();
    assert.equal(typeof r.ms, 'number');
    assert.ok(r.ms >= 0);
  });
});
