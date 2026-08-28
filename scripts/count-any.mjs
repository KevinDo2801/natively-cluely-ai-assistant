#!/usr/bin/env node
/**
 * count-any.mjs — tracks `any`-type usage per file as a ratchet.
 *
 * Baseline (2026 refactor audit): ~1,936 occurrences across electron/ + src/.
 * Mass-removal is not viable; the ratchet makes the count only ever go DOWN.
 *
 * Usage:
 *   node scripts/count-any.mjs            # regenerate reports/any-baseline.json
 *   node scripts/count-any.mjs --check    # fail (exit 1) if any file's count
 *                                         # increased vs the committed baseline
 *
 * CI runs --check. Regenerating the baseline is a deliberate act (commit the
 * updated reports/any-baseline.json with the PR that reduced the counts).
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SCAN_DIRS = ['electron', 'src'];
const BASELINE_PATH = path.join(root, 'reports', 'any-baseline.json');
// Matches explicit any-annotations, not the English word:
//   `: any`, `: any[]`, `as any`, `<any>`, `Array<any>`, `Record<string, any>`
const ANY_PATTERN = /(:\s*any\b|\bas\s+any\b|<\s*any\s*[>,])/g;
const SKIP = new Set(['node_modules', 'dist', 'dist-electron', '.git']);

function* walk(dir) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (SKIP.has(entry.name)) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) yield* walk(full);
    else if (/\.(ts|tsx)$/.test(entry.name) && !entry.name.endsWith('.d.ts')) yield full;
  }
}

function countFile(file) {
  const text = fs.readFileSync(file, 'utf8');
  // Strip line comments and block comments so prose mentioning `any` (or
  // commented-out code) doesn't count. Crude but deterministic: string
  // literals containing `: any` are rare enough to accept as noise.
  const stripped = text
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/.*$/gm, '$1');
  const matches = stripped.match(ANY_PATTERN);
  return matches ? matches.length : 0;
}

function collect() {
  const counts = {};
  for (const dir of SCAN_DIRS) {
    const abs = path.join(root, dir);
    if (!fs.existsSync(abs)) continue;
    for (const file of walk(abs)) {
      const rel = path.relative(root, file).replace(/\\/g, '/');
      // Tests are excluded: __tests__ fixtures legitimately fake shapes.
      if (rel.includes('__tests__')) continue;
      const n = countFile(file);
      if (n > 0) counts[rel] = n;
    }
  }
  return counts;
}

function total(counts) {
  return Object.values(counts).reduce((a, b) => a + b, 0);
}

const counts = collect();
const check = process.argv.includes('--check');

if (!check) {
  fs.mkdirSync(path.dirname(BASELINE_PATH), { recursive: true });
  const payload = {
    generatedAt: new Date().toISOString(),
    note: 'Ratchet baseline — regenerate only when counts went DOWN. See scripts/count-any.mjs.',
    total: total(counts),
    files: counts,
  };
  fs.writeFileSync(BASELINE_PATH, JSON.stringify(payload, null, 2) + '\n');
  console.log(`[count-any] baseline written: ${total(counts)} any-usages across ${Object.keys(counts).length} files`);
  console.log(`[count-any] → ${path.relative(root, BASELINE_PATH)}`);
} else {
  if (!fs.existsSync(BASELINE_PATH)) {
    console.error('[count-any] no baseline found — run `node scripts/count-any.mjs` first');
    process.exit(1);
  }
  const baseline = JSON.parse(fs.readFileSync(BASELINE_PATH, 'utf8'));
  const oldFiles = baseline.files ?? {};
  let failures = 0;
  for (const [file, n] of Object.entries(counts)) {
    const before = oldFiles[file] ?? 0;
    if (n > before) {
      console.error(`[count-any] FAIL ${file}: ${before} → ${n} (+${n - before})`);
      failures++;
    }
  }
  const delta = total(counts) - (baseline.total ?? 0);
  if (failures > 0) {
    console.error(`[count-any] ${failures} file(s) increased their any-count (total delta ${delta >= 0 ? '+' : ''}${delta}). New code must not add \`any\` — type it or use \`unknown\`.`);
    process.exit(1);
  }
  console.log(`[count-any] OK — no file increased (total ${total(counts)}, delta ${delta <= 0 ? '' : '+'}${delta} vs baseline)`);
}
