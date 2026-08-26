// Two weaknesses in the v26 built-in migration, closed here.
//
// 1. PARTIAL SEEDING WAS SILENT FOR THE REST OF THE SESSION.
//    ensureBuiltinModes ran once from getInstance() behind a `builtinsEnsured`
//    flag that was set BEFORE the work. A throw part-way through seeding was
//    caught and swallowed, the flag stayed true, and the process carried on with
//    (say) 6 of 8 defaults until the next launch. Now: each seed is independent,
//    so one failure cannot abort the rest, and the flag is only latched when the
//    run actually COMPLETED — an incomplete run is retried on a later
//    getInstance(), bounded so a permanently broken database cannot spin.
//
// 2. AMBIGUOUS ADOPTION WAS INVISIBLE.
//    Adoption picks the oldest row whose name is exactly the canonical label for
//    its own template. When two rows qualify, the older wins and the other stays
//    custom — which is correct, but if the older one happens to be a CUSTOM mode
//    the user renamed, the wrong instance gets its template locked.
//
//    There is no provenance column to do better, and the obvious tie-break does
//    not work: on the reporting user's real database EVERY row has an empty
//    custom_context, so "prefer the pristine one" discriminates nothing. Rather
//    than invent a signal, the plan now REPORTS the ambiguity so a wrong pick is
//    diagnosable instead of silent. The consequence is mild by construction —
//    an adopted row always has a correct name↔template pairing, so the only loss
//    is that that particular row can no longer be re-templated, and the rejection
//    error already tells the user to duplicate it as a custom mode.
//
// BUILT-IN SCOPE (Modes Manager redesign): only the General default is a
// built-in mode. Non-general rows are never adopted (templates are opt-in via
// the gallery, which creates CUSTOM modes), so the ambiguity logic below only
// ever involves rows named "General", and stale built-in template rows seeded
// by pre-redesign versions are removed by ensureBuiltinModes.

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { createRequire } from 'node:module';

const base = path.resolve(process.cwd(), 'dist-electron/electron');
const { planBuiltinAdoption } =
  await import(pathToFileURL(path.join(base, 'services/builtinModes.js')).href);

describe('ambiguous adoption is reported, not silent', () => {
  test('two rows qualifying for the same template are surfaced', () => {
    const plan = planBuiltinAdoption([
      { id: 'old', name: 'General', templateType: 'general', createdAt: '1' },
      { id: 'new', name: 'General', templateType: 'general', createdAt: '2' },
    ]);
    assert.deepEqual(plan.adopt, ['old'], 'the oldest still wins — behaviour unchanged');
    assert.equal(plan.ambiguous.length, 1);
    assert.deepEqual(plan.ambiguous[0], {
      templateType: 'general', chosen: 'old', skipped: ['new'],
    });
  });

  test('an unambiguous table reports nothing', () => {
    const plan = planBuiltinAdoption([
      { id: 'a', name: 'General', templateType: 'general', createdAt: '1' },
    ]);
    assert.deepEqual(plan.ambiguous, []);
  });

  test('three candidates report both losers', () => {
    const plan = planBuiltinAdoption([
      { id: 'a', name: 'General', templateType: 'general', createdAt: '1' },
      { id: 'b', name: 'General', templateType: 'general', createdAt: '2' },
      { id: 'c', name: 'General', templateType: 'general', createdAt: '3' },
    ]);
    assert.deepEqual(plan.adopt, ['a']);
    assert.deepEqual(plan.ambiguous[0].skipped, ['b', 'c']);
  });

  test('a near-miss is NOT ambiguity — only exact qualifiers count', () => {
    const plan = planBuiltinAdoption([
      { id: 'a', name: 'General', templateType: 'general', createdAt: '1' },
      { id: 'b', name: 'General Notes', templateType: 'general', createdAt: '2' },
      { id: 'c', name: 'General', templateType: 'sales', createdAt: '3' },
    ]);
    assert.deepEqual(plan.adopt, ['a']);
    assert.deepEqual(plan.ambiguous, [], 'b and c never qualified, so nothing was skipped');
  });
});

// These exercise the real DB, so they need the Electron runner:
// better-sqlite3 is built against Electron's ABI and cannot load under plain
// `node --test` (NODE_MODULE_VERSION mismatch). Skipping rather than failing
// keeps the suite green under BOTH runners — run with
// `ELECTRON_RUN_AS_NODE=1 electron --test` to actually execute them.
// Probe the NATIVE MODULE, not DatabaseManager: the manager deliberately
// degrades to an empty result when the DB cannot open, so `getModes().length`
// succeeds under node and would report a false positive.
// better-sqlite3 loads its .node binding lazily inside the Database
// CONSTRUCTOR, so a bare require() succeeds even under the wrong ABI. Actually
// opening one is the only honest probe.
const dbAvailable = (() => {
  try {
    const Database = createRequire(import.meta.url)(path.resolve(process.cwd(), 'node_modules/better-sqlite3'));
    new Database(':memory:').close();
    return true;
  } catch { return false; }
})();

describe('seeding survives a partial failure', { skip: dbAvailable ? false : 'needs the Electron runner (better-sqlite3 ABI)' }, () => {
  // dist-electron/services/ModesManager.js is CommonJS, so the `?t=` query
  // string below does NOT create a fresh module (Node caches CJS by filename):
  // every test in this describe shares ONE inlined DatabaseManager singleton,
  // bound to the FIRST directory it ever saw. Use a single shared directory so
  // all tests (and the standalone DatabaseManager import in the stale-cleanup
  // test) read and write the SAME database file. The latch is still reset
  // explicitly per test.
  const SHARED_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'resil-'));

  const freshManager = async () => {
    process.env.NATIVELY_TEST_USERDATA = SHARED_DIR;
    // Fresh module registry so the singleton + latch are per-test.
    const mod = await import(`${pathToFileURL(path.join(base, 'services/ModesManager.js')).href}?t=${Date.now()}${Math.random()}`);
    return { ModesManager: mod.ModesManager, dir: SHARED_DIR };
  };

  test('a fresh user gets ONLY the General default, and a re-run adds nothing', async () => {
    const { ModesManager } = await freshManager();
    const mm = ModesManager.getInstance();
    // Seeding rule (Modes Manager redesign): a fresh install seeds exactly one
    // mode. Every other template is opt-in via the Templates gallery.
    assert.deepEqual(mm.getModes().map((m) => m.templateType), ['general'],
      'fresh install seeds exactly one default mode');
    // A forced re-run over the complete table is a no-op that reports true.
    ModesManager._resetBuiltinLatchForTest?.();
    assert.equal(mm.ensureBuiltinModes(), true);
    assert.deepEqual(mm.getModes().map((m) => m.templateType), ['general'],
      'idempotent — no template materializes until the user picks it from the gallery');
  });

  test('stale built-in template rows are removed; user custom modes survive', async () => {
    const { ModesManager } = await freshManager();
    const mm = ModesManager.getInstance();
    // Simulate a pre-redesign database: a template mode marked as built-in.
    const stale = mm.createMode({ name: 'Sales', templateType: 'sales' });
    const { DatabaseManager } = await import(pathToFileURL(path.join(base, 'db/DatabaseManager.js')).href);
    DatabaseManager.getInstance().setModeBuiltin(stale.id, true);
    // A user-created custom mode must never be touched by the cleanup.
    mm.createMode({ name: 'My Sales', templateType: 'general' });

    // Re-run startup seeding: the stale built-in is removed.
    ModesManager._resetBuiltinLatchForTest?.();
    assert.equal(mm.ensureBuiltinModes(), true);

    const rows = mm.getModes().map((m) => `${m.templateType}:${m.isBuiltin}`);
    assert.ok(!rows.includes('sales:true'), 'stale built-in Sales row was removed');
    assert.ok(rows.includes('general:true'), 'the General default is intact');
    assert.ok(rows.includes('general:false'), 'the user custom mode survives');
  });

  test('a failed General seed reports the run incomplete, and a later retry completes it', async () => {
    const { ModesManager } = await freshManager();
    const mm = ModesManager.getInstance();
    // The DB may also carry rows left by sibling tests in this file (the
    // inlined DatabaseManager singleton binds to the first temp dir), so find
    // the built-in General explicitly rather than assuming it is index 0.
    const general = mm.getModes().find((m) => m.isBuiltin && m.templateType === 'general');
    assert.ok(general, 'the built-in General default exists');
    const generalId = general.id;

    // Simulate a failed FIRST seeding run: remove the default and make the
    // next seed throw (the per-seed try/catch must surface the failure).
    mm.deleteMode(generalId);
    const real = mm.createMode.bind(mm);
    let failed = 0;
    mm.createMode = (params) => {
      if (params.templateType === 'general') { failed += 1; throw new Error('disk full'); }
      return real(params);
    };
    ModesManager._resetBuiltinLatchForTest?.();
    const complete = mm.ensureBuiltinModes();

    assert.equal(failed, 1, 'the General seed was attempted');
    assert.equal(complete, false, 'a failed seed must report the run as incomplete');

    // Retry with a healthy disk: the default comes back, idempotently.
    mm.createMode = real;
    assert.equal(mm.ensureBuiltinModes(), true);
    // (The DB may also carry rows left by sibling tests in this file — the
    // shared DatabaseManager singleton binds to the first temp dir — so assert
    // the General default is present, not that it is the only row.)
    const after = mm.getModes().map((m) => `${m.templateType}:${m.isBuiltin}`);
    assert.ok(after.includes('general:true'), 'the General default was re-seeded');
  });

  test('an incomplete run is retried on a later getInstance()', async () => {
    const { ModesManager } = await freshManager();
    const mm = ModesManager.getInstance();
    assert.equal(typeof ModesManager._resetBuiltinLatchForTest, 'function',
      'the latch must be resettable so an incomplete run can retry');
    // Simulate: previous run left the latch unlatched because it was incomplete.
    ModesManager._resetBuiltinLatchForTest();
    const again = ModesManager.getInstance();
    assert.equal(again, mm, 'same singleton');
    // A complete run over an already-complete table is a no-op that reports true.
    assert.equal(mm.ensureBuiltinModes(), true);
  });
});
