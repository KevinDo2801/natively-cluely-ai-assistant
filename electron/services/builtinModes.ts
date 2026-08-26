// electron/services/builtinModes.ts
//
// The "default mode" concept, which did not exist until 2026-08-09.
//
// Every row in `modes` was a user-created `mode_<uuid>` with a freely editable
// `template_type` — including the ones NAMED "General", "Team Meet" and
// "Technical Interview". Nothing distinguished an app default from something
// the user built, and `updateMode` would persist any template onto any row.
//
// That is the deeper cause of the reported defect: a mode named "Technical
// Interview" ran as `general`, and because `general` is the only built-in with
// `profileSources: []`, the user's résumé was never loaded into scope. The
// answer ("I don't have your CGPA") was correct for the state the turn was in,
// and the state was wrong for reasons nothing surfaced.
//
// A built-in mode's TEMPLATE IS FIXED. Its name, custom context, reference
// files and Answer policy all stay editable — locking the template is what
// prevents the identity confusion, and locking anything more would take away
// choices users have already made.
//
// BUILT-IN SCOPE (2026-08-XX, Modes Manager redesign): ONLY the General
// default is a built-in mode. Every other template is opt-in — a user picks it
// from the "Natively Templates" gallery, which creates a CUSTOM (never
// built-in) mode. Consequences, enforced here:
//   - non-general rows are NEVER adopted (their template stays editable), and
//     never auto-seeded;
//   - adoption below only ever touches a row named exactly "General" on the
//     'general' template — the identity-confusion bug is still prevented for
//     the one mode that is a true app default;
//   - stale built-in rows for non-General templates (auto-seeded by
//     pre-redesign versions) are removed by ModesManager.ensureBuiltinModes.
//
// This module is deliberately free of database and Electron imports so the
// adoption rule — which RECLASSIFIES USER DATA — can be read and tested on its
// own.

/** The canonical name each built-in template ships with. */
export const BUILTIN_MODE_LABELS = {
  'general': 'General',
  'sales': 'Sales',
  'recruiting': 'Recruiting',
  'team-meet': 'Team Meet',
  'looking-for-work': 'Looking for work',
  'technical-interview': 'Technical Interview',
  'lecture': 'Lecture',
  'seminar': 'Seminar',
  'call-center': 'Call Center',
} as const;

export type BuiltinModeTemplate = keyof typeof BUILTIN_MODE_LABELS;

/** Stable id for a seeded built-in, so re-running the migration cannot duplicate. */
export const builtinModeId = (t: BuiltinModeTemplate): string => `mode_builtin_${t}`;

export interface AdoptionCandidate {
  id: string;
  name: string;
  templateType: string;
  createdAt: string;
  isBuiltin?: boolean;
}

export interface AdoptionPlan {
  /** Existing rows to mark built-in (only ever the General default now). */
  adopt: string[];
  /** Templates with no existing row to adopt — seed a fresh one (General only). */
  seed: BuiltinModeTemplate[];
  /**
   * Templates where MORE THAN ONE row qualified and the oldest was taken.
   *
   * Reported because it is the one case adoption can get wrong: if the older
   * qualifier is a CUSTOM mode the user renamed to exactly the canonical label,
   * that row gets its template locked instead of the intended one.
   *
   * There is no provenance column to break the tie properly, and the obvious
   * heuristic does not work — on real data every row carries an empty
   * custom_context, so "prefer the pristine one" discriminates nothing. Rather
   * than invent a signal, the ambiguity is surfaced so a wrong pick is
   * diagnosable from the logs instead of silent.
   *
   * The blast radius is small by construction: an adopted row always has a
   * correct name↔template pairing, so the only loss is that that row can no
   * longer be re-templated — and updateMode's rejection message already points
   * at the remedy (duplicate it as a custom mode).
   */
  ambiguous: Array<{ templateType: BuiltinModeTemplate; chosen: string; skipped: string[] }>;
}

/**
 * Decide which existing modes become built-ins, and which templates need one.
 *
 * ONLY 'general' participates (see the module header). ADOPT requires the
 * row's name to be EXACTLY "General" on the 'general' template — the app's one
 * true default. Two clauses, both load-bearing:
 *
 *   - name match alone is not enough. A row named "Technical Interview" that is
 *     running as `general` is the reported bug; adopting it would freeze the
 *     wrong template permanently.
 *   - template match alone is not enough either. A `general` mode the user
 *     named "Lecture" is their own construction, and locking it would remove a
 *     choice they made.
 *
 * ONE per template (i.e. for 'general'), the OLDEST, because duplicates exist
 * in real tables and two immutable modes with the same name are
 * indistinguishable in the UI.
 *
 * Idempotent: rows already marked built-in are skipped rather than re-adopted,
 * and they still satisfy the template so it is not seeded again.
 */
export function planBuiltinAdoption(rows: readonly AdoptionCandidate[]): AdoptionPlan {
  const adopt: string[] = [];
  const covered = new Set<string>();
  const ambiguous: AdoptionPlan['ambiguous'] = [];

  const ordered = [...rows].sort((a, b) => String(a.createdAt).localeCompare(String(b.createdAt)));

  // Already-migrated built-in rows cover their template without being re-adopted.
  for (const r of ordered) {
    if (r.isBuiltin && r.templateType === 'general') covered.add('general');
  }

  // Group the QUALIFIERS per template first, so a tie is visible rather than
  // being consumed silently by first-wins iteration. Non-general rows never
  // qualify: templates are opt-in via the gallery, which creates custom modes.
  const qualifiers = new Map<BuiltinModeTemplate, string[]>();
  for (const r of ordered) {
    if (r.isBuiltin) continue;
    if (r.templateType !== 'general' || covered.has('general')) continue;
    if (String(r.name).trim() !== BUILTIN_MODE_LABELS.general) continue;
    const list = qualifiers.get('general') ?? [];
    list.push(r.id);
    qualifiers.set('general', list);
  }

  for (const [t, ids] of qualifiers) {
    const [chosen, ...skipped] = ids;   // `ordered` is oldest-first
    adopt.push(chosen);
    covered.add(t);
    if (skipped.length) ambiguous.push({ templateType: t, chosen, skipped });
  }

  const seed = covered.has('general') ? [] : (['general'] as BuiltinModeTemplate[]);

  return { adopt, seed, ambiguous };
}
