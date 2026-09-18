#!/usr/bin/env node
// Cursor → KIAI hook translator. UNVERIFIED — read this before trusting it.
//
// No Cursor client existed on the machine that wrote this (2026-09-18), so nothing here was seen
// firing. The field names come from Cursor's published hooks documentation (hooks.json with
// beforeShellExecution / beforeMCPExecution / afterFileEdit / stop; JSON on stdin; JSON answer on
// stdout with {"permission": "allow"|"deny"}). Where the documentation and reality disagree, reality
// wins and this file is wrong — so it is written to fail SAFE, not to fail loud:
//
//   - it maps what it recognises and records `tool_name: "unknown"` for what it does not;
//   - it ALWAYS answers {"permission":"allow"} unless a `block` rule matches;
//   - it NEVER exits non-zero. A translator must not be the reason the editor stops working.
//
// Install:  kiai hooks --agent cursor > .cursor/hooks.json   (or ~/.cursor/hooks.json)
// Verify:   run one Cursor session, then `kiai status` in the repo — records mean it fired.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { appendRecord, buildRecord, logError } from '../../lib/flight.mjs';
import { loadRules, evaluate } from '../../lib/rules.mjs';

const EVENT = process.argv[2] || '';

/** Walk up from `start` to the directory that holds `.kiai/`. Kept local: importing bin/kiai.mjs would run its main(). */
function findRoot(start) {
  let dir = path.resolve(start || process.cwd());
  for (;;) {
    if (fs.existsSync(path.join(dir, '.kiai'))) return dir;
    const up = path.dirname(dir);
    if (up === dir) return null;
    dir = up;
  }
}

function readStdin() {
  try { return process.stdin.isTTY ? '' : fs.readFileSync(0, 'utf8'); } catch { return ''; }
}

/** Cursor 3.19.7 fills workspace_roots with folder.uri.path — on Windows that is "/d:/tmp/repo", a URI path, not a filesystem path. */
function fromUriPath(p) {
  const s = String(p || '');
  return /^\/[A-Za-z]:\//.test(s) ? s.slice(1) : s;
}

/** Cursor event → KIAI event + tool. Anything else becomes an `unknown` PostToolUse so it is at least seen. */
function translate(ev, h) {
  // `cwd` is the shell's working directory (a real path, present on shell events); workspace_roots is the
  // wrapper Cursor adds to every event (measured 2026-09-19 in Cursor 3.19.7's own bundle: {...event,
  // session_id, hook_event_name, cursor_version, workspace_roots, user_email, transcript_path}).
  const cwd = h.cwd || (Array.isArray(h.workspace_roots) && fromUriPath(h.workspace_roots[0])) || process.cwd();
  const session = String(h.conversation_id || h.session_id || 'cursor');
  const useId = String(h.generation_id || h.tool_use_id || `cursor-${Date.now().toString(36)}`);
  const base = { session_id: session, cwd, tool_use_id: useId };
  switch (ev) {
    case 'beforeShellExecution':
      return { ...base, hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command: String(h.command || '') } };
    case 'beforeMCPExecution':
      return { ...base, hook_event_name: 'PreToolUse', tool_name: String(h.tool_name || 'mcp'), tool_input: h.tool_input || h.arguments || {} };
    case 'afterFileEdit':
      return { ...base, hook_event_name: 'PostToolUse', tool_name: 'Edit', tool_input: { file_path: String(h.file_path || h.path || '') }, tool_response: { edits: Array.isArray(h.edits) ? h.edits.length : undefined } };
    case 'stop':
      return { ...base, hook_event_name: 'Stop', tool_name: undefined, tool_input: undefined };
    default:
      return { ...base, hook_event_name: 'PostToolUse', tool_name: 'unknown', tool_input: { cursor_event: ev } };
  }
}

function main() {
  let h = {};
  const raw = readStdin();
  try { h = JSON.parse(raw || '{}'); } catch { h = {}; }
  if (!h || typeof h !== 'object' || Array.isArray(h)) h = {};
  // KIAI_CURSOR_DEBUG=1 prints what arrived — the one thing a Cursor user needs when this translator
  // does not recognise their payload, and the one thing to attach (redacted) to a bug report.
  if (process.env.KIAI_CURSOR_DEBUG) process.stderr.write(`kiai-cursor-hook ${EVENT}: ${raw.length} bytes, keys=[${Object.keys(h).join(',')}]\n`);
  const rec = translate(EVENT, h);
  // The payload's cwd first; the process cwd as a fallback (Cursor runs hooks inside the workspace).
  // A cwd this process cannot resolve — a POSIX path handed to a Windows node — must not silently
  // turn into "no repository here": that is exactly how a probe on 2026-09-18 lost every record.
  const root = findRoot(rec.cwd) || findRoot(process.cwd()) || null;
  if (root && !findRoot(rec.cwd)) rec.cwd = root;
  let answer = { permission: 'allow' };
  if (root) {
    try { appendRecord(root, buildRecord(rec, { cwd: rec.cwd, root })); } catch (e) { try { logError(root, e); } catch { /* nothing left to do */ } }
    // Only a `before*` event can be refused, and only by a `block` rule — the same engine, the same answer.
    if (rec.hook_event_name === 'PreToolUse') {
      try {
        const { rules } = loadRules(root);
        const action = { tool: rec.tool_name, command: rec.tool_input && rec.tool_input.command, path: rec.tool_input && rec.tool_input.file_path };
        const { decision, hits } = evaluate(rules, action);
        if (decision === 'block') {
          const r = hits[0];
          const why = (r.why && (r.why.en || r.why.vi)) || '';
          answer = { permission: 'deny', user_message: `KIAI: blocked by ${r.id}`, agent_message: `Blocked by rule ${r.id}: ${(r.statement && (r.statement.en || r.statement.vi)) || ''} — ${why}` };
        }
      } catch { /* a broken rule file must not stop the editor; `kiai rules lint` reports it */ }
    }
  }
  process.stdout.write(JSON.stringify(answer) + '\n');
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { main(); } catch { process.stdout.write('{"permission":"allow"}\n'); }
  process.exit(0);
}
