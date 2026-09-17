// kiai — command line for the KIAI flight record (black box for AI coding agents).
// Usage: node kiai.mjs <command> [options]
//   init                       create .kiai/ in the current repo (idempotent)
//   record [Event]             read a Claude Code hook payload from stdin, append one record. Always exits 0.
//   note "<text>" [--by who]   append a human/agent note (e.g. a gate decision) to the chain
//   verify                     recompute every chain, then check it against the committed anchors; exit 1 if broken
//   anchor [--by who] [--note TEXT]   append a committed witness of the current heads to .kiai/anchors.jsonl
//   status                     counts, writers, chain heads
//   report [--uow ID] [--session ID] [--since DATE] [--json] [--out FILE]
//   hooks [--agent claude|codex]  print the hooks block for manual install (Claude Code: .claude/settings.json)
//   import codex [--home DIR] [--session FILE] [--since DATE] [--dry-run] [--json]
//                              build records from the session logs Codex CLI already writes.
//                              Imported records are marked `via: import` and live in their OWN chain.
//   accept --uow ID [--decision approve|reject|conditional] [--by who] [--note TEXT] [--ac FILE]
//          [--lang en|vi|both] [--out DIR]     acceptance packet (.md + .json, default .kiai/acceptance/) from the flight record;
//          with --decision the decision is sealed into the chain with the packet hash
//   accept --check FILE        recompute a packet's Hash: footer; exit 1 if it does not match
//   signers --list | --add IDENTITY --key FILE.pub   who may approve (.kiai/allowed_signers, COMMITTED)
//   --sign [--key FILE] on `accept --decision`       sign the packet body with an SSH key (offline)
//   --require-signature on `verify` / `accept --check`   exit 1 unless every decision is validly signed
//   rules list [--family F] [--json]        the rules this repo works under (.kiai/rules/*.json)
//   rules show <id> [--json]                one rule in full, examples first
//   rules search "<query>" [--limit N]      offline, deterministic lookup (vi + en)
//   rules check --tool T [--command C] [--path P] [--event E] [--action JSON] [--json]
//                              does the action I am about to take break a rule? exit 2 on a `block`
//   rules lint [--json]        the gate on the rule files themselves — schema, references,
//                              precedence, and every example replayed through the engine
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  appendRecord, buildRecord, noteRecord, initFlight, verifyChain, readAll, filterRecords,
  renderMarkdown, summarize, logError, flightDir, writerId, detectUow, sha256, redact, cell, buildAnchor, appendAnchor, readAnchors, anchorsFile, anchorsTracked, anchorsEvidence } from '../lib/flight.mjs';
import { buildPacket, renderPacket, checkPacket, packetBody, parsePacketSignatures, findSealing, DECISIONS } from '../lib/accept.mjs';
import { importCodex, codexWriter, CODEX_AGENT } from '../lib/import-codex.mjs';
import {
  loadRules, lintSet, checkExamples, nearMissReport, unexercisedConditions,
  evaluate, searchRules, rulesDir, RULES_DIR,
} from '../lib/rules.mjs';
import { signBlob, verifyBlob, addSigner, readAllowedSigners, allowedSignersFile, sshKeygenAvailable, fingerprint, fingerprintOfKeyLine, keyAlgorithm, NAMESPACE, SIG_STATE, SIG_FAIL, ALLOWED_SIGNERS_HEADER, reviewedSigner } from '../lib/sign.mjs';
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

function hooksBlock({ rules = false } = {}) {
  const bin = `${PLUGIN_ROOT.replace(/\\/g, '/')}/bin/kiai.mjs`;
  const cmd = `node "${bin}" record`;
  const hooks = {};
  for (const ev of HOOK_EVENTS) hooks[ev] = [{ hooks: [{ type: 'command', command: `${cmd} ${ev}`, timeout: 10 }] }];
  if (rules) {
    // UOW-129. `record` writes what happened; this REFUSES what must not happen. It runs before the
    // recorder on PreToolUse, and a `block` rule exits 2 — the code Claude Code reads as "do not run
    // this tool call". Nothing here asks a model whether a rule was broken: the engine decides, which
    // is the only reason the answer can be trusted at the moment it matters.
    //
    // `rules check` exits 0 when no rule applies and when a rule only warns, so an ordinary session
    // is untouched. Only a `block` rule stops anything, and `kiai rules lint` refuses to let a rule
    // call itself `block` without conditions and without a near-miss example to draw its edge.
    hooks.PreToolUse = [
      { hooks: [{ type: 'command', command: `node "${bin}" rules check --stdin --quiet`, timeout: 10 }] },
      ...hooks.PreToolUse,
    ];
  }
  return { hooks };
}

/**
 * Hook events Codex CLI 0.153.4 reports (feature `hooks` = stable). Read out of the shipped binary
 * on 2026-09-17, NOT from documentation — and NOT confirmed to fire: see CODEX_HOOK_WARNING.
 */
export const CODEX_HOOK_EVENTS = [
  'SessionStart', 'UserPromptSubmit', 'PreToolUse', 'PermissionRequest', 'PostToolUse',
  'PreCompact', 'PostCompact', 'SubagentStart', 'SubagentStop', 'Stop', 'Interrupt', 'SessionEnd',
];

export const CODEX_HOOK_WARNING = [
  'UNCONFIRMED. Codex CLI 0.153.4 reports feature `hooks` = stable and its hook payload field names',
  'match Claude Code (session_id, cwd, hook_event_name, tool_name, tool_input, tool_use_id, ...), but',
  'we could not make a hook fire in three configurations on 2026-09-17: `-c hooks.<Event>=[...]`,',
  '.codex/hooks/kiai.json beside the repo, and an isolated CODEX_HOME with [[hooks.PreToolUse]] plus',
  'bypass_hook_trust = true. Codex also gates hooks behind a trust review ("Hooks can run outside the',
  'sandbox after you trust them"). Until a hook is seen firing, use `kiai import codex` instead — it',
  'reads the session log Codex writes anyway and needs no configuration.',
];

function codexHooksBlock() {
  const cmd = `node "${PLUGIN_ROOT.split(path.sep).join('/')}/bin/kiai.mjs" record`;
  const hooks = {};
  for (const ev of CODEX_HOOK_EVENTS) {
    hooks[ev] = [{ hooks: [{ type: 'command', command: `${cmd} ${ev}`, commandWindows: `node "${PLUGIN_ROOT.split(path.sep).join('/')}/bin/kiai.mjs" record ${ev}`, timeout: 10 }] }];
  }
  return { hooks };
}

export /** One line describing what the committed anchors prove about this chain (UOW-123). */
const TRACK_NOTE = {
  committed: 'the anchors file is committed, so anyone with this history can check it',
  ignored: 'WARNING: .kiai/anchors.jsonl is IGNORED by a .gitignore rule (older setups ignored all of .kiai/), so `git add` refuses it and the anchor can never travel — remove that rule, or `git add -f .kiai/anchors.jsonl`',
  modified: 'WARNING: anchors.jsonl differs from the committed copy — commit it, otherwise only this machine holds the newest anchor',
  untracked: 'WARNING: anchors.jsonl is not in git yet — until it is committed and pushed it proves no more than chain.json',
  'no-commit': 'WARNING: this repository has no commit yet — the anchor is only a local file so far',
  'no-git': 'WARNING: no git repository here — an anchor outside version control can be deleted with the tail it witnesses',
};

/**
 * One line describing what the anchors prove about this chain right now (UOW-123, UOW-128).
 *
 * `ev` (UOW-128) is checked FIRST and on purpose. When the witness file is deleted, `a.used` is 0,
 * so every earlier version of this function printed `NOT ANCHORED` — the line that means "there was
 * never a witness" — for a repository whose witness had just been removed, and returned 0. Measured
 * 17/09: cut the tail, patch chain.json, `rm .kiai/anchors.jsonl`, and the gate went green.
 */
function anchorLine(v, track, ev) {
  const a = v.anchors;
  const note = TRACK_NOTE[track] ? ` — ${TRACK_NOTE[track]}` : '';
  if (ev && (ev.state === 'missing' || ev.state === 'shortened' || ev.state === 'rewritten')) return `ANCHOR EVIDENCE MISSING — ${ev.reason}`;
  if (!a || !a.used) return `NOT ANCHORED — no witness of these heads outside this machine (\`kiai anchor\`, then commit .kiai/anchors.jsonl); a clone cannot tell whether the tail was cut${a && a.bad ? ` [${a.bad} anchor line(s) ignored]` : ''}`;
  const l = a.latest;
  return a.ok
    ? `ANCHORED — ${a.used} anchor(s), latest ${l.ts} covering ${l.records} records; records written after it rest on this machine's chain.json alone${note}`
    : `ANCHOR MISMATCH — ${a.reason}`;
}

/**
 * One line about the signature on a decision record (UOW-127). Six states, never a guess:
 * SIGNED / UNSIGNED / SIGNATURE INVALID / SIGNER NOT ALLOWED / SIGNATURE UNCHECKABLE /
 * SIGNATURE NOT CHECKED.
 *
 * What a signature proves: this exact packet body was signed by a key that .kiai/allowed_signers
 * names, and has not changed since. What it does NOT prove: that the signer read it, that the agent
 * was not compromised, or that the work is correct.
 */
function signatureStatus(root, record, body) {
  const sigs = Array.isArray(record && record.sig) ? record.sig : [];
  if (!sigs.length) return { state: SIG_STATE.UNSIGNED, line: 'UNSIGNED — this decision carries no signature; anyone who could set an environment variable could have recorded it', results: [] };
  const af = allowedSignersFile(root);
  const results = sigs.map((sg) => ({ sig: sg, ...verifyBlob(body, sg && sg.blob, { allowedSignersFile: af }) }));
  const good = results.find((r) => r.state === SIG_STATE.SIGNED);
  if (good) {
    // Print only what was CHECKED. The identity comes from allowed_signers via find-principals and
    // the fingerprint from ssh-keygen's own output; the `alg`, `identity` and fingerprint a FILE
    // declares are attacker-controlled (that header is below the footer, covered by nothing), so a
    // declared field is never printed as if it had been verified — it produced
    // `SIGNED by cto@example.com — ml-dsa-87 … GATE 4 PASSED` on a packet Alice had signed.
    const declared = good.sig && good.sig.declared;
    const alg = good.verified_alg || (declared ? null : (good.sig && good.sig.alg)) || null;
    const fp = good.verified_fingerprint || (declared ? null : (good.sig && good.sig.key_fingerprint)) || null;
    const extra = results.length > 1 ? ` (${results.length} signatures on this packet)` : '';
    const bits = [alg && cell(alg, 40), fp && `key ${cell(fp, 60)}`].filter(Boolean).join(', ');
    // UOW-128. `SIGNED` alone says "a key in .kiai/allowed_signers signed this" — and that file sits in
    // the working tree the agent writes. Measured 17/09: `signers --add cto@example.com --key <own key>`
    // then sign, and this line read `SIGNED by cto@example.com` with a mathematically correct signature.
    // So ask the copy a human had to merge.
    const rev = reviewedSigner(root, body, good.sig && good.sig.blob);
    if (rev.state === 'no') {
      return { state: SIG_STATE.NOT_REVIEWED, reviewed: 'no', results,
        line: `${SIG_STATE.NOT_REVIEWED} — the signature by ${cell(good.identity, 80)} checks out, but ${cell(rev.reason, 200)}` };
    }
    const note = rev.state === 'unknown' ? `; REVIEW UNCHECKED — ${cell(rev.reason, 160)}` : '';
    return { state: SIG_STATE.SIGNED, reviewed: rev.state, results,
      line: `SIGNED by ${cell(good.identity, 80)}${bits ? ' — ' + bits : ''}${extra}${note}` };
  }
  const worst = results.find((r) => r.state === SIG_STATE.INVALID) || results[0];
  return { state: worst.state, line: `${worst.state} — ${cell(worst.detail || 'no detail', 300)}`, results };
}

async function main(argv = process.argv.slice(2), { cwd = process.cwd(), stdout = process.stdout, stderr = process.stderr } = {}) {
  const args = parseArgs(argv);
  const cmd = args._[0];
  const root = findRoot(cwd) ?? path.resolve(cwd);

  switch (cmd) {
    case 'init': {
      const { dir, created } = initFlight(root);
      stdout.write(`${created ? 'Created' : 'Already present'}: ${dir}\n`);
      // UOW-127: who may approve. Committed on purpose — it is reviewed like code, and a key
      // appearing in it is a visible commit.
      const asFile = allowedSignersFile(root);
      if (!fs.existsSync(asFile)) {
        fs.writeFileSync(asFile, ALLOWED_SIGNERS_HEADER);
        stdout.write(`Created: ${asFile} (empty — nobody may approve yet)\n`);
      }
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
      if (v.anchors.bad) warn.push(`${v.anchors.bad} anchor line(s) ignored — hash does not match, an edited anchor cannot make a chain look broken`);
      // UOW-127: a chain can be perfectly intact and still carry a decision nobody signed.
      // `verify` always reports the signature state; `--require-signature` makes it a gate.
      const decisions = readAll(root).filter((r) => Number.isInteger(r.seq) && r.event === 'decision');
      const sigLines = [];
      let sigBad = 0, sigMissing = 0, sigUnchecked = 0, sigUnreviewed = 0, sigReviewUnknown = 0;
      for (const d of decisions) {
        // Find the packet THIS decision covers. A later decision on the same UoW takes the same
        // file name and keeps the older one as `.prev-<sha8>.md`, so the file at `packet_path` is
        // often a NEWER packet. Checking a signature against it would report INVALID for a decision
        // that is perfectly sound — the same 'wrong alarm on a valid history' class review 123
        // caught on anchors. Match by the body hash the record itself carries.
        let body = null;
        let replaced = false;
        try {
          const pp = d.packet_path ? path.join(root, d.packet_path) : null;
          if (pp && fs.existsSync(pp)) {
            const b = packetBody(fs.readFileSync(pp, 'utf8'));
            if (b !== null && (!d.packet_body_sha256 || sha256(b) === d.packet_body_sha256)) body = b;
            else {
              // look through the kept copies for the one this decision actually sealed
              const dir = path.dirname(pp);
              const stem = path.basename(pp).replace(/\.md$/, '');
              for (const f of fs.existsSync(dir) ? fs.readdirSync(dir) : []) {
                if (!f.startsWith(stem + '.prev-') || !f.endsWith('.md')) continue;
                const cand = packetBody(fs.readFileSync(path.join(dir, f), 'utf8'));
                if (cand !== null && sha256(cand) === d.packet_body_sha256) { body = cand; break; }
              }
              if (body === null) replaced = true;
            }
          }
        } catch { /* unreadable: treated below as 'nothing to verify against' */ }
        if (replaced) {
          // The packet at this path is not the one this decision covers. That can be an honest
          // history (a later decision took the name) or an attacker deleting the evidence — from
          // here the two look identical, so this is NEVER reported as SIGNED and never counted as
          // a pass. The first version printed `SIGNED` here, which made `rm` a way to turn a
          // rejected forgery into a green gate.
          const signedHere = Array.isArray(d.sig) && d.sig.length;
          if (signedHere) {
            sigLines.push(`  seq ${d.seq} ${d.uow ?? '?'}: ${SIG_STATE.UNCHECKABLE} — the packet it covers is not at ${d.packet_path} and no kept copy matches its hash; the signature cannot be checked against anything`);
            sigUnchecked++;
          } else {
            sigLines.push(`  seq ${d.seq} ${d.uow ?? '?'}: ${SIG_STATE.UNSIGNED} — and the packet it covers is not at ${d.packet_path}`);
            sigMissing++;
          }
          continue;
        }
        if (body === null) {
          const signedHere = Array.isArray(d.sig) && d.sig.length;
          if (signedHere) {
            sigLines.push(`  seq ${d.seq} ${d.uow ?? '?'}: ${SIG_STATE.UNCHECKABLE} — the packet file is gone; a signature with nothing to check it against proves nothing`);
            sigUnchecked++;
          } else {
            sigLines.push(`  seq ${d.seq} ${d.uow ?? '?'}: ${SIG_STATE.UNSIGNED} — and no packet file to read`);
            sigMissing++;
          }
          continue;
        }
        const st = signatureStatus(root, d, body);
        sigLines.push(`  seq ${d.seq} ${d.uow ?? '?'}: ${st.line}`);
        if (st.state === SIG_STATE.INVALID || st.state === SIG_STATE.NOT_ALLOWED) sigBad++;
        else if (st.state === SIG_STATE.UNSIGNED) sigMissing++;
        else if (SIG_FAIL.has(st.state) && st.state !== SIG_STATE.NOT_REVIEWED) sigUnchecked++;
        // UOW-128. `uncheckable` means "the signature could not be checked". Whether the KEY was ever
        // reviewed is a different fact, so it gets its own words and its own counter: folding it into
        // `uncheckable` made `verify` report 2 uncheckable signatures it had in fact just checked.
        if (st.state === SIG_STATE.NOT_REVIEWED) sigUnreviewed++;
        else if (st.reviewed === 'unknown') sigReviewUnknown++;
      }
      const requireSig = Boolean(args['require-signature']);
      // UOW-128. Two questions, deliberately separate:
      //   evidence  — is the committed witness still here? (deleting it must never read as "no witness")
      //   anchored  — is there a witness at all? A chain nobody anchored CANNOT detect its own tail
      //               being cut: whoever writes the chain also writes chain.json. That is not a bug to
      //               patch, it is the shape of the problem, so `--require-anchor` lets CI refuse it.
      const ev = anchorsEvidence(root);
      const evGone = ev.state === 'missing' || ev.state === 'shortened' || ev.state === 'rewritten';
      const requireAnchor = Boolean(args['require-anchor']);
      if (v.ok) {
        const multi = v.chains.length > 1 ? ` in ${v.chains.length} chains (${v.chains.map((c) => `${c.writer || 'legacy'} ${c.count}`).join(', ')})` : '';
        stdout.write(`OK — ${v.count} records${multi}, head ${v.last.slice(0, 16)}…${warn.length ? ` (${warn.length} warning${warn.length > 1 ? 's' : ''})` : ''}\n`);
        stdout.write(anchorLine(v, anchorsTracked(root), ev) + '\n');
        if (decisions.length) {
          stdout.write(`decisions: ${decisions.length} (${sigBad} invalid, ${sigMissing} unsigned, ${sigUnchecked} uncheckable)\n`);
          if (sigUnreviewed || sigReviewUnknown) stdout.write(`signer review: ${sigUnreviewed} not reviewed, ${sigReviewUnknown} could not be checked\n`);
          for (const l of sigLines) stdout.write(l + '\n');
        }
        for (const w of warn) stdout.write(`WARN — ${w}\n`);
        if (evGone) { stderr.write(`kiai verify: ${ev.reason}\n`); return 1; }
        // The word that matters is COMMITTED. Review round 2 walked through the earlier version without
        // knowing anything about the format: cut the tail, patch chain.json, then run `kiai anchor` —
        // the real command — so the witness is perfectly self-consistent because the tool wrote it. It
        // witnesses the lie. Only a witness that went through a commit is evidence to anyone else.
        const tracked = anchorsTracked(root);
        if (requireAnchor && !(v.anchors && v.anchors.used && tracked === 'committed')) {
          // Two different people read this line: someone under attack, and someone who simply has not
          // committed yet. Review round 3: the first version used ONE sentence for both, so the benign
          // case was told that a tail had been cut and told to run `kiai anchor` — which they had just
          // done. Two situations, two sentences, each naming the one action that actually helps.
          if (!(v.anchors && v.anchors.used)) {
            stderr.write('kiai verify --require-anchor: this chain has no witness at all, so a cut tail cannot be detected here — run `kiai anchor`, then commit .kiai/anchors.jsonl\n');
            return 1;
          }
          const fix = tracked === 'ignored'
            ? 'a .gitignore rule is swallowing it (older setups ignored all of .kiai/) — remove that rule, or `git add -f .kiai/anchors.jsonl`'
            : 'commit .kiai/anchors.jsonl';
          stderr.write(`kiai verify --require-anchor: this chain HAS a witness, but it is ${tracked} — a witness its own writer can still change is not evidence to anyone else; ${fix}\n`);
          return 1;
        }
        if (sigBad) { stderr.write('kiai verify: a decision carries a signature that does not check out\n'); return 1; }
        // A gate must not go green because the evidence is missing. `--require-signature` fails on
        // "not signed" AND on "signed but uncheckable": deleting the packet is not a way to pass.
        if (requireSig && (sigMissing || sigUnchecked || sigUnreviewed)) {
          stderr.write(`kiai verify --require-signature: ${sigMissing} decision(s) not signed, ${sigUnchecked} whose signature cannot be checked, ${sigUnreviewed} signed by a key no reviewed commit contains\n`);
          return 1;
        }
        // A key nobody could have reviewed (no git, or allowed_signers never committed) is a GAP, not a
        // forgery — the same shape as an unanchored chain, and refused the same way: by its own flag.
        // `--require-signature` deliberately does NOT fail here, and the README says so rather than
        // letting anyone read that flag as proof a human approved anything.
        if (args['require-reviewed-signer'] && (sigUnreviewed || sigReviewUnknown)) {
          stderr.write(`kiai verify --require-reviewed-signer: ${sigUnreviewed} signer(s) not in a reviewed commit, ${sigReviewUnknown} that could not be checked (commit .kiai/allowed_signers)\n`);
          return 1;
        }
        if (sigUnchecked) stdout.write(`WARN — ${sigUnchecked} decision(s) carry a signature that could not be checked; see the lines above for why\n`);
        if (sigReviewUnknown) stdout.write(`WARN — ${sigReviewUnknown} signature(s) check out, but nothing here says the KEY was ever reviewed; commit .kiai/allowed_signers, and use --require-reviewed-signer to make this a failure\n`);
        return 0;
      }
      stdout.write(`BROKEN at seq ${v.broken ?? '?'} — ${v.reason} (${v.count} records read)\n`);
      stdout.write(anchorLine(v, anchorsTracked(root), ev) + '\n');
      for (const w of warn) stdout.write(`WARN — ${w}\n`);
      return 1;
    }
    case 'rules': {
      // The engine answers; this prints. Same split as the reference project's verdict.rb — "the
      // questionnaire decides; this explains" — and for the same reason: once a model is allowed to
      // decide whether a rule was broken, the rule is back to being advice.
      const sub = args._[1];
      const { rules, problems, dir, present } = loadRules(root);
      const rel = path.relative(root, dir).replace(/\\/g, '/') || RULES_DIR;
      const txt = (o, lang) => (o && (lang === 'vi' ? (o.vi || o.en) : (o.en || o.vi))) || '';
      // `cell` escapes for a markdown table (| becomes \| , * becomes a lookalike, ` becomes ').
      // Right there, and wrong on a terminal: review round 1 found `con-thuyen/**` printed as
      // `con-thuyen/∗∗` and a shell example's backticks turned into quotes, changing what the
      // command means. EVERY terminal print site uses `plain`; `cell` belongs to the markdown side.
      // wrong on a terminal: a regex printed through it cannot be copied back out. Here we strip
      // control characters and change nothing else.
      const plain = (v, max = 200) => String(v ?? '').replace(/[\u0000-\u001f\u007f]+/g, ' ').slice(0, max);
      const lang = args.lang === 'vi' ? 'vi' : 'en';

      if (!present && sub !== 'lint') {
        stderr.write(`kiai rules: no ${rel}/ in this repository — there are no rules here to follow\n`);
        return 2;
      }

      switch (sub) {
        case undefined:
        case 'list': {
          const fam = args.family ? String(args.family) : null;
          const rs = rules.filter((r) => !fam || r.family === fam)
            .sort((a, b) => (a.family || '').localeCompare(b.family || '') || a.rank - b.rank);
          if (args.json) { stdout.write(JSON.stringify(rs.map(({ _file, ...r }) => r), null, 2) + '\n'); return problems.length ? 1 : 0; }
          if (!rs.length) { stdout.write(`no rules${fam ? ` in family "${fam}"` : ''} under ${rel}/\n`); return 0; }
          let fam0 = null;
          for (const r of rs) {
            if (r.family !== fam0) { fam0 = r.family; stdout.write(`\n${fam0}\n`); }
            const force = (r.enforcement === 'block' ? 'BLOCK' : r.enforcement).padEnd(6);
            stdout.write(`  ${force}  ${r.id.padEnd(58)}  ${plain(txt(r.title, lang), 64)}\n`);
          }
          stdout.write(`\n${rs.length} rule(s) in ${rel}/${problems.length ? ` — ${problems.length} file problem(s), run \`kiai rules lint\`` : ''}\n`);
          return problems.length ? 1 : 0;
        }

        case 'show': {
          const id = args._[2];
          const r = rules.find((x) => x.id === id);
          if (!r) { stderr.write(`kiai rules show: no rule "${id ?? ''}" — try \`kiai rules search\`\n`); return 2; }
          if (args.json) { const { _file, ...rest } = r; stdout.write(JSON.stringify(rest, null, 2) + '\n'); return 0; }
          stdout.write(`${r.id}  [${r.family} #${r.rank}]  ${r.modality}  ${r.enforcement.toUpperCase()}\n`);
          stdout.write(`${txt(r.title, lang)}\n\n`);
          stdout.write(`${txt(r.statement, lang)}\n\n`);
          stdout.write(`WHY: ${txt(r.why, lang)}\n`);
          stdout.write(`FROM: ${r.source}\n`);
          // Examples first and in full: measured across 83 production prompts, `example` is the most
          // repeated heading by ~9x. The abstract sentence is what people argue about; the examples
          // are what they actually reason from.
          const ex = Array.isArray(r.examples) ? r.examples : [];
          if (ex.length) {
            stdout.write('\nEXAMPLES\n');
            for (const e of ex) {
              const mark = e.verdict === 'violates' ? 'NO ' : 'OK ';
              stdout.write(`  ${mark} ${plain(txt(e.text, lang), 110)}\n`);
              if (e.action) stdout.write(`      ${plain(JSON.stringify(e.action), 160)}\n`);
              if (e.note) stdout.write(`      ${plain(txt(e.note, lang), 110)}\n`);
            }
          }
          const cs = Array.isArray(r.applies_when) ? r.applies_when : [];
          if (cs.length) {
            stdout.write('\nAPPLIES WHEN (all of)\n');
            for (const c of cs) stdout.write(`  ${c.signal} ${c.op}${c.value === undefined ? '' : ' ' + plain(c.value, 160)}\n`);
          } else {
            stdout.write('\nAPPLIES WHEN: nothing machine-readable — this rule is for reading, not a gate\n');
          }
          if (Array.isArray(r.refs) && r.refs.length) stdout.write(`\nSEE ALSO: ${r.refs.join(', ')}\n`);
          return 0;
        }

        case 'search': {
          const q = args._.slice(2).join(' ') || String(args.q || '');
          const hits = searchRules(rules, q, { limit: Number(args.limit) > 0 ? Number(args.limit) : 10 });
          if (args.json) { stdout.write(JSON.stringify(hits.map((h) => ({ id: h.rule.id, score: h.score })), null, 2) + '\n'); return 0; }
          if (!hits.length) { stdout.write(`no rule matches "${plain(q, 60)}"\n`); return 1; }
          for (const h of hits) stdout.write(`  ${h.rule.id.padEnd(58)}  ${plain(txt(h.rule.title, lang), 64)}\n`);
          stdout.write(`\n${hits.length} match(es) — \`kiai rules show <id>\` for the examples\n`);
          return 0;
        }

        case 'check': {
          // The action to judge, as plain signals. A hook can pass the same shape as JSON on stdin.
          const action = {};
          for (const k of ['tool', 'command', 'path', 'event', 'uow', 'agent']) {
            if (args[k] !== undefined) action[k] = String(args[k]);
          }
          // `--action '<json>'` carries the payload; `--json` means "print JSON", as it does in every
          // other subcommand. Reading one flag two ways is how a tool teaches people to distrust it.
          if (typeof args.action === 'string') {
            try { Object.assign(action, JSON.parse(args.action)); } catch {
              stderr.write('kiai rules check --action: not valid JSON\n');
              return 2;
            }
          }
          if (args.stdin) {
            // A Claude Code hook payload. Its field names differ from the flags, so map them here and
            // nowhere else: `tool_input` is free-form per tool, so flatten the two fields any rule has
            // ever needed rather than inventing a schema the payload does not have.
            const payload = readStdin();
            try {
              const h = JSON.parse(payload || '{}');
              if (h.tool_name) action.tool = String(h.tool_name);
              if (h.hook_event_name) action.event = String(h.hook_event_name);
              const ti = h.tool_input || {};
              if (ti.command !== undefined) action.command = String(ti.command);
              if (ti.file_path !== undefined) action.path = String(ti.file_path);
            } catch {
              // A hook that cannot parse its own input must not become a way to stop work. It says so
              // and gets out of the way: this path guards against mistakes, not against an attacker
              // who can already write the payload.
              stderr.write('kiai rules check --stdin: could not parse the hook payload; letting the action through\n');
              return 0;
            }
          }
          if (args.stdin && !Object.keys(action).length) {
            // Running as a hook with nothing usable in the payload. Returning 2 here would block
            // EVERY tool call — the fastest possible way to get this hook switched off, and then it
            // protects nothing at all. A gate that cannot see the action does not get to refuse it.
            return 0;
          }
          if (!Object.keys(action).length) {
            stderr.write('kiai rules check: nothing to check — pass at least one of --tool --command --path --event\n');
            return 2;
          }
          // A rule file that does not load is a rule that does not protect, and staying quiet about
          // it makes this command answer CLEAR for a repository whose whole rule set is broken —
          // green for lack of evidence, the failure this project has now hit in four places. It goes
          // to stderr rather than failing: refusing every action because one file has a typo is how
          // a gate gets switched off.
          if (problems.length) {
            stderr.write(`kiai rules check: ${problems.length} rule file problem(s) — those rules are NOT enforced; run \`kiai rules lint\`\n`);
          }
          const { decision, hits } = evaluate(rules, action);
          if (args.json) {
            stdout.write(JSON.stringify({
              decision,
              action,
              hits: hits.map((r) => ({ id: r.id, enforcement: r.enforcement, title: r.title, statement: r.statement, why: r.why })),
            }, null, 2) + '\n');
            return decision === 'block' ? 2 : 0;
          }
          if (args.quiet && decision === 'clear') return 0;
          if (decision === 'clear') { stdout.write('CLEAR — no rule here applies to that action\n'); return 0; }
          for (const r of hits) {
            const head = r.enforcement === 'block' ? 'BLOCKED BY' : r.enforcement === 'warn' ? 'WARNING' : 'ADVICE';
            stdout.write(`${head} ${r.id} — ${plain(txt(r.title, lang), 110)}\n`);
            stdout.write(`  ${plain(txt(r.statement, lang), 200)}\n`);
            stdout.write(`  why: ${plain(txt(r.why, lang), 200)}\n`);
          }
          // exit 2, not 1: a hook can tell "this action is forbidden" apart from "the tool failed".
          if (decision === 'block') { stderr.write(`kiai rules check: blocked by ${hits[0].id}\n`); return 2; }
          return 0;
        }

        case 'lint': {
          // The gate on the rule files themselves. Modelled on data_spec.rb in the reference project:
          // a bad hand-edit fails here, not in front of whoever the rule was supposed to protect.
          if (!present) { stderr.write(`kiai rules lint: no ${rel}/ — nothing to lint\n`); return 2; }
          const setErr = lintSet(rules);
          const exErr = checkExamples(rules);
          const near = nearMissReport(rules);
          const cond = unexercisedConditions(rules);
          const errors = [...problems, ...setErr, ...exErr, ...near.errors];
          const warnings = [...near.warnings, ...cond];
          if (args.json) {
            stdout.write(JSON.stringify({ rules: rules.length, errors, warnings }, null, 2) + '\n');
            return errors.length ? 1 : 0;
          }
          for (const e of errors) stdout.write(`ERROR  ${e}\n`);
          for (const w of warnings) stdout.write(`WARN   ${w}\n`);
          if (errors.length) {
            stderr.write(`kiai rules lint: ${errors.length} error(s) in ${rel}/\n`);
            return 1;
          }
          stdout.write(`OK — ${rules.length} rule(s), ${warnings.length} warning(s); every example replayed through the engine agrees with the verdict it claims\n`);
          return 0;
        }

        default:
          stderr.write(`kiai rules: unknown subcommand "${sub}" (list, show, search, check, lint)\n`);
          return 2;
      }
    }
    case 'status': {
      const records = readAll(root);
      const v = verifyChain(root);
      const sessions = summarize(records.filter((r) => Number.isInteger(r.seq)));
      stdout.write(`flight dir: ${flightDir(root)}\nthis writer: ${writerId(root)}\nrecords: ${records.length}\nsessions: ${sessions.length}\nchains: ${v.chains.length}\n`);
      const byWriter = new Map();
      for (const r of records) if (r.via === 'import') byWriter.set(r.writer, (byWriter.get(r.writer) || 0) + 1);
      for (const c of v.chains) {
        // An imported chain is weaker evidence; `status` must not present it as the same thing.
        const n = byWriter.get(c.writer) || 0;
        const note = n ? `, ${n} IMPORTED (read back from an agent log, not observed live)` : '';
        stdout.write(`  ${c.writer || '(legacy)'}: ${c.count} records${note}, ${c.ok ? 'intact' : 'BROKEN at seq ' + c.broken}\n`);
      }
      if (v.dropped) stdout.write(`dropped: ${v.dropped}\n`);
      const la = v.anchors.latest;
      // THIRD twin of the same pair. `verify` and `accept --check` both report a witness that was
      // deleted or rewritten; `status` printed `anchors: 1 … anchors file: modified` on the very same
      // tampered tree — and `modified` is the same word it uses for "you just anchored and have not
      // committed yet", which is the harmless case. Same fact, same sentence, in every command.
      const sev = anchorsEvidence(root);
      if (sev.state === 'missing' || sev.state === 'shortened' || sev.state === 'rewritten') {
        stdout.write(`anchors: ANCHOR EVIDENCE MISSING — ${sev.reason}\n`);
      } else stdout.write(`anchors: ${v.anchors.used}${v.anchors.bad ? ` (+${v.anchors.bad} ignored)` : ''}${la ? ` — latest ${la.ts} by ${la.by || '?'}, ${la.records} records${la.git && la.git.commit ? `, git ${String(la.git.commit).slice(0, 8)}${la.git.dirty ? '+dirty' : ''}` : ''}` : ' — none (run `kiai anchor`)'}\nanchors file: ${anchorsTracked(root)}\n`);
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
    case 'anchor': {
      if (!fs.existsSync(path.join(root, '.kiai'))) { stderr.write(`kiai anchor: no .kiai/ at ${root} — run \`kiai init\` first\n`); return 2; }
      const v0 = verifyChain(root);
      if (!v0.ok) { stderr.write(`kiai anchor: refusing — chain BROKEN at seq ${v0.broken ?? '?'}: ${v0.reason}\n`); return 1; }
      if (!v0.count) { stderr.write('kiai anchor: refusing — no records to anchor yet\n'); return 1; }
      const a = appendAnchor(root, buildAnchor(root, { by: args.by && args.by !== true ? String(args.by) : null, note: args.note && args.note !== true ? String(args.note) : null }));
      stdout.write(`ANCHORED — ${a.records} records in ${a.writers.length} chain(s), head ${a.all_last.slice(0, 16)}… → ${path.relative(root, anchorsFile(root)).replace(/\\/g, '/')} line ${readAnchors(root).length}\n`);
      const track = anchorsTracked(root);
      stdout.write(a.git.commit
        ? `  git ${a.git.commit.slice(0, 8)}${a.git.dirty ? ' (working tree dirty)' : ''} on ${a.git.branch || 'detached'}\n`
        : a.git.repo ? '  git repository with no commit yet\n' : '  not a git repository\n');
      stdout.write(`  NEXT: commit .kiai/anchors.jsonl and push it — ${TRACK_NOTE[track] || track}\n`);
      return 0;
    }
    case 'hooks': {
      const agent = args.agent && args.agent !== true ? String(args.agent).toLowerCase() : 'claude';
      if (agent === 'claude' || agent === 'claude-code') {
        stdout.write(JSON.stringify(hooksBlock({ rules: Boolean(args.rules) }), null, 2) + '\n');
        return 0;
      }
      if (agent === 'codex' || agent === 'codex-cli') {
        for (const line of CODEX_HOOK_WARNING) stderr.write(`kiai hooks --agent codex: ${line}\n`);
        stdout.write(JSON.stringify(codexHooksBlock(), null, 2) + '\n');
        return 0;
      }
      stderr.write(`kiai hooks: unknown --agent "${agent}" (claude|codex)\n`);
      return 2;
    }
    case 'import': {
      const which = String(args._[1] || '').toLowerCase();
      if (which !== 'codex') {
        stderr.write('usage: kiai import codex [--home DIR] [--session FILE] [--since DATE] [--dry-run] [--json]\n');
        return 2;
      }
      if (!fs.existsSync(path.join(root, '.kiai'))) {
        stderr.write(`kiai import: no .kiai/ at ${root} — run \`kiai init\` first\n`);
        return 2;
      }
      let res;
      try {
        res = importCodex(root, {
          home: args.home && args.home !== true ? path.resolve(cwd, String(args.home)) : null,
          since: args.since && args.since !== true ? String(args.since) : null,
          sessionFile: args.session && args.session !== true ? path.resolve(cwd, String(args.session)) : null,
          dryRun: Boolean(args['dry-run']),
        });
      } catch (e) {
        stderr.write(`kiai import codex: ${e.message}\n`);
        return e.code === 'KIAI_NO_SESSIONS' ? 2 : 1;
      }
      if (args.json) { stdout.write(JSON.stringify(res, null, 2) + '\n'); return res.failed ? 1 : 0; }
      stdout.write(`${res.dry_run ? 'DRY RUN — nothing written. ' : ''}imported ${res.imported} record(s) from ${res.files_read} of ${res.files_seen} rollout file(s)\n`);
      stdout.write(`  chain: ${res.writer} — kept apart from the hook chain on purpose: an imported record is weaker evidence (see README, "What import proves")\n`);
      if (res.duplicates) stdout.write(`  already imported: ${res.duplicates} line(s) skipped\n`);
      if (res.bad_lines) stdout.write(`  unparseable lines in the source logs: ${res.bad_lines}\n`);
      for (const s of res.sessions) stdout.write(`  ${s.file}: ${s.records} record(s)\n`);
      const reasons = {};
      for (const sk of res.skipped) reasons[sk.reason] = (reasons[sk.reason] || 0) + 1;
      for (const [reason, n] of Object.entries(reasons)) stdout.write(`  skipped ${n} file(s): ${reason}\n`);
      const kinds = Object.entries(res.skipped_kinds).sort((a, b) => b[1] - a[1]).slice(0, 8);
      if (kinds.length) stdout.write(`  log lines not recorded: ${kinds.map(([k, n]) => `${k} ×${n}`).join(', ')}\n`);
      if (res.failed) {
        stderr.write(`kiai import codex: STOPPED at ${res.failed.file} line ${res.failed.line}: ${res.failed.reason}\n`);
        stderr.write('  what was already written is sealed and counted; run the command again to continue from there\n');
        return 1;
      }
      return 0;
    }
    case 'signers': {
      if (!fs.existsSync(path.join(root, '.kiai'))) { stderr.write(`kiai signers: no .kiai/ at ${root} — run \`kiai init\` first\n`); return 2; }
      if (args.add && args.add !== true) {
        const keyArg = args.key && args.key !== true ? path.resolve(cwd, String(args.key)) : '';
        if (!keyArg) { stderr.write('kiai signers --add IDENTITY --key FILE.pub  (the PUBLIC key)\n'); return 2; }
        const r = addSigner(root, String(args.add), keyArg);
        if (!r.ok) { stderr.write(`kiai signers --add: ${r.error}\n`); return 2; }
        stdout.write(`added ${r.identity} (${r.keytype}) to ${path.relative(root, r.file).split(path.sep).join('/')}\n`);
        stdout.write('  COMMIT this file: it is the list of people allowed to approve, and it is reviewed like code.\n');
        return 0;
      }
      const as = readAllowedSigners(root);
      if (as.unreadable) {
        stderr.write(`kiai signers: cannot read ${path.relative(root, as.file).split(path.sep).join('/')}: ${as.unreadable}\n`);
        return 2;
      }
      if (!as.exists) {
        stdout.write(`no ${path.relative(root, as.file).split(path.sep).join('/')} — nobody may approve in this repository yet\n`);
        stdout.write('  kiai signers --add you@example.com --key ~/.ssh/id_ed25519.pub\n');
        return 0;
      }
      stdout.write(`${path.relative(root, as.file).split(path.sep).join('/')}: ${as.entries.length} signer(s) in ${as.lines} line(s)\n`);
      const fps = new Map();
      for (const e of as.entries) {
        const fp = fingerprintOfKeyLine(`${e.keytype} ${e.key}`);
        const dup = fp && fps.has(fp) ? ` \u26a0 SAME KEY as ${fps.get(fp)} — find-principals returns the FIRST line, so that name is what signatures will report` : '';
        if (fp && !fps.has(fp)) fps.set(fp, e.identity);
        stdout.write(`  ${cell(e.identity, 80)}  ${e.keytype}  ${fp || 'fingerprint unavailable'}  line ${e.line}${dup}\n`);
      }
      for (const m of as.malformed) stderr.write(`  WARN line ${m.line} is not a valid allowed_signers entry: ${cell(m.text, 80)}\n`);
      const av = sshKeygenAvailable();
      if (!av.ok) stderr.write(`  WARN ${av.reason} — signatures cannot be made or checked on this machine\n`);
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
          const namedMd = String(j.md_path || '');
          // Same rule as the signature side: a companion is a NAME beside this file, never a path.
          // `../../secret/x` turned --check into a file-existence oracle, and the output printed only
          // the basename, hiding that it had left the directory.
          const namedOk = Boolean(namedMd) && !/[\\/]/.test(namedMd) && namedMd !== '..' && namedMd !== '.';
          const mdPath = namedOk ? path.join(path.dirname(file), namedMd) : null;
          let mdText = null;
          if (mdPath) { try { mdText = fs.readFileSync(mdPath, 'utf8'); } catch { /* missing */ } }
          ok = mdText !== null && sha256(mdText) === j.md_sha256;
          const why = !namedOk
            ? `md_path must name a file next to this one, not a path: ${cell(namedMd || '(empty)', 80)}`
            : mdText === null ? `companion ${cell(namedMd, 80)} not found`
              : 'md_sha256 does not match the .md next to it';
          stdout.write(ok ? `OK — .json points at ${cell(namedMd, 80)} (md_sha256 matches)\n` : `MISMATCH — ${why}\n`);
        } else {
          const c = checkPacket(text);
          ok = c.ok;
          // Say what the footer is worth: it proves internal consistency, not provenance.
          stdout.write(ok ? `OK (footer only) — packet hash ${c.expected.slice(0, 16)}… matches its own body; whether anyone stands behind it is the SEALED/SIGNED lines below\n` : `MISMATCH — ${c.reason || `footer ${String(c.expected).slice(0, 16)}… but content hashes to ${String(c.actual).slice(0, 16)}…`}\n`);
        }
        const chainRoot = findRoot(path.dirname(file)) ?? findRoot(cwd);
        // TWIN of the two calls in `verify`. It was missed, and review round 1 of UOW-128 showed what
        // that costs: on the same tampered tree, `verify` said ANCHOR EVIDENCE MISSING while
        // `accept --check` — the command a human or CI actually runs at the moment of acceptance —
        // still printed `NOT ANCHORED`, the exact sentence this UoW exists to stop being printed.
        let evAccept = null;
        if (chainRoot) {
          evAccept = anchorsEvidence(chainRoot);
          const cv = verifyChain(chainRoot);
          stdout.write(anchorLine(cv, anchorsTracked(chainRoot), evAccept) + '\n');
        }
        let sigFailed = false;
        let anyUnsigned = false;
        let noEvidence = null;
        let reviewUnknown = false;
        // Why the gate refuses, in the words of the state that refused it. Defaulting to "this decision
        // is not signed" sent the reader looking for a missing signature when the real answer was that
        // the signature was fine and the KEY had never been reviewed.
        let unsignedWhy = null;
        // First: the signatures the FILE carries. This works even when the body was edited and the
        // footer recomputed, which is exactly the case that defeats a lookup by hash.
        // A `.json` carries no `Hash:` footer: its signature covers the BODY OF THE .md it names.
        // Verifying the JSON text against that signature reported SIGNATURE INVALID on a file the
        // tool had just written correctly — a false alarm on a valid artifact, the same class this
        // UoW has now hit three times.
        let sigText = text;
        let sigUnavailable = null;
        if (file.endsWith('.json')) {
          sigUnavailable = 'this .json has no body of its own — check the .md it points at';
          try {
            const j = JSON.parse(text);
            // `md_path` comes out of an UNTRUSTED file. Unfiltered, `../../secret/x` made `--check`
            // a file-existence-and-hash oracle, and the output printed only the basename — hiding
            // that it had left the packet directory. A companion file is a NAME, never a path.
            const named = String(j.md_path || '');
            if (named && !/[\\/]/.test(named) && named !== '..' && named !== '.') {
              const mdSide = path.join(path.dirname(file), named);
              if (fs.existsSync(mdSide)) { sigText = fs.readFileSync(mdSide, 'utf8'); sigUnavailable = null; }
            } else if (named) {
              sigUnavailable = `md_path must name a file next to this one, not a path (${cell(named, 80)})`;
            }
          } catch { /* already reported as invalid JSON above */ }
        }
        const own = parsePacketSignatures(sigText);
        // A `.json` carries NO signature of its own. The signature belongs to the `.md` it names, and
        // the only link between the two files is `md_sha256` — a field written inside the .json by
        // whoever wrote it. Saying plain `SIGNED` here let a .json whose own `decision` read
        // "reject by nobody" print `SIGNED by alice@example.com` and exit 0.
        const borrowed = file.endsWith('.json');
        if (own.length && sigUnavailable) {
          stdout.write(`  ${SIG_STATE.NOT_CHECKED} — ${sigUnavailable}\n`);
        } else if (own.length) {
          const bodyForSig = packetBody(sigText);
          const st = signatureStatus(chainRoot ?? findRoot(cwd) ?? path.resolve(cwd), { sig: own }, bodyForSig === null ? sigText : bodyForSig);
          if (borrowed && st.state === SIG_STATE.SIGNED) {
            stdout.write(`  ${st.line.replace('SIGNED by', 'SIGNED (of the .md it points at) by')}\n`);
            stdout.write('  this .json carries no signature of its own; its only link to that .md is the md_sha256 written inside it\n');
          } else stdout.write(`  ${st.line}\n`);
          if (st.state === SIG_STATE.INVALID || st.state === SIG_STATE.NOT_ALLOWED) sigFailed = true;
          else if (SIG_FAIL.has(st.state)) anyUnsigned = true;
        }
        if (chainRoot && fs.existsSync(flightDir(chainRoot))) {
          const sealing = findSealing(readAll(chainRoot), text);
          if (sealing.length) {
            const body = packetBody(sigText);
            for (const r of sealing) {
              stdout.write(`SEALED — decision record seq ${r.seq} (${r.writer || 'legacy'}): ${String(r.decision).toUpperCase()} by ${r.by} at ${r.ts}${r.via === 'agent-session' ? ' ⚠ via agent session' : ''}\n`);
              // UOW-127: 'sealed' only says a record carries this hash. 'signed' says a named key stood
              // behind it. Report them separately — they are different claims.
              const st = body === null && sigUnavailable
                ? { state: SIG_STATE.NOT_CHECKED, line: `${SIG_STATE.NOT_CHECKED} — ${sigUnavailable}` }
                : signatureStatus(chainRoot, r, body === null ? sigText : body);
              stdout.write(`  ${st.line}\n`);
              // Only a signature that FAILED fails the check. "Could not check it" is a gap, and a
              // gap is refused by --require-signature — the same rule `verify` follows.
              if (st.state === SIG_STATE.INVALID || st.state === SIG_STATE.NOT_ALLOWED) sigFailed = true;
              else if (st.state === SIG_STATE.UNSIGNED) anyUnsigned = true;
              else if (SIG_FAIL.has(st.state)) { anyUnsigned = true; unsignedWhy = unsignedWhy || st.line; }
              // TWIN of the counting in `verify` above — same rule, spelled the same way (UOW-127 v4).
              if (st.reviewed === 'unknown') reviewUnknown = true;
            }
          } else {
            stdout.write('NOT SEALED — no decision record in this repository carries this file\'s hash (a draft, a re-encoded copy, or a packet from another repository)\n');
            // TWIN of the `NO CHAIN` branch below, and it was missed once: for a `.json`, `own` is ALWAYS
            // the borrowed signature of the .md beside it, so `!own.length` is never true and this branch
            // left the gate green on a .json no record here carries.
            if (!own.length || borrowed) noEvidence = borrowed
              ? 'this .json has no signature of its own and no decision record here carries its hash'
              : 'this packet is not sealed by any decision record here, and carries no signature of its own';
          }
        } else {
          const why = 'no flight record to check this packet against (run this inside the repository that produced it)';
          // Without a chain, a .json is vouched for by nothing: its signature belongs to another file.
          if (!own.length || borrowed) noEvidence = borrowed
            ? 'this .json has no signature of its own and there is no flight record here to vouch for its contents'
            : why;
          stdout.write('NO CHAIN — ' + why + (own.length && !borrowed ? '; the signature the file carries was checked above' : '') + '\n');
        }
        // `--require-signature` is a GATE on the file in front of you. A footer that recomputes is
        // not evidence of anything: an attacker who writes their own packet controls the footer too.
        // So 'not sealed' and 'no chain to check against' fail the gate exactly like 'not signed'.
        // A deleted or rewritten witness is not a warning here either: same fact, same exit code as
        // `verify`, so the two commands can never disagree about the same tree again.
        if (evAccept && (evAccept.state === 'missing' || evAccept.state === 'shortened' || evAccept.state === 'rewritten')) {
          stderr.write(`kiai accept --check: ${evAccept.reason}\n`);
          return 1;
        }
        if (args['require-reviewed-signer'] && reviewUnknown) {
          stderr.write('kiai accept --check --require-reviewed-signer: the signature checks out, but nothing here says the key was ever reviewed (commit .kiai/allowed_signers)\n');
          return 1;
        }
        if (args['require-signature'] && (anyUnsigned || noEvidence)) {
          stderr.write(`kiai accept --check --require-signature: ${noEvidence || unsignedWhy || 'this decision is not signed'}\n`);
          return 1;
        }
        return ok && !sigFailed ? 0 : 1;
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
      // Default: <root>/.kiai/acceptance — committed with the code, found by KIAI Monitor (UOW-122). --out overrides.
      // No black box here (no .kiai/) ⇒ write next to you and say so; `accept` never creates a .kiai/ of its own (review 122 N6).
      const hasBox = fs.existsSync(path.join(root, '.kiai'));
      const outDir = args.out && args.out !== true ? path.resolve(cwd, String(args.out)) : hasBox ? path.join(root, '.kiai', 'acceptance') : path.resolve(cwd);
      if (!hasBox && !(args.out && args.out !== true)) stderr.write(`kiai accept: no .kiai/ at ${root} — writing the packet into the current directory (run \`kiai init\` to get a black box)\n`);
      fs.mkdirSync(outDir, { recursive: true });
      // Drafts and decisions never share a file name, so a later draft cannot overwrite a sealed packet (review 120 P3).
      const base = decision ? `acceptance-${uow}` : `acceptance-${uow}.draft`;
      const mdPath = path.join(outDir, `${base}.md`);
      const jsonPath = path.join(outDir, `${base}.json`);
      // Sign BEFORE the hashes are taken. The signature covers the BODY (what the `Hash:` footer
      // covers), and is then appended BELOW that footer — so the signed text never changes, and the
      // packet still carries its own signature instead of hiding it in the chain.
      let sig = null;
      if (decision && args.sign) {
        const keyFile = args.key && args.key !== true ? path.resolve(cwd, String(args.key)) : (process.env.KIAI_SIGN_KEY || '');
        const bodyText = packetBody(md);
        const r = bodyText === null ? { ok: false, error: 'packet has no Hash: footer to sign' } : signBlob(bodyText, { keyFile });
        if (!r.ok) {
          stderr.write(`kiai accept --sign: ${r.error}\n`);
          stderr.write('  nothing was sealed. A decision that claims to be signed must actually be signed.\n');
          return 2;
        }
        sig = [{ alg: r.alg, identity: args.by && args.by !== true ? String(args.by) : by, key_fingerprint: r.fingerprint, namespace: NAMESPACE, blob: r.blob, signed_at: new Date().toISOString() }];
      } else if (args.sign) {
        // A flag that silently does nothing is a flag that lies about the packet it produced.
        stderr.write('kiai accept --sign: --sign only means something together with --decision; a draft is not signed\n');
        return 2;
      }
      const mdSigned = sig
        ? md + '\n' + sig.map((g) => `Signature (${g.alg}, ${g.identity}, key ${g.key_fingerprint}, namespace ${g.namespace}):\n${g.blob.trim()}\n`).join('\n')
          + `\nVerify: kiai accept --check <this file>   (needs .kiai/allowed_signers from this repository)\n`
        : md;
      const packetSha = sha256(mdSigned);
      const footer = checkPacket(mdSigned).expected;
      const jsonText = JSON.stringify({ ...pkg, signature: sig, md_sha256: packetSha, md_path: path.basename(mdPath) }, null, 2) + '\n';
      const jsonSha = sha256(jsonText);
      let sealed = null;
      let anchored = null;
      if (decision) {
        // Seal FIRST (into a temp pair), then move into place: no APPROVED packet can exist on disk without its record (P2).
        const tmpMd = mdPath + '.tmp'; const tmpJson = jsonPath + '.tmp';
        fs.writeFileSync(tmpMd, mdSigned); fs.writeFileSync(tmpJson, jsonText);
        try {
          sealed = appendRecord(root, {
            ts: new Date().toISOString(), event: 'decision', agent: 'kiai-cli', session: null, cwd: root, uow,
            decision, by, note, via,
            ...(sig ? { sig } : {}),
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
        // UOW-123: the packet travels in git, so anchor the chain in the same breath — the committed
        // anchor is what lets a clone see a cut tail. Never fatal: a packet without an anchor is still valid.
        try { anchored = appendAnchor(root, buildAnchor(root, { by, note: `sealed ${uow}` })); } catch (e) { stderr.write(`kiai accept: packet sealed but anchor not written (${e.message})\n`); }
      } else {
        fs.writeFileSync(mdPath, mdSigned); fs.writeFileSync(jsonPath, jsonText);
      }
      stdout.write(`${pkg.draft ? 'DRAFT' : pkg.decision.decision.toUpperCase()} packet for ${uow}: ${mdPath}\n`);
      if (sig) stdout.write(`  signed by ${sig[0].identity} (${sig[0].alg}, key ${sig[0].key_fingerprint}) — the signature is in the packet, below the Hash: footer\n`);
      stdout.write(`  records in scope: ${pkg.records_in_scope} · files: ${pkg.files.length} (${pkg.files.filter((f) => f.disk === 'matches' || f.disk === 'matches-eol').length} match, ${pkg.files.filter((f) => f.disk === 'changed-after').length} changed after, ${pkg.files.filter((f) => f.disk === 'missing').length} missing) · tests observed: ${pkg.tests.length}\n`);
      if (pkg.warnings.length) stdout.write(`  warnings: ${pkg.warnings.join(', ')}\n`);
      stdout.write(`  packet file sha256: ${packetSha} (the Hash: footer inside covers the body only)\n`);
      if (sealed) stdout.write(`  sealed into flight record: seq ${sealed.seq} (${sealed.writer}) hash ${sealed.hash.slice(0, 16)}…${via === 'agent-session' ? ' ⚠ recorded from inside an agent session' : ''}\n`);
      if (anchored) stdout.write(`  anchored: ${anchored.records} records → .kiai/anchors.jsonl (commit it together with the packet)\n`);
      return 0;
    }
    default:
      stderr.write('usage: kiai <init|record|note|verify|anchor|status|report|import|hooks|accept|rules>\n');
      stderr.write('  import codex [--home DIR] [--session FILE] [--since DATE] [--dry-run] [--json]\n');
      stderr.write('  hooks [--agent claude|codex]\n');
      stderr.write('  signers --list | --add IDENTITY --key FILE.pub\n');
      return cmd ? 2 : 0;
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().then((code) => process.exit(code), (e) => { process.stderr.write(String(e && e.stack || e) + '\n'); process.exit(1); });
}
