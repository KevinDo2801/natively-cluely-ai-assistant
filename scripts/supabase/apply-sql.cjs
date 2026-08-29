/**
 * Apply a SQL file to the Natively Supabase project via the Management API.
 *
 * Usage (from the repo root):
 *   node scripts/supabase/apply-sql.cjs supabase/migrations/0001_initial_schema.sql
 *
 * Requires SUPABASE_MCP_TOKEN (sbp_...) and SUPABASE_PROJECT_REF (or
 * SUPABASE_URL) in .env. The endpoint executes the whole file as one request
 * (multi-statement); keep migrations transactional-safe as usual.
 */

'use strict';

const fs = require('fs');
const path = require('path');

const file = process.argv[2];
if (!file) {
  console.error('Usage: node scripts/supabase/apply-sql.cjs <path-to.sql>');
  process.exit(2);
}
if (!fs.existsSync(file)) {
  console.error(`File not found: ${file}`);
  process.exit(2);
}
const sql = fs.readFileSync(file, 'utf8');

const envPath = path.join(__dirname, '..', '..', '.env');
if (fs.existsSync(envPath)) {
  for (const line of fs.readFileSync(envPath, 'utf8').split(/\r?\n/)) {
    const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
    if (m && m[1].startsWith('SUPABASE_')) process.env[m[1]] = m[2].trim();
  }
}
const token = process.env.SUPABASE_MCP_TOKEN;
const ref = process.env.SUPABASE_PROJECT_REF ||
  (process.env.SUPABASE_URL || '').match(/^https:\/\/([^.]+)\.supabase\.co/)?.[1];
if (!token || !ref) {
  console.error('Missing SUPABASE_MCP_TOKEN / SUPABASE_PROJECT_REF in .env');
  process.exit(2);
}

(async () => {
  const res = await fetch(`https://api.supabase.com/v1/projects/${ref}/database/query`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ query: sql }),
  });
  const text = await res.text();
  if (!res.ok) {
    console.error(`SQL apply failed (${res.status}):`);
    console.error(text.slice(0, 4000));
    process.exit(1);
  }
  console.log(`OK — applied ${path.basename(file)} to ${ref}.`);
})().catch((e) => {
  console.error(e.message);
  process.exit(1);
});
