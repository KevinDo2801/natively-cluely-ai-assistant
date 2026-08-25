// Guards the company-research search-provider wiring (2026-07-31 fix).
//
// Bug: the Tavily → Natively → none provider cascade lived ONLY in the manual
// profile:research-company IPC handler, so the automatic AOT pipeline (JD
// upload) always ran with searchProvider=null and silently degraded every
// dossier to LLM-only guesswork — even with a Natively key configured. The
// degraded dossier was then cached for 24h and consumed by the whole
// negotiation/gap-analysis/mock-question chain.
//
// Two layers of protection here, matching the repo's mixed style:
//  1. Behavioral tests against the compiled CompanyResearchEngine — the
//     degraded-flag + cache-bypass semantics.
//  2. Source-inspection guards that the wiring call sites exist and both the
//     manual and AOT paths go through the ONE shared resolver.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '../../..');
const read = (p) => fs.readFileSync(path.join(root, p), 'utf8');

// The premium submodule was removed from this repo, so the compiled
// CompanyResearchEngine is absent: skip the premium-dependent behavioral
// suites gracefully instead of failing at require() time.
let PREMIUM_AVAILABLE = true;
let CompanyResearchEngine;
try {
  ({ CompanyResearchEngine } = require(
    path.join(root, 'dist-electron/premium/electron/knowledge/CompanyResearchEngine.js')
  ));
} catch (err) {
  PREMIUM_AVAILABLE = false;
  console.warn(`[premium-absent] ${err?.code ?? err?.message ?? err} — skipping premium-dependent suites in ${import.meta.url}`);
}
const testIfPremium = PREMIUM_AVAILABLE ? test : test.skip;

const VALID_DOSSIER_JSON = JSON.stringify({
    company: 'Acme',
    hiring_strategy: 'hires',
    interview_focus: 'coding',
    salary_estimates: [],
    competitors: [],
    recent_news: '',
    core_values: [],
    sources: [],
});

function makeFakeDb({ cachedDossier = null, stale = false } = {}) {
    const saved = [];
    return {
        saved,
        getDossier: () => (cachedDossier ? { dossier: cachedDossier } : null),
        isDossierStale: () => stale,
        saveDossier: (name, dossier, sources) => saved.push({ name, dossier, sources }),
    };
}

testIfPremium('no search provider → LLM-only dossier is marked degraded and cached as such', async () => {
    const db = makeFakeDb();
    const engine = new CompanyResearchEngine(db);
    engine.setGenerateContentFn(async () => VALID_DOSSIER_JSON);

    const dossier = await engine.researchCompany('Acme', {});
    assert.ok(dossier, 'should still produce a dossier');
    assert.equal(dossier.degraded, true, 'LLM-only dossier must carry degraded:true');
    assert.equal(db.saved.length, 1, 'degraded dossier is still cached');
    assert.equal(db.saved[0].dossier.degraded, true, 'cached copy carries the flag');
});

testIfPremium('fresh cached DEGRADED dossier + provider now available → cache bypassed, search attempted', async () => {
    const db = makeFakeDb({ cachedDossier: { company: 'Acme', degraded: true }, stale: false });
    const engine = new CompanyResearchEngine(db);
    engine.setGenerateContentFn(async () => VALID_DOSSIER_JSON);
    let searchCalls = 0;
    engine.setSearchProvider({
        // Throw after recording: proves the search path was ENTERED (cache
        // bypassed) without paying the engine's inter-query delays.
        search: async () => { searchCalls++; throw new Error('stub'); },
    });

    const dossier = await engine.researchCompany('Acme', {});
    assert.ok(searchCalls > 0, 'degraded cache must not be served once search is available');
    // All searches failed → falls back to LLM-only, still marked degraded.
    assert.equal(dossier.degraded, true);
});

testIfPremium('fresh cached degraded dossier + still NO provider → served from cache, no LLM call', async () => {
    const cached = { company: 'Acme', degraded: true };
    const db = makeFakeDb({ cachedDossier: cached, stale: false });
    const engine = new CompanyResearchEngine(db);
    let llmCalls = 0;
    engine.setGenerateContentFn(async () => { llmCalls++; return VALID_DOSSIER_JSON; });

    const dossier = await engine.researchCompany('Acme', {});
    assert.equal(dossier, cached, 'without a provider the degraded cache is still valid');
    assert.equal(llmCalls, 0, 'no regeneration while nothing has improved');
});

testIfPremium('fresh cached NON-degraded dossier is served even when a provider exists', async () => {
    const cached = { company: 'Acme', sources: ['https://x'] };
    const db = makeFakeDb({ cachedDossier: cached, stale: false });
    const engine = new CompanyResearchEngine(db);
    let searchCalls = 0;
    engine.setSearchProvider({ search: async () => { searchCalls++; return []; } });

    const dossier = await engine.researchCompany('Acme', {});
    assert.equal(dossier, cached);
    assert.equal(searchCalls, 0, 'search-backed cache honors its TTL');
});

testIfPremium('setSearchProvider accepts null (clears a stale provider)', () => {
    const engine = new CompanyResearchEngine(makeFakeDb());
    engine.setSearchProvider({ search: async () => [] });
    engine.setSearchProvider(null);
    assert.equal(engine.searchProvider, null);
});

// ---------- source-inspection wiring guards ----------

testIfPremium('KnowledgeOrchestrator resolves the search provider per AOT run, before runForJD', () => {
    const src = read('premium/electron/knowledge/KnowledgeOrchestrator.ts');
    assert.ok(src.includes('setSearchProviderResolver('), 'resolver setter must exist');
    const jdBranch = src.indexOf('this.aotPipeline.reset()');
    assert.ok(jdBranch >= 0, 'JD ingest branch should exist');
    const resolveAt = src.indexOf('this.companyResearch.setSearchProvider(this.searchProviderResolver())', jdBranch);
    const runAt = src.indexOf('this.aotPipeline.runForJD(', jdBranch);
    assert.ok(resolveAt >= 0, 'AOT path must wire the provider from the resolver');
    assert.ok(runAt > resolveAt, 'provider must be wired BEFORE runForJD fires');
});

test('main.ts no longer wires the removed premium orchestrator search-provider resolver', () => {
    // The premium knowledge subsystem (KnowledgeOrchestrator +
    // CompanyResearchEngine) was REMOVED, so main.ts no longer injects
    // setSearchProviderResolver into an orchestrator — the resolver itself is
    // now a stub (see resolveCompanySearchProvider.ts). This pins the stub
    // reality so the guard cannot silently regress back to a live wiring.
    const src = read('electron/main.ts');
    assert.doesNotMatch(src, /setSearchProviderResolver\(/, 'main.ts must not wire the removed premium resolver');
});

test('manual research-company handler uses the SAME shared resolver (no drift)', () => {
    const src = read('electron/ipcHandlers.ts');
    const handler = src.indexOf("safeHandle('profile:research-company'");
    assert.ok(handler >= 0);
    const nextHandler = src.indexOf('safeHandle(', handler + 1);
    const body = src.slice(handler, nextHandler);
    assert.ok(
        body.includes('engine.setSearchProvider(resolveCompanySearchProvider())'),
        'manual path must delegate to the shared resolver'
    );
    assert.ok(
        !body.includes('new TavilySearchProvider'),
        'no inline cascade left in the handler'
    );
});

test('shared resolver is now a stub returning null (premium providers removed)', () => {
    const src = read('electron/services/resolveCompanySearchProvider.ts');
    assert.match(src, /export function resolveCompanySearchProvider\(\): null/, 'resolver must be the premium-removed stub');
    assert.match(src, /return null;/, 'stub must return null (LLM-only dossiers)');
    // The function body must not reference the removed premium provider APIs
    // (the header comment may mention them in prose, so scope to the code).
    const fnBody = src.slice(src.indexOf('export function'));
    assert.doesNotMatch(fnBody, /getTavilyApiKey|getNativelyApiKey|TRIAL_SENTINEL_KEY/, 'the premium search providers must not be referenced in code');
});
