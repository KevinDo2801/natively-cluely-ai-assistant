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
 * The full DIRECT mode is additionally gated on NATIVELY_CALENDAR_DIRECT=1 in
 * CalendarManager — see the placeholder guards there.
 */

// Injected by esbuild `define` in scripts/build-electron.js. When a build was
// produced without Google config (no .env / no env vars), or the source is run
// unbundled (e.g. a test harness), these are undefined at runtime and the
// fallback returns undefined — mirroring the pre-bake behavior.
declare const __NATIVELY_GOOGLE_CLIENT_ID__: string | undefined;
declare const __NATIVELY_GOOGLE_CLIENT_SECRET__: string | undefined;

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
