#!/usr/bin/env node
/**
 * Local Google Calendar OAuth proxy for Natively (DEV ONLY).
 *
 * Why this exists:
 *   The desktop app intentionally never holds GOOGLE_CLIENT_SECRET — token
 *   exchange is normally proxied through api.natively.software, and that
 *   backend gates /api/calendar/* behind a Natively account (x-natively-key /
 *   x-trial-token → 401 auth_required otherwise). This local proxy implements
 *   the same two routes the app calls — POST /api/calendar/exchange and
 *   POST /api/calendar/refresh — and talks to Google DIRECTLY with the OAuth
 *   client the user created, so calendar linking works with zero Natively
 *   account. Point the app at it by setting in the root .env:
 *
 *     NATIVELY_CALENDAR_API_URL=http://localhost:3000
 *
 *   (CalendarManager reads NATIVELY_CALENDAR_API_URL, falling back to
 *   NATIVELY_API_URL. NATIVELY_API_URL itself must keep pointing at the real
 *   backend — /v1/chat, reviews and usage telemetry still need it.)
 *
 * Security:
 *   - Binds to 127.0.0.1 ONLY (never 0.0.0.0) — the secret and any refresh
 *     tokens must never be reachable from the LAN.
 *   - GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET are read from the repo-root
 *     .env (or the process env). Must be the SAME OAuth client whose client ID
 *     is set in the app's .env, with redirect URI
 *     http://localhost:11111/auth/callback registered.
 *   - Only the exact redirect URI the app uses is accepted.
 *
 * Run:  node dev/calendar-proxy/server.mjs      (default port 3000)
 *       CALENDAR_PROXY_PORT=3456 node dev/calendar-proxy/server.mjs
 */

import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const ROOT_ENV = path.resolve(here, '..', '..', '.env');

// Load the repo-root .env, only filling variables not already set (same
// semantics as dotenv with override:false). Zero dependencies on purpose.
try {
  for (const line of readFileSync(ROOT_ENV, 'utf8').split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/);
    if (!m || m[1].startsWith('#')) continue;
    const [, key, raw] = m;
    if (process.env[key] === undefined) {
      process.env[key] = raw.replace(/^["']|["']$/g, '');
    }
  }
} catch {
  // No root .env — rely on the process environment only.
}

const GOOGLE_CLIENT_ID = process.env.GOOGLE_CLIENT_ID || '';
const GOOGLE_CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET || '';
const REDIRECT_URI = 'http://localhost:11111/auth/callback';
const PORT = Number(process.env.CALENDAR_PROXY_PORT || 3000);

if (
  !GOOGLE_CLIENT_ID ||
  !GOOGLE_CLIENT_SECRET ||
  GOOGLE_CLIENT_ID === 'your_google_client_id_here' ||
  GOOGLE_CLIENT_SECRET === 'your_google_client_secret_here'
) {
  console.error(
    '[calendar-proxy] GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET missing or placeholder. ' +
      'Set them in the repo-root .env (or the environment) and restart.'
  );
  process.exit(1);
}

/** POST form-encoded params to Google's token endpoint; returns {status, json}. */
async function googleToken(params) {
  const body = new URLSearchParams(params).toString();
  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body,
    signal: AbortSignal.timeout(15_000),
  });
  const text = await res.text();
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    json = { error: 'unparseable_response', message: text.slice(0, 300) };
  }
  return { status: res.status, json };
}

/** Read and JSON.parse a request body, capped to avoid abuse. */
function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > 64 * 1024) {
        reject(new Error('body_too_large'));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => {
      try {
        const raw = Buffer.concat(chunks).toString('utf8');
        resolve(raw ? JSON.parse(raw) : {});
      } catch {
        reject(new Error('invalid_json'));
      }
    });
    req.on('error', reject);
  });
}

function send(res, status, json) {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(json));
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url || '/', `http://${req.headers.host || '127.0.0.1'}`);
  if (req.method !== 'POST') return send(res, 405, { error: 'method_not_allowed' });

  let body;
  try {
    body = await readJsonBody(req);
  } catch (err) {
    return send(res, 400, { error: 'bad_request', message: String(err.message || err) });
  }

  try {
    if (url.pathname === '/api/calendar/exchange') {
      const { code, redirect_uri } = body;
      if (typeof code !== 'string' || !code) return send(res, 400, { error: 'missing_code' });
      // Only accept the exact loopback redirect the app registered — a local
      // proxy that would echo arbitrary redirect URIs is an open redirector.
      if (redirect_uri !== REDIRECT_URI) {
        return send(res, 400, { error: 'invalid_redirect_uri', message: `expected ${REDIRECT_URI}` });
      }
      const { status, json } = await googleToken({
        code,
        client_id: GOOGLE_CLIENT_ID,
        client_secret: GOOGLE_CLIENT_SECRET,
        redirect_uri: REDIRECT_URI,
        grant_type: 'authorization_code',
      });
      console.log(`[calendar-proxy] exchange -> ${status} (${json.error || 'ok'})`);
      return send(res, status, json);
    }

    if (url.pathname === '/api/calendar/refresh') {
      const { refresh_token } = body;
      if (typeof refresh_token !== 'string' || !refresh_token) {
        return send(res, 400, { error: 'missing_refresh_token' });
      }
      const { status, json } = await googleToken({
        refresh_token,
        client_id: GOOGLE_CLIENT_ID,
        client_secret: GOOGLE_CLIENT_SECRET,
        grant_type: 'refresh_token',
      });
      console.log(`[calendar-proxy] refresh -> ${status} (${json.error || 'ok'})`);
      return send(res, status, json);
    }

    return send(res, 404, { error: 'not_found' });
  } catch (err) {
    console.error('[calendar-proxy] upstream error:', err);
    return send(res, 502, { error: 'upstream_error', message: String(err?.message || err) });
  }
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`[calendar-proxy] listening on http://127.0.0.1:${PORT}`);
  console.log('[calendar-proxy] routes: POST /api/calendar/exchange, POST /api/calendar/refresh');
  console.log(`[calendar-proxy] point the app at it with NATIVELY_CALENDAR_API_URL=http://127.0.0.1:${PORT}`);
});
