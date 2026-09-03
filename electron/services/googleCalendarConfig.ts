/**
 * Google Calendar OAuth config for the desktop app.
 *
 * Resolution order (first match wins):
 *   1. `process.env` at runtime — in dev this is populated by main.ts's dotenv
 *      load (`.env`), and lets an operator override via the shell environment.
 *      Runtime wins so a dev edit to `.env` takes effect on the next app
 *      restart WITHOUT a rebuild.
 *   2. Values baked into the bundle at build time by scripts/build-electron.js
 *      (`__NATIVELY_GOOGLE_CLIENT_ID__` / `__NATIVELY_GOOGLE_CLIENT_SECRET__`).
 *      This is the path that lets a PACKAGED build link Google Calendar
 *      directly (DIRECT mode) with no `.env` on the install machine.
 *
 * ⚠️ SECURITY: the client secret should only ever be baked for a PRIVATE,
 * single-operator build. In a distributed/public build, baking it embeds the
 * secret in the binary where anyone can extract it. Keep the proxied token
 * exchange (secret held server-side) as the default for anything distributed;
 * only enable DIRECT mode when you know who will run the binary.
 *
 * The full DIRECT mode is additionally gated on the direct flag resolved by
 * `getCalendarDirectFlag()` (runtime env, then build-time bake) in
 * CalendarManager — see the placeholder guards there.
 */

// Injected by esbuild `define` in scripts/build-electron.js. When a build was
// produced without Google config (no .env / no env vars), or the source is run
// unbundled (e.g. a test harness), these are undefined at runtime and the
// fallback returns undefined — mirroring the pre-bake behavior.
declare const __NATIVELY_GOOGLE_CLIENT_ID__: string | undefined;
declare const __NATIVELY_GOOGLE_CLIENT_SECRET__: string | undefined;
// Baked at build time by scripts/build-electron.js from NATIVELY_CALENDAR_DIRECT
// (see the DIRECT-MODE BAKE comment there). Resolves whether the app is allowed
// to exchange Google tokens DIRECTLY (secret held in this process) instead of
// via the api.natively.software proxy. Packaged builds have no process.env, so
// this baked boolean is what lets a private/self-hosted .exe use DIRECT mode.
declare const __NATIVELY_CALENDAR_DIRECT__: boolean | undefined;

export function getGoogleClientId(): string | undefined {
  if (process.env.GOOGLE_CLIENT_ID) return process.env.GOOGLE_CLIENT_ID;
  return typeof __NATIVELY_GOOGLE_CLIENT_ID__ === 'string' && __NATIVELY_GOOGLE_CLIENT_ID__
    ? __NATIVELY_GOOGLE_CLIENT_ID__
    : undefined;
}

export function getGoogleClientSecret(): string | undefined {
  if (process.env.GOOGLE_CLIENT_SECRET) return process.env.GOOGLE_CLIENT_SECRET;
  return typeof __NATIVELY_GOOGLE_CLIENT_SECRET__ === 'string' && __NATIVELY_GOOGLE_CLIENT_SECRET__
    ? __NATIVELY_GOOGLE_CLIENT_SECRET__
    : undefined;
}

/**
 * Whether DIRECT (in-process) Google token exchange is enabled. Runtime env
 * wins (dev: main.ts loads `.env`); otherwise falls back to the value baked by
 * scripts/build-electron.js so a packaged build that opted in can link a
 * Google Calendar without a Natively account and without `.env` on the install
 * machine. The secret guard lives in CalendarManager.
 */
export function getCalendarDirectFlag(): boolean {
  if (process.env.NATIVELY_CALENDAR_DIRECT === '1') return true;
  return typeof __NATIVELY_CALENDAR_DIRECT__ === 'boolean' && __NATIVELY_CALENDAR_DIRECT__ === true;
}
