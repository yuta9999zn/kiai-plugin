#!/usr/bin/env node
// The smallest agent loop that puts every tool call through KIAI. Zero dependencies.
//
// Any OpenAI-style or Ollama model with tool calling can drive this. The model never runs anything
// itself: each tool call becomes `kiai wrap --tool Bash --session <id> -- <command>`, which records
// PreToolUse, asks the rules (a `block` refuses the command, and the model is TOLD it was refused and
// why), runs it, and records PostToolUse. What the flight record then holds is not "what the model
// said it did" but what was actually executed, in order, hash-chained.
//
//   OLLAMA_HOST=http://127.0.0.1:11434 OLLAMA_MODEL=qwen2.5:7b \
//   node adapters/ollama/harness.mjs "List the files here, then show git status."
//
// Measured 2026-09-18 with qwen2.5:7b (see docs/HANDOFF.md for the transcript and the record count).
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const KIAI = path.join(HERE, '..', '..', 'bin', 'kiai.mjs');
const HOST = (process.env.OLLAMA_HOST || 'http://127.0.0.1:11434').replace(/\/$/, '');
const MODEL = process.env.OLLAMA_MODEL || 'qwen2.5:7b';
const MAX_TURNS = Number(process.env.KIAI_MAX_TURNS || 6);
const SESSION = process.env.KIAI_SESSION || `ollama-${MODEL.replace(/[^a-z0-9]/gi, '_')}-${Date.now().toString(36)}`;

const TOOLS = [{
  type: 'function',
  function: {
    name: 'run_shell',
    description: 'Run one shell command in the repository and return its output. Use it for ls, git, npm, cat, grep.',
    parameters: { type: 'object', properties: { command: { type: 'string', description: 'the command line' } }, required: ['command'] },
  },
}];

/** Every command goes through `kiai wrap`: recorded before and after, refused if a rule blocks it. */
function runThroughKiai(command) {
  const r = spawnSync(process.execPath, [KIAI, 'wrap', '--tool', 'Bash', '--session', SESSION, '--', 'bash', '-lc', command],
    { cwd: process.cwd(), encoding: 'utf8', maxBuffer: 8 << 20 });
  const out = (r.stdout || '').slice(0, 4000);
  const err = (r.stderr || '').slice(0, 2000);
  if (r.status === 2 && /BLOCKED BY/.test(err)) return { blocked: true, text: `REFUSED by the repository's rules:\n${err}` };
  return { blocked: false, text: `exit ${r.status}\n${out}${err ? '\n[stderr]\n' + err : ''}` };
}

async function chat(messages) {
  const res = await fetch(`${HOST}/api/chat`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ model: MODEL, stream: false, messages, tools: TOOLS }),
  });
  if (!res.ok) throw new Error(`${HOST}/api/chat → HTTP ${res.status}`);
  return (await res.json()).message;
}

async function main() {
  const prompt = process.argv.slice(2).join(' ') || 'List the files in the current directory and summarise what this repository is.';
  const messages = [
    { role: 'system', content: 'You are a careful engineer working inside a git repository. Use run_shell for anything you need to look at. Do not guess file contents.' },
    { role: 'user', content: prompt },
  ];
  for (let turn = 1; turn <= MAX_TURNS; turn++) {
    const msg = await chat(messages);
    messages.push(msg);
    const calls = Array.isArray(msg.tool_calls) ? msg.tool_calls : [];
    if (!calls.length) {
      process.stdout.write(`\n=== ${MODEL} (turn ${turn}) ===\n${msg.content || ''}\n`);
      process.stdout.write(`\nsession ${SESSION} — \`kiai verify\` and \`kiai report --session ${SESSION}\` show what was actually run.\n`);
      return;
    }
    for (const c of calls) {
      const command = String((c.function && c.function.arguments && c.function.arguments.command) || '');
      process.stdout.write(`[turn ${turn}] run_shell: ${command}\n`);
      const { blocked, text } = runThroughKiai(command);
      process.stdout.write(blocked ? `  ↳ BLOCKED\n` : `  ↳ ${text.split('\n')[0]}\n`);
      messages.push({ role: 'tool', content: text, tool_call_id: c.id });
    }
  }
  process.stdout.write(`\nstopped after ${MAX_TURNS} turns (KIAI_MAX_TURNS)\n`);
}

main().catch((e) => { process.stderr.write(`harness: ${e.message}\n`); process.exit(1); });
