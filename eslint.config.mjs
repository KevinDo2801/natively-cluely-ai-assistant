// ESLint flat config — Natively (Phase 0 of the refactor plan).
//
// Philosophy: ADVISORY FIRST. This repo had zero lint enforcement with
// typescript-eslint dangling in devDependencies. Every rule starts as "warn"
// (exit code stays 0) so `npm run lint` is signal, not a gate. Phase 6
// promotes rules to "error" for new code and wires --max-warnings into CI.
//
// Intentionally OFF (tracked by other mechanisms):
//   no-console                      — 2,417 sites; Phase 6 logger migration owns this
//   @typescript-eslint/no-explicit-any — 1,936 sites; reports/any-baseline.json ratchet owns this
//   @typescript-eslint/no-require-imports — 429 deliberate lazy requires in the god files;
//                                     Phase 2 IPC decomposition removes them

import tsParser from '@typescript-eslint/parser';
import tsPlugin from '@typescript-eslint/eslint-plugin';
import reactHooks from 'eslint-plugin-react-hooks';

const nodeGlobals = {
  process: 'readonly',
  console: 'readonly',
  Buffer: 'readonly',
  __dirname: 'readonly',
  __filename: 'readonly',
  require: 'readonly',
  module: 'writable',
  exports: 'writable',
  global: 'readonly',
  setTimeout: 'readonly',
  clearTimeout: 'readonly',
  setInterval: 'readonly',
  clearInterval: 'readonly',
  setImmediate: 'readonly',
  clearImmediate: 'readonly',
  queueMicrotask: 'readonly',
  fetch: 'readonly',
  URL: 'readonly',
  URLSearchParams: 'readonly',
  AbortController: 'readonly',
  AbortSignal: 'readonly',
  NodeJS: 'readonly',
};

const browserGlobals = {
  window: 'readonly',
  document: 'readonly',
  navigator: 'readonly',
  localStorage: 'readonly',
  sessionStorage: 'readonly',
  HTMLElement: 'readonly',
  HTMLDivElement: 'readonly',
  HTMLInputElement: 'readonly',
  HTMLButtonElement: 'readonly',
  Element: 'readonly',
  Node: 'readonly',
  Event: 'readonly',
  KeyboardEvent: 'readonly',
  MouseEvent: 'readonly',
  WheelEvent: 'readonly',
  CustomEvent: 'readonly',
  ResizeObserver: 'readonly',
  MutationObserver: 'readonly',
  IntersectionObserver: 'readonly',
  requestAnimationFrame: 'readonly',
  cancelAnimationFrame: 'readonly',
  matchMedia: 'readonly',
  MediaQueryList: 'readonly',
  getComputedStyle: 'readonly',
  Image: 'readonly',
  Blob: 'readonly',
  File: 'readonly',
  FileReader: 'readonly',
  FormData: 'readonly',
  WebSocket: 'readonly',
  AudioContext: 'readonly',
  MediaStream: 'readonly',
  MediaRecorder: 'readonly',
  DOMRect: 'readonly',
  DOMParser: 'readonly',
  XMLSerializer: 'readonly',
  alert: 'readonly',
  confirm: 'readonly',
  prompt: 'readonly',
};

export default [
  {
    ignores: [
      'node_modules/**',
      'dist/**',
      'dist-electron/**',
      'release/**',
      'build/**',
      '**/__tests__/**',
      '**/*.test.mjs',
      '**/*.spec.*',
      'benchmarks/**',
      'native-module/**',
      'natively-api/**',
      'natively-browser/**',
      'renderer/**',
      'worker-script/**',
      'test-fixtures/**',
      'tests/**',
      'models/**',
      'resources/**',
      'coverage/**',
      'intelligence-eval*/**',
      'dev/harness/**',
      'premium/**',
    ],
  },
  // Note: no `js.configs.recommended` base — @eslint/js is not a direct
  // dependency in this repo. The high-value core rules it would have enabled
  // are listed explicitly below instead.
  {
    files: ['electron/**/*.ts', 'src/**/*.{ts,tsx}', 'scripts/**/*.{js,mjs,cjs}'],
    languageOptions: {
      parser: tsParser,
      parserOptions: {
        ecmaVersion: 'latest',
        sourceType: 'module',
        ecmaFeatures: { jsx: true },
      },
      globals: { ...nodeGlobals, ...browserGlobals },
    },
    plugins: { '@typescript-eslint': tsPlugin, 'react-hooks': reactHooks },
    rules: {
      // --- Active warnings (advisory) -------------------------------------
      // React hooks correctness — the repo already carries
      // `eslint-disable react-hooks/exhaustive-deps` comments, so the plugin
      // must be registered for those comments to resolve at all.
      'react-hooks/rules-of-hooks': 'warn',
      'react-hooks/exhaustive-deps': 'warn',
      'no-unused-vars': 'off',
      '@typescript-eslint/no-unused-vars': [
        'warn',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_', caughtErrorsIgnorePattern: '^_' },
      ],
      // Core correctness rules (replacing eslint:recommended subset).
      'no-dupe-keys': 'warn',
      'no-dupe-args': 'warn',
      'no-duplicate-case': 'warn',
      'valid-typeof': 'warn',
      'no-unsafe-negation': 'warn',
      'no-cond-assign': ['warn', 'except-parens'],
      'no-debugger': 'warn',
      'no-obj-calls': 'warn',
      'no-sparse-arrays': 'warn',
      'use-isnan': 'warn',
      'no-self-assign': 'warn',
      'no-self-compare': 'warn',
      'no-unmodified-loop-condition': 'warn',
      'no-useless-catch': 'warn',
      'no-useless-escape': 'warn',
      'no-control-regex': 'off', // hot-path parsers use control regexes deliberately
      'prefer-const': 'warn',
      'no-var': 'warn',
      eqeqeq: ['warn', 'allow-null'],
      'no-duplicate-imports': 'warn',
      'no-empty': ['warn', { allowEmptyCatch: true }],
      'no-fallthrough': 'warn',
      'no-unreachable': 'warn',
      'no-constant-condition': ['warn', { checkLoops: false }],
      'no-async-promise-executor': 'warn',
      'no-promise-executor-return': 'warn',
      'no-throw-literal': 'warn',
      'prefer-promise-reject-errors': 'warn',
      // --- Deliberately off (owned elsewhere — see header) -----------------
      'no-console': 'off',
      '@typescript-eslint/no-explicit-any': 'off',
      '@typescript-eslint/no-require-imports': 'off',
      '@typescript-eslint/no-non-null-assertion': 'off',
      'no-empty-pattern': 'off',
      // CJS scripts legitimately live in module scope.
      'no-undef': 'off', // TS already reports undefined identifiers; avoids dual noise
    },
  },
  {
    files: ['scripts/**/*.{js,cjs}'],
    languageOptions: { sourceType: 'commonjs' },
  },
];
