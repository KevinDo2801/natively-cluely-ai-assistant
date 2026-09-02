#!/usr/bin/env node
/**
 * Fast electron build using esbuild (transpile-only, no type checking).
 * ~10-50x faster than `tsc` for dev builds.
 * Run `npm run typecheck:electron` separately for type safety.
 */

const { build, context } = require('esbuild');

// `--watch` replaces the old `tsc -p electron/tsconfig.json --watch` script. That
// script emitted via tsc, which is incompatible with module:"Preserve" (the
// TS7-legal setting) — and tsc has not been the emitter for dist-electron for a
// long time anyway. Type-checking in watch mode is `tsc --noEmit --watch`.
const WATCH = process.argv.includes('--watch');
const path = require('path');
const fs = require('fs');
const dotenv = require('dotenv');

// ── SUPABASE CONFIG BAKE ─────────────────────────────────────────────────────
// Packaged builds have no shell env and main.ts only loads `.env` in dev, so
// SupabaseAuthService/SupabaseSyncService would read an unset
// process.env.SUPABASE_URL and cloud sync would silently stay disabled in
// production. Bake the (public-by-design) URL + anon key into the bundle as
// `__NATIVELY_SUPABASE_*__`; electron/services/supabaseConfig.ts prefers a live
// process.env override (dev) and falls back to these baked values (packaged).
// The service_role key must NEVER be baked — it bypasses RLS.
const parsedEnv = (dotenv.config({ quiet: true }).parsed) || {};
const bakedSupabaseUrl = process.env.SUPABASE_URL || parsedEnv.SUPABASE_URL || '';
const bakedSupabaseAnonKey = process.env.SUPABASE_ANON_KEY || parsedEnv.SUPABASE_ANON_KEY || '';
if (!bakedSupabaseUrl || !bakedSupabaseAnonKey) {
  console.warn(
    '[build-electron] SUPABASE_URL/SUPABASE_ANON_KEY not found in env or .env — ' +
      'packaged builds will ship WITHOUT Supabase cloud sync. ' +
      '(The anon key is public by design; see .env.example.)'
  );
}

// ── GOOGLE CALENDAR CONFIG BAKE ──────────────────────────────────────────────
// Packaged builds load no `.env` (main.ts only does in dev) and inherit no shell
// env, so CalendarManager would read an unset GOOGLE_CLIENT_* and DIRECT mode
// could not link a Google Calendar on the install machine. Bake the client ID
// (public by design) AND — ONLY for a single-operator/private build — the client
// secret into the bundle as __NATIVELY_GOOGLE_*__; googleCalendarConfig.ts
// prefers a live process.env override (dev) and falls back to these baked
// values (packaged).
//
// ⚠️ Never point a DISTRIBUTED build at NATIVELY_CALENDAR_DIRECT with the secret
// baked — the secret will be extractable from the binary. Baking the secret here
// is only acceptable for a private/self-hosted release (one operator), where the
// .exe is never redistributed publicly.
const bakedGoogleClientId = process.env.GOOGLE_CLIENT_ID || parsedEnv.GOOGLE_CLIENT_ID || '';
const bakedGoogleClientSecret = process.env.GOOGLE_CLIENT_SECRET || parsedEnv.GOOGLE_CLIENT_SECRET || '';
if (!bakedGoogleClientId) {
  console.warn(
    '[build-electron] GOOGLE_CLIENT_ID not found in env or .env — ' +
      'packaged builds will not be able to link a Google Calendar. ' +
      '(Set GOOGLE_CLIENT_ID as a repo variable in GitHub Actions.)'
  );
}

const rootDir = path.resolve(__dirname, '..');
const outDir = path.resolve(rootDir, 'dist-electron');

const entryPoints = [];

// Function to recursively find all .ts files in a directory
const findTs = (dir) => {
  const results = [];
  for (const f of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, f.name);
    if (f.isDirectory()) results.push(...findTs(full));
    else if (f.name.endsWith('.ts') && !f.name.endsWith('.d.ts')) results.push(full);
  }
  return results;
};

const electronDir = path.resolve(rootDir, 'electron');
if (fs.existsSync(electronDir)) {
  entryPoints.push(...findTs(electronDir).map(f => path.relative(rootDir, f)));
}

const start = Date.now();

const buildOptions = {
  entryPoints,
  bundle: true,           // resolve all static + dynamic imports so postProcessor
                         // is inlined and the path rewrite works (vs bundle:false
                         // which copies files as-is and leaves unresolved relative paths)
  outdir: outDir,
  outbase: rootDir,       // preserve directory structure (electron/main.ts → dist-electron/electron/main.js)
  platform: 'node',
  target: 'node20',
  format: 'cjs',          // Electron loads package.json main as CommonJS in this repo
                          // (package.json has no "type": "module").
  external: [
    'electron',
    'better-sqlite3',
    'sqlite-vec',
    '@vectorize-io/hindsight-client',
    // onnxruntime-node ships a compiled `.node` binary. Every other ONNX
    // consumer in this codebase (Whisper, LocalReranker, LocalEmbeddingProvider,
    // IntentClassifier) only reaches it indirectly through @huggingface/transformers'
    // own dynamic loading, which doesn't trip esbuild's bundler. The Nemotron
    // ONNX modules (electron/audio/whisper/nemotron/) are the first place
    // with a direct static `import ... from 'onnxruntime-node'`, and esbuild
    // can't bundle a native binary — it throws "No loader configured for
    // .node files". Externalizing keeps it loadable from node_modules at
    // runtime instead. (onnxruntime-common is a transitive dep of
    // onnxruntime-node but does NOT need to be listed here: once
    // onnxruntime-node itself is external, esbuild never traverses into its
    // internals to see the nested `require('onnxruntime-common')` call —
    // verified empirically by removing it and rebuilding clean, and by
    // confirming no first-party file imports onnxruntime-common directly.)
    'onnxruntime-node',
    // Heavy native ESM modules with `import.meta.url`-dependent init. Keeping
    // them external lets Node's loader give them a real `import.meta.url`,
    // which the bundled version can't (esbuild's CJS target sets
    // `import_meta = {}`). pdfjs-dist's legacy build runs a canvas/DOMMatrix
    // polyfill block at module-init that uses
    // `createRequire(import.meta.url)` to load `@napi-rs/canvas`; the
    // bundled version breaks this and `new DOMMatrix()` then throws
    // "DOMMatrix is not a constructor" at line 15620 (`const SCALE_MATRIX
    // = new DOMMatrix();`). The bundling also breaks pdf-parse@2.x's
    // fake-worker bootstrap (workerSrc resolves to a non-existent
    // dist-electron/electron/pdf.worker.mjs). Externalizing keeps them
    // loadable from node_modules at runtime, where the real polyfill chain
    // works and our pinPdfjsWorkerSrcOnce() helper can resolve the real
    // worker file.
    'pdfjs-dist',
    'pdf-parse',
    'mammoth',
  ],
  sourcemap: true,
  jsx: 'automatic',
  // Baked supabase config for packaged builds (see the SUPABASE CONFIG BAKE
  // comment at the top of this file). Always defined (possibly as ''), so the
  // `typeof` guard in supabaseConfig.ts sees a string literal in every bundle.
  define: {
    __NATIVELY_SUPABASE_URL__: JSON.stringify(bakedSupabaseUrl),
    __NATIVELY_SUPABASE_ANON_KEY__: JSON.stringify(bakedSupabaseAnonKey),
    __NATIVELY_GOOGLE_CLIENT_ID__: JSON.stringify(bakedGoogleClientId),
    __NATIVELY_GOOGLE_CLIENT_SECRET__: JSON.stringify(bakedGoogleClientSecret),
  },
  loader: {
    '.ts': 'ts',
    '.js': 'js',
  },
  // EVAL-ONLY DNS fix, injected at the very top of every output bundle (runs
  // BEFORE esbuild's deferred __esm module initializers — a top-level statement
  // inside main.ts gets wrapped in a lazy init that never ran at process start).
  // Under the real-UI eval's rapid app-relaunch load, macOS getaddrinfo returns
  // spurious ENOTFOUND for api.natively.software (a Railway CNAME), failing the
  // app's fetch() to /v1/pro/verify and /v1/chat and corrupting the eval — even
  // though `dig`/dns.resolve4 resolve it fine. We reroute dns.lookup for that one
  // host to dns.resolve4 (direct DNS query, no getaddrinfo cache). Gated on
  // NATIVELY_UI_EVAL='1' and idempotent (__nativelyDnsPinned guard), so it is a
  // strict no-op in production and across the multiple bundles that carry it.
  banner: {
    js: `try{if(process.env.NATIVELY_UI_EVAL==='1'&&!globalThis.__nativelyDnsPinned){globalThis.__nativelyDnsPinned=1;var __dns=require('dns');var __ol=__dns.lookup.bind(__dns);__dns.lookup=function(h,o,cb){if(typeof o==='function'){cb=o;o={};}if(h==='api.natively.software'){return __dns.resolve4(h,function(e,a){if(e||!a||!a.length)return __ol(h,o,cb);if(o&&o.all)return cb(null,[{address:a[0],family:4}]);return cb(null,a[0],4);});}return __ol(h,o,cb);};console.log('[eval] dns.lookup→resolve4 pinned for api.natively.software');}}catch(__e){try{console.warn('[eval] dns pin banner failed:',__e&&__e.message);}catch(_){}}`,
  },
  logLevel: 'warning',
  plugins: [],
};

const onFailure = (err) => {
  console.error('[build-electron] Build failed:', err.message);
  process.exit(1);
};

// Non-JS assets esbuild does not know about. These must be copied on EVERY
// build path — a one-off copy in the non-watch branch left `npm run watch`
// (after a clean) with a dist-electron that has no .proto, so NVIDIA speech
// died at runtime with an ENOENT pointing at the missing file rather than at
// the build.
const ASSETS = [
  { from: 'electron/audio/riva_asr.proto', to: 'electron/audio/riva_asr.proto' },
];

const copyAssets = () => {
  for (const asset of ASSETS) {
    const src = path.resolve(rootDir, asset.from);
    const dest = path.resolve(outDir, asset.to);
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.copyFileSync(src, dest);
  }
};

/**
 * Create an esbuild watch context for the Electron main process.
 *
 * When `onBuildEnd` is provided, it is called with the result of EVERY build —
 * the initial one and each watch rebuild — so a caller (scripts/dev-electron.js)
 * can react exactly when a build lands instead of polling the filesystem
 * (fs.watch on Windows delivers write storms from large bundles as delayed,
 * duplicate events, which caused spurious restarts).
 */
function createWatchContext(onBuildEnd) {
  const plugins = [...buildOptions.plugins];
  if (typeof onBuildEnd === 'function') {
    plugins.push({
      name: 'dev-electron-on-build-end',
      setup(build) {
        build.onEnd((result) => {
          try {
            onBuildEnd(result);
          } catch (err) {
            console.error('[build-electron] onBuildEnd hook threw:', err);
          }
        });
      },
    });
  }
  return context({ ...buildOptions, plugins });
}

module.exports = { createWatchContext, copyAssets };

if (WATCH) {
  createWatchContext().then(async (ctx) => {
    await ctx.watch();
    copyAssets();
    // Deliberately no timing here: ctx.watch() returns once the watcher is armed,
    // and esbuild runs the first build asynchronously after that — printing an
    // elapsed time would report context setup, not a completed build.
    console.log('[build-electron] watching for changes...');
  }).catch(onFailure);
} else {
  build(buildOptions).then(() => {
    copyAssets();
    console.log(`[build-electron] Done in ${Date.now() - start}ms`);
  }).catch(onFailure);
}
