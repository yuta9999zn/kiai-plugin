// kiai — command line for the KIAI flight record (black box for AI coding agents).
// Usage: node kiai.mjs <command> [options]
//   init                       create .kiai/ in the current repo (idempotent)
//   record [Event]             read a Claude Code hook payload from stdin, append one record. Always exits 0.
//   note "<text>" [--by who]   append a human/agent note (e.g. a gate decision) to the chain
//   verify                     recompute every chain; exit 1 if any is broken
//   status                     counts, writers, chain heads
//   report [--uow ID] [--session ID] [--since DATE] [--json] [--out FILE]
//   hooks                      print the hooks block for manual install into .claude/settings.json
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  appendRecord, buildRecord, noteRecord, initFlight, verifyChain, readAll, filterRecords,
  renderMarkdown, summarize, logError, flightDir, writerId,
} from '../lib/flight.mjs';

const PLUGIN_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const HOOK_EVENTS = ['SessionStart', 'PreToolUse', 'PostToolUse', 'PostToolUseFailure', 'Stop', 'SubagentStop', 'SessionEnd'];

function parseArgs(argv) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const key = a.slice(2);
      const next = argv[i + 1];
      if (next !== undefined && !next.startsWith('--')) { out[key] = next; i++; } else out[key] = true;
    } else out._.push(a);
  }
  return out;
}

function readStdin() {
  try {
    if (process.stdin.isTTY) return '';
    return fs.readFileSync(0, 'utf8');
  } catch {
    return '';
  }
}

/** Walk up from `start` to the nearest directory containing .kiai/ or .git/. Returns null if there is none. */
export function findRoot(start) {
  let dir = path.resolve(start);
  if (!fs.existsSync(dir)) return null;
  for (;;) {
    if (fs.existsSync(path.join(dir, '.kiai'))) return dir;
    if (fs.existsSync(path.join(dir, '.git'))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

function hooksBlock() {
  const cmd = `node "${PLUGIN_ROOT.replace(/\\/g, '/')}/bin/kiai.mjs" record`;
  const hooks = {};
  for (const ev of HOOK_EVENTS) hooks[ev] = [{ hooks: [{ type: 'command', command: `${cmd} ${ev}`, timeout: 10 }] }];
  return { hooks };
}

export async function main(argv = process.argv.slice(2), { cwd = process.cwd(), stdout = process.stdout, stderr = process.stderr } = {}) {
  const args = parseArgs(argv);
  const cmd = args._[0];
  const root = findRoot(cwd) ?? path.resolve(cwd);

  switch (cmd) {
    case 'init': {
      const { dir, created } = initFlight(root);
      stdout.write(`${created ? 'Created' : 'Already present'}: ${dir}\n`);
      stdout.write('Enable the black box for this repo:\n');
      stdout.write(`  claude --plugin-dir "${PLUGIN_ROOT}"\n`);
      stdout.write('  (or run `node kiai.mjs hooks` and paste the block into .claude/settings.json)\n');
      stdout.write('Then: `node kiai.mjs report` after a session, `node kiai.mjs verify` any time.\n');
      return 0;
    }
    case 'record': {
      // The black box must never bring the aircraft down: every failure is logged and exit is 0.
      let target = null;
      try {
        const raw = readStdin();
        let payload = {};
        let badPayload = null;
        if (raw.trim()) {
          try { payload = JSON.parse(raw); } catch (e) { badPayload = new Error('bad hook payload: ' + e.message); }
        }
        if (!payload || typeof payload !== 'object' || Array.isArray(payload)) { badPayload = badPayload || new Error('bad hook payload: not an object'); payload = {}; }
        const start = typeof payload.cwd === 'string' && fs.existsSync(payload.cwd) ? payload.cwd : cwd;
        target = findRoot(start);
        if (!target) {
          // Not inside any repo: do not create .kiai somewhere surprising.
          stderr.write(`kiai record: no .kiai/ or .git/ above ${start}; nothing recorded\n`);
          return 0;
        }
        if (badPayload) logError(target, badPayload);
        const rec = buildRecord(payload, { event: args._[1], cwd: start });
        appendRecord(target, rec);
      } catch (e) {
        logError(target ?? root, e);
        stderr.write(`kiai record: ${e.message}\n`);
      }
      return 0;
    }
    case 'note': {
      const text = args._.slice(1).join(' ');
      if (!text) { stderr.write('usage: kiai note "<text>" [--by who]\n'); return 2; }
      const rec = appendRecord(root, noteRecord(text, { cwd: root, by: args.by || null }));
      stdout.write(`noted seq ${rec.seq} hash ${rec.hash.slice(0, 16)}…\n`);
      return 0;
    }
    case 'verify': {
      const v = verifyChain(root);
      const warn = [];
      if (v.dropped) warn.push(`${v.dropped} dropped record(s) — hook could not take the lock; log incomplete, see dropped.jsonl`);
      if (v.anomalies) warn.push(`${v.anomalies} anomaly record(s) — files and local pointer disagreed at append time`);
      if (v.ok) {
        const multi = v.chains.length > 1 ? ` in ${v.chains.length} chains (${v.chains.map((c) => `${c.writer || 'legacy'} ${c.count}`).join(', ')})` : '';
        stdout.write(`OK — ${v.count} records${multi}, head ${v.last.slice(0, 16)}…${warn.length ? ` (${warn.length} warning${warn.length > 1 ? 's' : ''})` : ''}\n`);
        for (const w of warn) stdout.write(`WARN — ${w}\n`);
        return 0;
      }
      stdout.write(`BROKEN at seq ${v.broken ?? '?'} — ${v.reason} (${v.count} records read)\n`);
      for (const w of warn) stdout.write(`WARN — ${w}\n`);
      return 1;
    }
    case 'status': {
      const records = readAll(root);
      const v = verifyChain(root);
      const sessions = summarize(records.filter((r) => Number.isInteger(r.seq)));
      stdout.write(`flight dir: ${flightDir(root)}\nthis writer: ${writerId(root)}\nrecords: ${records.length}\nsessions: ${sessions.length}\nchains: ${v.chains.length}\n`);
      for (const c of v.chains) stdout.write(`  ${c.writer || '(legacy)'}: ${c.count} records, ${c.ok ? 'intact' : 'BROKEN at seq ' + c.broken}\n`);
      if (v.dropped) stdout.write(`dropped: ${v.dropped}\n`);
      stdout.write(`chain: ${v.ok ? 'intact' : 'BROKEN at seq ' + v.broken}\n`);
      return v.ok ? 0 : 1;
    }
    case 'report': {
      const v = verifyChain(root);
      const filters = { uow: args.uow, session: args.session, since: args.since };
      let records;
      try { records = filterRecords(readAll(root), filters); } catch (e) { stderr.write(`kiai report: ${e.message}\n`); return 2; }
      const text = args.json
        ? JSON.stringify({ root, verification: v, filters, sessions: summarize(records) }, null, 2) + '\n'
        : renderMarkdown(root, records, v, filters);
      if (args.out && args.out !== true) {
        const out = path.resolve(cwd, args.out);
        fs.mkdirSync(path.dirname(out), { recursive: true });
        fs.writeFileSync(out, text);
        stdout.write(`written ${out}\n`);
      } else stdout.write(text);
      return v.ok ? 0 : 1;
    }
    case 'hooks': {
      stdout.write(JSON.stringify(hooksBlock(), null, 2) + '\n');
      return 0;
    }
    default:
      stderr.write('usage: kiai <init|record|note|verify|status|report|hooks>\n');
      return cmd ? 2 : 0;
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().then((code) => process.exit(code), (e) => { process.stderr.write(String(e && e.stack || e) + '\n'); process.exit(1); });
}
