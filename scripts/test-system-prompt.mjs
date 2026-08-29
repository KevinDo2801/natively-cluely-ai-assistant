#!/usr/bin/env node
// scripts/test-system-prompt.mjs
//
// Render the ACTUAL system prompt v2 that a given mode/action turn will send to
// the model, and print it so you can inspect exactly what the AI "sees".
//
// Why: the system prompt is the user-facing proof that a mode's persona +
// custom instructions are working. This calls the same builder the app uses
// (electron/llm/promptSystemV2.ts -> buildSystemPromptV2) against the compiled
// build, so what you print here is byte-for-byte what a real turn composes
// (minus the dynamic evidence/transcript blocks, which ride the user message).
//
// Usage (run from repo root):
//   node scripts/test-system-prompt.mjs                        # defaults: technical-interview / answer / cloud
//   node scripts/test-system-prompt.mjs --mode sales --action what_to_say
//   node scripts/test-system-prompt.mjs --mode custom --action answer --instructions "You always reply in Vietnamese."
//   node scripts/test-system-prompt.mjs --mode general --action answer --tier local --chat
//   node scripts/test-system-prompt.mjs --list                 # list valid modes + actions
//
// Notes:
//   - Requires the electron build: run `npm run build:electron` first (the
//     compiled module lives at dist-electron/electron/llm/promptSystemV2.js).
//   - `--chat` marks the surface as the typed chat panel (adds chat_layout).
//   - `--codingTask` appends the coding contract to whatever mode you picked.

import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { buildSystemPromptV2 } = require('../dist-electron/electron/llm/promptSystemV2.js');

function parseArgs(argv) {
  const get = (k, dflt) => {
    const i = argv.indexOf(`--${k}`);
    return i !== -1 && argv[i + 1] !== undefined ? argv[i + 1] : dflt;
  };
  return {
    mode: get('mode', 'technical-interview'),
    action: get('action', 'answer'),
    tier: get('tier', 'cloud'),
    instructions: get('instructions', ''),
    chat: argv.includes('--chat'),
    codingTask: argv.includes('--codingTask'),
  };
}

const args = parseArgs(process.argv.slice(2));

if (process.argv.includes('--list')) {
  const modes = ['general','looking-for-work','sales','recruiting','team-meet','lecture','technical-interview','seminar','call-center','custom'];
  const actions = ['assist','answer','what_to_say','clarify','brainstorm','followup','follow_up_questions','recap','code_hint','title','summary_json','followup_email'];
  console.log('MODES  :', modes.join(', '));
  console.log('ACTIONS:', actions.join(', '));
  process.exit(0);
}

if (!['cloud', 'local'].includes(args.tier)) {
  console.error(`Unknown tier: ${args.tier} (expected cloud|local)`);
  process.exit(1);
}

const input = {
  mode: args.mode,
  action: args.action,
  tier: args.tier,
  chatSurface: args.chat,
  codingTask: args.codingTask,
  ...(args.instructions ? { customInstructions: args.instructions } : {}),
};

const prompt = buildSystemPromptV2(input);

const chars = prompt.length;
const estTokens = Math.ceil(chars / 4);

console.log('='.repeat(70));
console.log('SYSTEM PROMPT v2');
console.log(`  mode   : ${input.mode}`);
console.log(`  action : ${input.action}`);
console.log(`  tier   : ${input.tier}`);
console.log(`  chat   : ${input.chat}`);
console.log(`  coding : ${input.codingTask}`);
if (args.instructions) console.log(`  custom : ${args.instructions}`);
console.log(`  chars  : ${chars}   est. tokens ~${estTokens}`);
console.log('='.repeat(70));
console.log(prompt);
console.log('='.repeat(70));
