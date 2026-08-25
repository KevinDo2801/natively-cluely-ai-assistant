// Semantic-retrieval repair (Phases 0.5-3) — LIVE end-to-end validation.
//
// Boots a REAL Electron main process (temp userData) and validates this
// session's changes against REAL APIs:
//   S1  DeepSeek provider sanity (deepseek-v4-flash, DIRECT api.deepseek.com —
//       never through natively-api/server.js, which writes billing rows).
//   S2  Doc-grounded custom mode through streamChat's INTERNAL retrieval —
//       the unified Phase 2 site-2 path (shouldUseHybridRetrieval +
//       runHybridModeRetrieval) — 10 critical seminar questions.
//   S3  Same mode through chatWithGemini — the Phase 2 site-1 path whose
//       doc-grounded hybrid branch fires for the first time.
//   (Former S4 semanticAdmissionGate and S5 jd_fit-coverage sections removed:
//   they required the premium knowledge module, which no longer exists.)
//
// Keys come from .env (DEEPSEEK_API_KEY required; GEMINI_API_KEY optional —
// it is passed to the provider). Key VALUES are never logged.
//
// Run:
//   npm run build:electron
//   ./node_modules/.bin/electron scripts/e2e-semantic-repair-deepseek.js

'use strict';

const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const { app } = require('electron');

const repoRoot = path.resolve(__dirname, '..');
const distRoot = path.join(repoRoot, 'dist-electron', 'electron');

// ── .env loading (values are secrets — never log them) ─────────────────────
for (const line of fs.readFileSync(path.join(repoRoot, '.env'), 'utf8').split('\n')) {
  const m = /^([A-Z0-9_]+)=(.*)$/.exec(line.trim());
  if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
}
const DEEPSEEK_KEY = process.env.DEEPSEEK_API_KEY || '';
const GEMINI_KEY = process.env.GEMINI_API_KEY || '';
if (!DEEPSEEK_KEY) { console.error('[e2e] FATAL: DEEPSEEK_API_KEY missing from .env'); process.exit(1); }
console.log(`[e2e] keys: deepseek=present gemini=${GEMINI_KEY ? 'present' : 'absent'}`);

const tmpUserData = fs.mkdtempSync(path.join(os.tmpdir(), 'natively-e2e-semrepair-'));
app.setPath('userData', tmpUserData);

const CUSTOM_PROMPT = [
  'Act as my real-time seminar presentation assistant.',
  'I have uploaded a seminar/thesis file.',
  'Answer from the uploaded seminar content first.',
  'Do not invent facts, numbers, methods, results, or claims.',
  'If something is not in the file, say it is not directly mentioned in my seminar material.',
  'Keep answers natural, confident, student-friendly, and speakable.',
].join(' ');

const FIXTURE_DIR = path.join(repoRoot, 'tests/fixtures/modes/custom/seminar-presentation');
const FIXTURE_FILES = [
  'seminar_vla_overview.txt', 'seminar_hardware_specs.txt', 'seminar_simulation_stack.md',
  'seminar_evaluation_results.csv', 'seminar_dataset_training.txt', 'seminar_custom_prompt_rules.txt',
];

const CRITICAL = [
  { q: 'What is OpenVLA-OFT?', must: [/openvla-oft/i] },
  { q: 'How many degrees of freedom does Mercury X1 have?', must: [/19/] },
  { q: 'What sensors does Mercury X1 use?', must: [/lidar/i] },
  { q: 'What is the role of ROS# in the project?', must: [/ros#/i] },
  { q: 'What is the role of Unity in the project?', must: [/unity/i] },
  { q: 'What are the four main phases of the project?', must: [/teleoperation/i, /data collection/i, /training/i, /agentic ai/i] },
  { q: 'How was OpenVLA-OFT finetuned?', must: [/lora|fine-?tun|adapter/i] },
  { q: 'What evaluation metrics were used?', must: [/success rate/i] },
  { q: 'What does MSE measure?', must: [/mse|mean squared|error|trajectory|deviation/i] },
  // Fail-closed probe (KNOWN-ABSENCE): the fixtures state GPU memory sizes but
  // never a model name — so the DECIDABLE property is "no GPU model invented".
  // Refusal PHRASING varies run to run and must not be asserted.
  { q: 'What exact GPU was used for training?', must: [], mustNot: [/\b(?:A100|H100|V100|P100|T4|L4|RTX\s?\d{3,4}|GTX\s?\d{3,4}|4090|3090|A6000)\b/i], failClosed: true },
];
const FORBIDDEN_DRIFT = ['TalentScope', 'Convex', 'Stream SDK', 'Clerk', 'Next.js', 'Tailwind', 'RBAC'];
const GREETING_RE = /what would you like help with|how can i help|what can i (?:help|do)/i;

const results = { sections: {}, failures: [] };
function record(section, name, ok, detail) {
  results.sections[section] = results.sections[section] || { pass: 0, fail: 0 };
  results.sections[section][ok ? 'pass' : 'fail']++;
  console.log(`[e2e][${section}] ${ok ? 'PASS' : 'FAIL'} — ${name}${detail ? ` — ${detail}` : ''}`);
  if (!ok) results.failures.push({ section, name, detail });
}

async function collectStream(gen) { let out = ''; for await (const tok of gen) out += tok; return out; }

function checkAnswer(section, q, answer, must, mustNot = []) {
  const trimmed = (answer || '').trim();
  const problems = [];
  if (GREETING_RE.test(trimmed)) problems.push('GREETING');
  if (trimmed.length < 8) problems.push('EMPTY/TINY');
  for (const d of FORBIDDEN_DRIFT) if (trimmed.toLowerCase().includes(d.toLowerCase())) problems.push(`DRIFT:${d}`);
  const miss = must.filter((re) => !re.test(trimmed));
  if (miss.length) problems.push(`MISSING:${miss.map(String).join(',')}`);
  const hit = mustNot.filter((re) => re.test(trimmed));
  if (hit.length) problems.push(`FORBIDDEN:${hit.map(String).join(',')}`);
  record(section, q, problems.length === 0, problems.join(';') || `${trimmed.length} chars`);
  console.log(`      A: ${trimmed.slice(0, 200).replace(/\n/g, ' / ')}${trimmed.length > 200 ? ' …' : ''}`);
  return problems.length === 0;
}

async function main() {
  await app.whenReady();

  const { ModesManager } = require(path.join(distRoot, 'services/ModesManager.js'));
  const llmMod = require(path.join(distRoot, 'LLMHelper.js'));
  const LLMHelper = llmMod.LLMHelper || llmMod.default;
  const { CHAT_MODE_PROMPT } = require(path.join(distRoot, 'llm/prompts.js'));

  // ── S1: DeepSeek sanity ───────────────────────────────────────────────────
  const llmHelper = new LLMHelper(GEMINI_KEY || undefined, false, undefined, undefined, undefined, undefined, undefined, DEEPSEEK_KEY);
  llmHelper.setModel('deepseek-v4-flash');
  {
    const controller = new AbortController();
    const t = setTimeout(() => controller.abort(), 30000);
    let a = '';
    try { a = await collectStream(llmHelper.streamChat('Reply with exactly: OK', undefined, undefined, undefined, false, false, [], controller.signal)); }
    catch (e) { console.error('[e2e][S1] stream error:', e && e.message); }
    clearTimeout(t);
    record('S1-deepseek-sanity', 'provider streams a reply', /ok/i.test(a), `"${a.trim().slice(0, 40)}"`);
  }

  // ── S2: doc-grounded via streamChat INTERNAL retrieval (Phase 2 site 2) ──
  const mm = ModesManager.getInstance();
  for (const m of mm.getModes()) { if (/seminar/i.test(m.name)) { try { mm.deleteMode(m.id); } catch (_) {} } }
  const mode = mm.createMode({ name: 'Seminar Presentation Assistant (E2E)', templateType: 'general' });
  // Mirror a REAL user-configured doc-grounded mode: the template seed stamps
  // origin 'default_new_mode', and strictDocumentGroundedFromContract requires
  // a NON-default origin (Defect C, 2026-08-01) — without this, streamChat's
  // forceDocumentGrounding (keyed on strictDocumentGroundedActive) stays false
  // and site 2 runs the weaker non-strict retrieval, which is what a stock
  // unconfigured mode gets. The live app sets this via the "Primary knowledge
  // source" UI → buildUserSelectedSourceContract (origin 'user_selected').
  const { buildUserSelectedSourceContract } = require(path.join(distRoot, 'services/modeSourceContract.js'));
  mm.updateMode(mode.id, {
    customContext: CUSTOM_PROMPT,
    sourceContract: buildUserSelectedSourceContract({ defaultOwner: 'reference_files' }),
  });
  for (const f of FIXTURE_FILES) {
    mm.addReferenceFile({ modeId: mode.id, fileName: f, content: fs.readFileSync(path.join(FIXTURE_DIR, f), 'utf8') });
  }
  mm.setActiveMode(mode.id);
  const grounding = mm.getActiveModeDocumentGroundingInfo();
  record('S2-doc-grounded', 'documentGroundedCustomModeActive', grounding.documentGroundedCustomModeActive === true);

  const latencies = [];
  for (const c of CRITICAL) {
    const controller = new AbortController();
    const t = setTimeout(() => controller.abort(), 45000);
    const start = Date.now();
    let answer = '';
    try {
      // context=undefined → streamChat assembles the mode block itself,
      // exercising the unified shouldUseHybridRetrieval/runHybridModeRetrieval.
      // routeOptions mirrors the REAL gemini-chat-stream caller (answerType
      // lecture_answer) — without it, doc-grounded routing/strictness differs
      // from production and the model is told nothing about the doc turn.
      answer = await collectStream(llmHelper.streamChat(c.q, undefined, undefined, CHAT_MODE_PROMPT, false, false, [], controller.signal, undefined, { answerType: 'lecture_answer' }));
    } catch (e) { console.error(`[e2e][S2] stream error for "${c.q}":`, e && e.message); }
    clearTimeout(t);
    latencies.push(Date.now() - start);
    checkAnswer('S2-doc-grounded', c.q, answer, c.must, c.mustNot || []);
  }
  latencies.sort((a, b) => a - b);
  console.log(`[e2e][S2] latency median=${latencies[Math.floor(latencies.length / 2)]}ms max=${latencies[latencies.length - 1]}ms`);

  // ── S3: same mode via chatWithGemini (Phase 2 site 1) ────────────────────
  for (const c of [CRITICAL[1], CRITICAL[3]]) {
    let answer = '';
    try { answer = await llmHelper.chatWithGemini(c.q, undefined, undefined, false); }
    catch (e) { console.error(`[e2e][S3] error for "${c.q}":`, e && e.message); }
    checkAnswer('S3-site1-chat', c.q, answer, c.must);
  }

  // ── Summary ──────────────────────────────────────────────────────────────
  console.log('\n[e2e] ===== SUMMARY =====');
  let totalFail = 0;
  for (const [sec, { pass, fail }] of Object.entries(results.sections)) {
    console.log(`[e2e] ${sec}: ${pass}/${pass + fail}`);
    totalFail += fail;
  }
  if (results.failures.length) {
    console.log('[e2e] failures:');
    for (const f of results.failures) console.log(`  - [${f.section}] ${f.name} ${f.detail || ''}`);
  }
  try { fs.rmSync(tmpUserData, { recursive: true, force: true }); } catch (_) {}
  process.exit(totalFail === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error('[e2e] FATAL:', err);
  try { fs.rmSync(tmpUserData, { recursive: true, force: true }); } catch (_) {}
  process.exit(2);
});
