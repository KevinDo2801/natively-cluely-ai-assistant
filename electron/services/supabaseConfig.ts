/**
 * Supabase connection config for the desktop app.
 *
 * Resolution order (first match wins):
 *   1. `process.env` at runtime — in dev this is populated by main.ts's dotenv
 *      load (`.env`), and it lets an operator override via the shell
 *      environment. Runtime wins so a dev edit to `.env` takes effect on the
 *      next app restart WITHOUT a rebuild.
 *   2. Values baked into the bundle at build time by scripts/build-electron.js
 *      (`__NATIVELY_SUPABASE_URL__` / `__NATIVELY_SUPABASE_ANON_KEY__`). This
 *      is the path that makes cloud sync work in PACKAGED builds, where there
 *      is no `.env` (main.ts only loads it in dev) and no shell env to
 *      inherit.
 *
 * Why baking the anon key is safe: SUPABASE_URL is just the project endpoint
 * and SUPABASE_ANON_KEY is the publishable key — the app never ships the
 * service_role key (it bypasses RLS). Data access is gated by the signed-in
 * user's JWT + RLS (see supabase/migrations/0001_initial_schema.sql).
 */

// Injected by esbuild `define` in scripts/build-electron.js. When a build was
// produced without supabase config (no .env / no env vars), or the source is
// run unbundled (e.g. a test harness via tsx/strip-types), these are undefined
// at runtime and the fallback returns undefined — preserving the pre-bake
// "Supabase is not configured" behavior instead of throwing.
declare const __NATIVELY_SUPABASE_URL__: string | undefined;
declare const __NATIVELY_SUPABASE_ANON_KEY__: string | undefined;

export function getSupabaseUrl(): string | undefined {
  if (process.env.SUPABASE_URL) return process.env.SUPABASE_URL;
  return typeof __NATIVELY_SUPABASE_URL__ === 'string' && __NATIVELY_SUPABASE_URL__
    ? __NATIVELY_SUPABASE_URL__
    : undefined;
}

export function getSupabaseAnonKey(): string | undefined {
  if (process.env.SUPABASE_ANON_KEY) return process.env.SUPABASE_ANON_KEY;
  return typeof __NATIVELY_SUPABASE_ANON_KEY__ === 'string' && __NATIVELY_SUPABASE_ANON_KEY__
    ? __NATIVELY_SUPABASE_ANON_KEY__
    : undefined;
}
