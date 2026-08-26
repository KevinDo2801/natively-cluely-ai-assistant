// "Default modes" did not exist. Every row in the modes table was a
// user-created `mode_<uuid>` with a freely editable template — including the
// ones NAMED "General", "Team Meet" and "Technical Interview". That is the
// deeper reason a mode could be named one thing and behave as another
// (reported 2026-08-09: "Technical Interview" running as `general`, so the
// user's résumé was never in scope).
//
// planBuiltinAdoption is the pure decision behind the migration that
// introduces the concept. It is a separate function precisely because it
// RECLASSIFIES USER DATA, and a rule that touches user data should be readable
// and testable without a database.
//
// BUILT-IN SCOPE (Modes Manager redesign): ONLY the General default is a
// built-in mode. Every other template is opt-in — the user picks it from the
// "Natively Templates" gallery, which creates a CUSTOM (never built-in) mode.
//
// The rule, and why each clause exists:
//
//   ADOPT a row as the General built-in only when its name is EXACTLY
//   "General" on the 'general' template. "Lecture"/general is NOT — the user
//   built it from the blank template and named it themselves; locking its
//   template would take away a choice they made. Non-general rows are never
//   adopted (templates are opt-in; their template stays user-editable).
//
//   ONE per template (i.e. for 'general'), the OLDEST. Duplicates exist in the
//   wild; adopting both would leave two immutable modes with the same name and
//   no way to tell them apart.
//
//   SEED only the General default, and only when nothing covered it — so a
//   fresh user gets exactly one mode, and nobody gets a second "General".
//
// The migration deliberately does NOT hide the Answer policy control on
// built-ins. Locking the template fixes the reported bug; hiding the control
// would additionally strand any choice already stored against a built-in mode
// with no UI left to undo it.

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const base = path.resolve(process.cwd(), 'dist-electron/electron');
const { planBuiltinAdoption } =
  await import(pathToFileURL(path.join(base, 'services/builtinModes.js')).href);

// The reporting user's actual table, in creation order.
const REAL_ROWS = [
  { id: 'm1', name: 'General', templateType: 'general', createdAt: '1' },
  { id: 'm2', name: 'Looking for work', templateType: 'looking-for-work', createdAt: '2' },
  { id: 'm3', name: 'Technical Interview', templateType: 'technical-interview', createdAt: '3' },
  { id: 'm4', name: 'Looking for work', templateType: 'looking-for-work', createdAt: '4' },
  { id: 'm5', name: 'Team Meet', templateType: 'team-meet', createdAt: '5' },
  { id: 'm6', name: 'Lecture', templateType: 'general', createdAt: '6' },
  { id: 'm7', name: 'Untitled Mode', templateType: 'general', createdAt: '7' },
];

describe('planBuiltinAdoption on the reported real-world table', () => {
  const plan = planBuiltinAdoption(REAL_ROWS);

  test('adopts exactly the General default', () => {
    assert.deepEqual(plan.adopt, ['m1']);
  });

  test('non-general rows are NEVER adopted — templates are opt-in', () => {
    // m2/m3/m5 are correctly-named template rows, but the redesign makes every
    // non-general template opt-in via the gallery (custom modes), so their
    // template stays user-editable instead of being locked.
    for (const id of ['m2', 'm3', 'm5']) {
      assert.ok(!plan.adopt.includes(id), `${id} must stay custom`);
    }
  });

  test('a user-named mode on the blank template stays CUSTOM', () => {
    // "Lecture" is templateType general — the user's own construction. Locking
    // it would silently remove a choice they made, and it is not what they
    // asked for.
    assert.ok(!plan.adopt.includes('m6'), 'Lecture/general must stay custom');
    assert.ok(!plan.adopt.includes('m7'), 'Untitled Mode must stay custom');
  });

  test('seeds nothing — the General default is already covered', () => {
    assert.deepEqual(plan.seed, []);
  });

  test('adopted + seeded covers every adopted template exactly once, with no duplicates', () => {
    const covered = [...plan.adopt.map((id) => REAL_ROWS.find((r) => r.id === id).templateType), ...plan.seed];
    assert.deepEqual(new Set(covered).size, covered.length, 'no template covered twice');
  });
});

describe('general properties', () => {
  test('an empty table seeds ONLY general and adopts nothing', () => {
    const plan = planBuiltinAdoption([]);
    assert.deepEqual(plan.adopt, []);
    assert.deepEqual(plan.seed, ['general'], 'a fresh user gets exactly one default mode');
  });

  test('a name that matches a DIFFERENT template is not adopted', () => {
    // The exact reported shape: named "Technical Interview", running as general.
    // Adopting it would freeze the wrong template permanently.
    const plan = planBuiltinAdoption([
      { id: 'x', name: 'Technical Interview', templateType: 'general', createdAt: '1' },
    ]);
    assert.deepEqual(plan.adopt, [], 'a mislabelled mode must not be frozen as-is');
    // general is uncovered (the row above does not qualify), so it seeds —
    // the user still gets their General default.
    assert.deepEqual(plan.seed, ['general']);
  });

  test('is idempotent — re-running over an already-migrated table adopts nothing new', () => {
    const rows = REAL_ROWS.map((r) => ({ ...r, isBuiltin: r.id === 'm1' }));
    const plan = planBuiltinAdoption(rows);
    assert.deepEqual(plan.adopt, [], 'already-built-in rows are not re-adopted');
    assert.deepEqual(plan.seed, [], 'general is covered by m1, so nothing seeds');
  });

  test('a duplicate General adopts only the OLDEST, and the loser is surfaced', () => {
    const plan = planBuiltinAdoption([
      { id: 'old', name: 'General', templateType: 'general', createdAt: '1' },
      { id: 'new', name: 'General', templateType: 'general', createdAt: '2' },
    ]);
    assert.deepEqual(plan.adopt, ['old'], 'the oldest General wins');
    assert.equal(plan.ambiguous.length, 1);
    assert.deepEqual(plan.ambiguous[0], {
      templateType: 'general', chosen: 'old', skipped: ['new'],
    });
  });

  test('whitespace and case in a name do not silently qualify', () => {
    const plan = planBuiltinAdoption([
      { id: 'a', name: 'general', templateType: 'general', createdAt: '1' },
      { id: 'b', name: '  General  ', templateType: 'general', createdAt: '2' },
    ]);
    // Trimmed exact match only: a renamed mode should not be swept up by a
    // fuzzy comparison, but surrounding whitespace is not a rename.
    assert.deepEqual(plan.adopt, ['b']);
  });
});
