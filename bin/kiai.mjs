// kiai — command line for the KIAI flight record (black box for AI coding agents).
// Usage: node kiai.mjs <command> [options]
//   init                       create .kiai/ in the current repo (idempotent)
//   record [Event]             read a Claude Code hook payload from stdin, append one record. Always exits 0.
//   note "<text>" [--by who]   append a human/agent note (e.g. a gate decision) to the chain
//   verify                     recompute every chain; exit 1 if any is broken
//   status                     counts, writers, chain heads
//   report [--uow ID] [--session ID] [--since DATE] [--json] [--out FILE]
//   hooks                      print the hooks block for manual install into .claude/settings.json
//   accept --uow ID [--decision approve|reject|conditional] [--by who] [--note TEXT] [--ac FILE]
//          [--lang en|vi|both] [--out DIR]     acceptance packet (.md + .json) from the flight record;
//          with --decision the decision is sealed into the chain with the packet hash
//   accept --check FILE        recompute a packet's Hash: footer; exit 1 if it does not match
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  appendRecord, buildRecord, noteRecord, initFlight, verifyChain, readAll, filterRecords,
  renderMarkdown, summarize, logError, flightDir, writerId, detectUow, sha256, redact,
} from '../lib/flight.mjs';
import { buildPacket, renderPacket, checkPacket, findSealing, DECISIONS } from '../lib/accept.mjs';
import os from 'node:os';

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
        const rec = buildRecord(payload, { event: args._[1], cwd: start, root: target });
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
    case 'accept': {
      if (args.check && args.check !== true) {
        const file = path.resolve(cwd, args.check);
        let text;
        try { text = fs.readFileSync(file, 'utf8'); } catch (e) { stderr.write(`kiai accept --check: ${e.message}\n`); return 2; }
        let ok;
        if (file.endsWith('.json')) {
          // companion .json: its md_sha256 must match the .md next to it, and the chain must know its own hash
          let j; try { j = JSON.parse(text); } catch (e) { stdout.write(`MISMATCH — not valid JSON: ${e.message}\n`); return 1; }
          const mdPath = path.join(path.dirname(file), String(j.md_path || ''));
          let mdText = null; try { mdText = fs.readFileSync(mdPath, 'utf8'); } catch { /* missing */ }
          ok = mdText !== null && sha256(mdText) === j.md_sha256;
          stdout.write(ok ? `OK — .json points at ${path.basename(mdPath)} (md_sha256 matches)\n` : `MISMATCH — ${mdText === null ? `companion ${path.basename(mdPath)} not found` : 'md_sha256 does not match the .md next to it'}\n`);
        } else {
          const c = checkPacket(text);
          ok = c.ok;
          stdout.write(ok ? `OK — packet hash ${c.expected.slice(0, 16)}… matches\n` : `MISMATCH — ${c.reason || `footer ${String(c.expected).slice(0, 16)}… but content hashes to ${String(c.actual).slice(0, 16)}…`}\n`);
        }
        const chainRoot = findRoot(path.dirname(file)) ?? findRoot(cwd);
        if (chainRoot && fs.existsSync(flightDir(chainRoot))) {
          const sealing = findSealing(readAll(chainRoot), text);
          if (sealing.length) for (const r of sealing) stdout.write(`SEALED — decision record seq ${r.seq} (${r.writer || 'legacy'}): ${String(r.decision).toUpperCase()} by ${r.by} at ${r.ts}${r.via === 'agent-session' ? ' ⚠ via agent session' : ''}\n`);
          else stdout.write('NOT SEALED — no decision record in this repository carries this file\'s hash (a draft, a re-encoded copy, or a packet from another repository)\n');
        }
        return ok ? 0 : 1;
      }
      const uow = (args.uow && args.uow !== true ? String(args.uow) : detectUow(root)) || null;
      if (!uow || !/^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/.test(uow)) { stderr.write('usage: kiai accept --uow UOW-123 [--decision approve|reject|conditional] [--by who] [--note TEXT] [--ac FILE] [--lang en|vi|both] [--out DIR]\n'); return 2; }
      const decision = args.decision && args.decision !== true ? String(args.decision).toLowerCase() : null;
      if (decision && !DECISIONS.includes(decision)) { stderr.write(`kiai accept: --decision must be one of ${DECISIONS.join('|')}\n`); return 2; }
      const lang = args.lang && args.lang !== true ? String(args.lang) : 'en';
      if (!['en', 'vi', 'both'].includes(lang)) { stderr.write('kiai accept: --lang must be en|vi|both\n'); return 2; }
      // Decisions are taken by a human OUTSIDE the agent session. Inside one (Claude Code sets CLAUDECODE) we refuse
      // unless KIAI_ALLOW_AGENT_DECISION=1, and then the record and the packet say so. An env check, not a signature.
      const inAgent = Boolean(process.env.CLAUDECODE || process.env.CLAUDE_CODE_ENTRYPOINT);
      const via = inAgent ? 'agent-session' : 'human';
      if (decision && inAgent && process.env.KIAI_ALLOW_AGENT_DECISION !== '1') {
        stderr.write('kiai accept: refusing — decisions are taken by a human outside the agent session (CLAUDECODE is set). Run this in your own terminal; set KIAI_ALLOW_AGENT_DECISION=1 only if you really want an agent-made decision recorded as such.\n');
        return 1;
      }
      const v = verifyChain(root);
      if (!v.ok) { stderr.write(`kiai accept: refusing — flight record BROKEN at seq ${v.broken ?? '?'}: ${v.reason}\n`); return 1; }
      let ac = null; let acPath = null;
      const acCandidate = args.ac && args.ac !== true ? path.resolve(cwd, args.ac) : path.join(root, '.kiai', 'ac', `${uow}.md`);
      if (fs.existsSync(acCandidate)) {
        if (!fs.statSync(acCandidate).isFile()) { stderr.write(`kiai accept: --ac is not a file: ${acCandidate}\n`); return 2; }
        ac = redact(fs.readFileSync(acCandidate, 'utf8')); acPath = path.relative(root, acCandidate).replace(/\\/g, '/');
      } else if (args.ac && args.ac !== true) { stderr.write(`kiai accept: --ac file not found: ${acCandidate}\n`); return 2; }
      const records = readAll(root);
      let username = null; try { username = os.userInfo().username; } catch { /* unknown */ }
      const by = redact(String(args.by && args.by !== true ? args.by : (process.env.KIAI_ACTOR || username || 'human'))).slice(0, 80);
      const note = args.note && args.note !== true ? redact(String(args.note)).slice(0, 2000) : null;
      const pkg = buildPacket({ root, records, verification: v, uow, decision, by, note, via, ac, acPath });
      if (decision && pkg.records_in_scope === 0) { stderr.write(`kiai accept: refusing — no flight records for ${uow}; nothing to decide on\n`); return 1; }
      const md = renderPacket(pkg, lang);
      const outDir = path.resolve(cwd, args.out && args.out !== true ? String(args.out) : '.');
      fs.mkdirSync(outDir, { recursive: true });
      // Drafts and decisions never share a file name, so a later draft cannot overwrite a sealed packet (review 120 P3).
      const base = decision ? `acceptance-${uow}` : `acceptance-${uow}.draft`;
      const mdPath = path.join(outDir, `${base}.md`);
      const jsonPath = path.join(outDir, `${base}.json`);
      const packetSha = sha256(md);
      const footer = checkPacket(md).expected;
      const jsonText = JSON.stringify({ ...pkg, md_sha256: packetSha, md_path: path.basename(mdPath) }, null, 2) + '\n';
      const jsonSha = sha256(jsonText);
      let sealed = null;
      if (decision) {
        // Seal FIRST (into a temp pair), then move into place: no APPROVED packet can exist on disk without its record (P2).
        const tmpMd = mdPath + '.tmp'; const tmpJson = jsonPath + '.tmp';
        fs.writeFileSync(tmpMd, md); fs.writeFileSync(tmpJson, jsonText);
        try {
          sealed = appendRecord(root, {
            ts: new Date().toISOString(), event: 'decision', agent: 'kiai-cli', session: null, cwd: root, uow,
            decision, by, note, via,
            packet_sha256: packetSha, packet_body_sha256: footer, json_sha256: jsonSha,
            packet_path: path.relative(root, mdPath).replace(/\\/g, '/'),
            heads: v.chains.map((c) => ({ writer: c.writer || 'legacy', count: c.count, last: c.last })),
          });
        } catch (e) {
          try { fs.rmSync(tmpMd); fs.rmSync(tmpJson); } catch { /* best effort */ }
          stderr.write(`kiai accept: refusing — could not seal the decision into the flight record (${e.message}); no packet written, retry in a moment\n`);
          return 1;
        }
        // an earlier sealed packet with the same name is kept, not overwritten
        for (const p of [mdPath, jsonPath]) {
          if (fs.existsSync(p)) { const old = fs.readFileSync(p); fs.renameSync(p, p.replace(/(\.(md|json))$/, `.prev-${sha256(old).slice(0, 8)}$1`)); }
        }
        fs.renameSync(tmpMd, mdPath); fs.renameSync(tmpJson, jsonPath);
      } else {
        fs.writeFileSync(mdPath, md); fs.writeFileSync(jsonPath, jsonText);
      }
      stdout.write(`${pkg.draft ? 'DRAFT' : pkg.decision.decision.toUpperCase()} packet for ${uow}: ${mdPath}\n`);
      stdout.write(`  records in scope: ${pkg.records_in_scope} · files: ${pkg.files.length} (${pkg.files.filter((f) => f.disk === 'matches' || f.disk === 'matches-eol').length} match, ${pkg.files.filter((f) => f.disk === 'changed-after').length} changed after, ${pkg.files.filter((f) => f.disk === 'missing').length} missing) · tests observed: ${pkg.tests.length}\n`);
      if (pkg.warnings.length) stdout.write(`  warnings: ${pkg.warnings.join(', ')}\n`);
      stdout.write(`  packet file sha256: ${packetSha} (the Hash: footer inside covers the body only)\n`);
      if (sealed) stdout.write(`  sealed into flight record: seq ${sealed.seq} (${sealed.writer}) hash ${sealed.hash.slice(0, 16)}…${via === 'agent-session' ? ' ⚠ recorded from inside an agent session' : ''}\n`);
      return 0;
    }
    default:
      stderr.write('usage: kiai <init|record|note|verify|status|report|hooks|accept>\n');
      return cmd ? 2 : 0;
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().then((code) => process.exit(code), (e) => { process.stderr.write(String(e && e.stack || e) + '\n'); process.exit(1); });
}
