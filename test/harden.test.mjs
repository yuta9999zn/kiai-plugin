// Tests for UOW-128: KIAI against someone who can write KIAI's own files.
//
// Every case here reproduces something that was MEASURED to work on 2026-09-17, in a throwaway repo,
// against the shipped tool. The three that worked:
//   - cut the chain's tail, patch chain.json (two fields) — `OK`, exit 0. Not fixable locally: whoever
//     writes the chain writes chain.json too. Only an anchor, or `--require-anchor`, answers it.
//   - delete .kiai/anchors.jsonl although git holds it — back to `NOT ANCHORED`, exit 0.
//   - `signers --add cto@example.com --key <own key>` then sign — `SIGNED by cto@example.com`, exit 0.
//
// Offline, temp dirs only. Keys are generated per-test in mkdtemp — ~/.ssh is NEVER read or written.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { appendRecord, buildRecord, anchorsEvidence, anchorHash, verifyChain } from '../lib/flight.mjs';
import { sshKeygenAvailable, SIG_STATE, SIG_FAIL } from '../lib/sign.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CLI = path.join(HERE, '..', 'bin', 'kiai.mjs');
const HAVE_SSH = sshKeygenAvailable().ok;
const HAVE_GIT = spawnSync('git', ['--version'], { stdio: 'ignore' }).status === 0;
/** A machine without the tool must SKIP with a reason, never pass quietly. */
const needSsh = { skip: HAVE_SSH && HAVE_GIT ? false : 'ssh-keygen or git not available on this machine' };
const needGit = { skip: HAVE_GIT ? false : 'git not available on this machine' };

function runCli(args, { cwd, env = {}, timeout = 30000 } = {}) {
  const clean = { ...process.env };
  delete clean.CLAUDECODE; delete clean.CLAUDE_CODE_ENTRYPOINT; delete clean.KIAI_SIGN_KEY;
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [CLI, ...args], { cwd, env: { ...clean, ...env }, stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = ''; let stderr = '';
    const timer = setTimeout(() => { child.kill('SIGKILL'); reject(new Error('CLI hung: ' + args.join(' '))); }, timeout);
    child.stdout.on('data', (d) => { stdout += d; });
    child.stderr.on('data', (d) => { stderr += d; });
    child.on('close', (code) => { clearTimeout(timer); resolve({ code, stdout, stderr }); });
    child.stdin.end('');
  });
}

const git = (cwd, args) => spawnSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', ...args], { cwd, stdio: 'ignore' });

/** A repo with a chain and a first commit. `gitInit: false` gives the no-git case on purpose. */
function tmpRepo({ gitInit = true } = {}) {
  const dir = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'kiai-h-')));
  if (gitInit) { git(dir, ['init', '-q', '.']); git(dir, ['commit', '-q', '--allow-empty', '-m', 'init']); }
  fs.mkdirSync(path.join(dir, '.kiai'), { recursive: true });
  const env = { KIAI_UOW: 'UOW-900' };
  const t = (i) => new Date(Date.UTC(2026, 8, 17, 1, 0, i));
  for (const [i, ev] of ['SessionStart', 'PreToolUse', 'PostToolUse', 'Stop'].entries()) {
    appendRecord(dir, buildRecord({ session_id: 's1', hook_event_name: ev }, { cwd: dir, root: dir, env, now: t(i + 1) }));
  }
  return dir;
}

function makeKey(name = 'k') {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kiai-key-'));
  const file = path.join(dir, name);
  const r = spawnSync('ssh-keygen', ['-q', '-t', 'ed25519', '-f', file, '-N', '', '-C', name], { stdio: 'ignore' });
  assert.equal(r.status, 0, 'ssh-keygen must be able to make a throwaway key');
  return file;
}

const flightFile = (root) => {
  const base = path.join(root, '.kiai', 'flight');
  const w = fs.readdirSync(base)[0];
  const f = fs.readdirSync(path.join(base, w)).find((x) => x.endsWith('.jsonl'));
  return { jsonl: path.join(base, w, f), chain: path.join(base, w, 'chain.json') };
};

/** The attack: drop the last `n` records and rewrite chain.json so it agrees. */
function cutTail(root, n = 2) {
  const { jsonl, chain } = flightFile(root);
  const lines = fs.readFileSync(jsonl, 'utf8').trim().split('\n');
  for (let i = 0; i < n; i++) lines.pop();
  fs.writeFileSync(jsonl, lines.join('\n') + '\n');
  const last = JSON.parse(lines[lines.length - 1]);
  fs.writeFileSync(chain, JSON.stringify({ seq: last.seq, last: last.hash }) + '\n');
}

// ---- the witness ---------------------------------------------------------------------------

test('TS-128-01 deleting a COMMITTED anchors.jsonl is reported as a deleted witness, not as "never anchored"', needGit, async () => {
  const root = tmpRepo();
  await runCli(['anchor'], { cwd: root });
  git(root, ['add', '-A']); git(root, ['commit', '-q', '-m', 'anchor']);

  cutTail(root);
  fs.rmSync(path.join(root, '.kiai', 'anchors.jsonl'));

  const r = await runCli(['verify'], { cwd: root });
  assert.match(r.stdout, /ANCHOR EVIDENCE MISSING/, 'the line must not read NOT ANCHORED — that means "there was never a witness"');
  assert.doesNotMatch(r.stdout, /^NOT ANCHORED/m);
  assert.match(r.stdout, /committed in git with 1 anchor\(s\) but is NOT in this working tree/);
  assert.equal(r.code, 1, 'and it must fail: before this, `rm` turned a cut tail into exit 0');
});

test('TS-128-02 removing lines from anchors.jsonl is caught even though the file still exists', needGit, async () => {
  const root = tmpRepo();
  await runCli(['anchor'], { cwd: root });
  git(root, ['add', '-A']); git(root, ['commit', '-q', '-m', 'anchor']);

  cutTail(root);
  fs.writeFileSync(path.join(root, '.kiai', 'anchors.jsonl'), ''); // emptied, not deleted

  const r = await runCli(['verify'], { cwd: root });
  assert.match(r.stdout, /ANCHOR EVIDENCE MISSING/);
  assert.match(r.stdout, /0 anchor\(s\) on disk but 1 in the last commit/, 'the numbers are in the message, so the reader can check it');
  assert.match(r.stdout, /append-only, so 1 line\(s\) were removed/);
  assert.equal(r.code, 1);
});

test('TS-128-03 a repository that never anchored still says NOT ANCHORED and still exits 0', needGit, async () => {
  const root = tmpRepo();
  const r = await runCli(['verify'], { cwd: root });
  assert.match(r.stdout, /^NOT ANCHORED/m, 'never anchored and witness-deleted are different facts');
  assert.doesNotMatch(r.stdout, /ANCHOR EVIDENCE MISSING/);
  assert.equal(r.code, 0, 'a false alarm here would fire on every repository that has not run `kiai anchor`');

  // and the same outside git entirely
  const solo = tmpRepo({ gitInit: false });
  const s = await runCli(['verify'], { cwd: solo });
  assert.doesNotMatch(s.stdout, /ANCHOR EVIDENCE MISSING/);
  assert.equal(s.code, 0);
  assert.equal(anchorsEvidence(solo).state, 'unknown');
});

test('TS-128-04 --require-anchor refuses a chain with no witness, and passes one that has it', needGit, async () => {
  // The tail-cut-with-chain.json-patched attack CANNOT be detected locally: the same writer owns both
  // files. So the honest answer is not a cleverer check, it is letting CI refuse an unanchored chain.
  const root = tmpRepo();
  const bare = await runCli(['verify', '--require-anchor'], { cwd: root });
  assert.equal(bare.code, 1);
  assert.match(bare.stderr, /this chain has no witness at all, so a cut tail cannot be detected here/);

  await runCli(['anchor'], { cwd: root });
  git(root, ['add', '-A']); git(root, ['commit', '-q', '-m', 'anchor']);
  const ok = await runCli(['verify', '--require-anchor'], { cwd: root });
  assert.equal(ok.code, 0, ok.stdout + ok.stderr);

  // and it is still the anchor, not the flag, that catches an actual cut
  cutTail(root);
  const cut = await runCli(['verify'], { cwd: root });
  assert.match(cut.stdout, /ANCHOR MISMATCH|tail truncated/);
  assert.equal(cut.code, 1);
});

// ---- the authority -------------------------------------------------------------------------

test('TS-128-11 REPLACING an anchor line is caught, although the line count never changes (R1-P1)', needGit, async () => {
  // Review round 1 did the obvious thing the first version missed: instead of deleting the witness,
  // overwrite it. `anchorHash` is exported from the very module under attack, so an attacker who can
  // write the tree imports it and produces a line whose hash is perfectly valid — one that witnesses
  // the SHORTER chain they just cut. Counting lines saw 1 and 1 and said `ANCHORED`, exit 0.
  const root = tmpRepo();
  await runCli(['anchor'], { cwd: root });
  git(root, ['add', '-A']); git(root, ['commit', '-q', '-m', 'anchor']);
  const anchors = path.join(root, '.kiai', 'anchors.jsonl');
  const before = fs.readFileSync(anchors, 'utf8').trim().split('\n').length;

  cutTail(root);
  const v = verifyChain(root);
  const old = JSON.parse(fs.readFileSync(anchors, 'utf8').trim().split('\n')[0]);
  const fake = { ...old, records: v.count, writers: v.chains.map((c) => ({ writer: c.writer || '', count: c.count, last: c.last })), all_last: v.last };
  delete fake.hash;
  fake.hash = anchorHash(fake); // a VALID hash, computed with the project's own function
  fs.writeFileSync(anchors, JSON.stringify(fake) + '\n');
  assert.equal(fs.readFileSync(anchors, 'utf8').trim().split('\n').length, before, 'the count is identical — that is the whole point of this attack');

  const ev = anchorsEvidence(root);
  assert.equal(ev.state, 'rewritten');
  const r = await runCli(['verify'], { cwd: root });
  assert.match(r.stdout, /ANCHOR EVIDENCE MISSING/);
  assert.match(r.stdout, /line 1 is not the line in the last commit/);
  assert.equal(r.code, 1, 'and it fails without any flag: a rewritten witness is not a warning');
  assert.equal((await runCli(['verify', '--require-anchor'], { cwd: root })).code, 1);
});

test('TS-128-12 accept --check reports a deleted witness exactly as verify does (R1-P1, twin #5)', needGit, async () => {
  // On the same tampered tree, `verify` said ANCHOR EVIDENCE MISSING while `accept --check` — the
  // command a human or CI actually runs at the moment of acceptance — still printed `NOT ANCHORED`,
  // the one sentence this UoW exists to stop being printed. Fifth time in this project that a fix
  // landed on one branch of a pair.
  const root = tmpRepo();
  await runCli(['accept', '--uow', 'UOW-900', '--decision', 'approve', '--by', 'tester'], { cwd: root, env: { KIAI_ALLOW_AGENT_DECISION: '1' } });
  await runCli(['anchor'], { cwd: root });
  git(root, ['add', '-A']); git(root, ['commit', '-q', '-m', 'anchor + decision']);
  const packet = path.join(root, '.kiai', 'acceptance', 'acceptance-UOW-900.md');
  assert.equal((await runCli(['accept', '--check', packet], { cwd: root })).code, 0, 'sanity: clean before the attack');

  cutTail(root, 1);
  fs.rmSync(path.join(root, '.kiai', 'anchors.jsonl'));

  const v = await runCli(['verify'], { cwd: root });
  const a = await runCli(['accept', '--check', packet], { cwd: root });
  assert.match(v.stdout, /ANCHOR EVIDENCE MISSING/);
  assert.match(a.stdout, /ANCHOR EVIDENCE MISSING/, 'the two commands must never disagree about the same tree');
  assert.doesNotMatch(a.stdout, /NOT ANCHORED/);
  assert.equal(a.code, 1, 'and accept --check must FAIL, not just print a different line');
  assert.match(a.stderr, /anchors\.jsonl is committed in git/);
});

test('TS-128-13 anchoring again before committing is normal, not tampering', needGit, async () => {
  // Append-only means the working copy is allowed MORE lines than the commit. If comparing content
  // fired here it would go red every time someone runs `kiai anchor` and has not committed yet —
  // the most ordinary thing in the workflow.
  const root = tmpRepo();
  await runCli(['anchor'], { cwd: root });
  git(root, ['add', '-A']); git(root, ['commit', '-q', '-m', 'anchor']);
  await runCli(['anchor'], { cwd: root }); // second anchor, NOT committed

  const ev = anchorsEvidence(root);
  assert.equal(ev.state, 'ok', ev.reason || '');
  assert.ok(ev.disk > ev.head, 'more on disk than in the commit is exactly what append-only looks like');
  const r = await runCli(['verify'], { cwd: root });
  assert.doesNotMatch(r.stdout, /ANCHOR EVIDENCE MISSING/);
  assert.equal(r.code, 0);
});

test('TS-128-14 a witness the attacker wrote themselves does not satisfy --require-anchor (R2)', needGit, async () => {
  // Review round 2 got past the first version without knowing anything about the anchor format: cut the
  // tail, patch chain.json, then run `kiai anchor` — the REAL command. The witness is perfectly
  // self-consistent, because the tool wrote it; it witnesses the lie. The flag only looked at "is there
  // an anchor", and the word that matters is COMMITTED.
  const root = tmpRepo();
  cutTail(root);
  await runCli(['anchor'], { cwd: root }); // the attacker anchors their own cut chain, does NOT commit

  const plain = await runCli(['verify'], { cwd: root });
  assert.match(plain.stdout, /^ANCHORED/m, 'the anchor really is internally valid — that is the point');
  assert.equal(plain.code, 0);

  const gate = await runCli(['verify', '--require-anchor'], { cwd: root });
  assert.equal(gate.code, 1, 'but a witness the writer can still change is not evidence to anyone else');
  assert.match(gate.stderr, /HAS a witness, but it is untracked/, 'the sentence must not accuse someone who simply has not committed yet');
  assert.match(gate.stderr, /commit \.kiai\/anchors\.jsonl/);
  assert.doesNotMatch(gate.stderr, /run `kiai anchor`/, 'they just ran it — telling them to run it again is the wrong instruction (R3)');

  // once it IS committed, the same chain passes — the flag is about evidence travelling, not about mood
  git(root, ['add', '-A']); git(root, ['commit', '-q', '-m', 'anchor']);
  assert.equal((await runCli(['verify', '--require-anchor'], { cwd: root })).code, 0);
});

test('TS-128-15 status reports a tampered witness in the same words as verify (R2, twin #3)', needGit, async () => {
  // `verify` and `accept --check` both spoke up; `status` printed `anchors: 1 … anchors file: modified`
  // on the same tampered tree — and `modified` is the same word it uses for the harmless "you just
  // anchored and have not committed yet".
  const root = tmpRepo();
  await runCli(['anchor'], { cwd: root });
  git(root, ['add', '-A']); git(root, ['commit', '-q', '-m', 'anchor']);

  cutTail(root);
  const v0 = verifyChain(root);
  const old = JSON.parse(fs.readFileSync(path.join(root, '.kiai', 'anchors.jsonl'), 'utf8').trim().split('\n')[0]);
  const fake = { ...old, records: v0.count, writers: v0.chains.map((c) => ({ writer: c.writer || '', count: c.count, last: c.last })), all_last: v0.last };
  delete fake.hash;
  fake.hash = anchorHash(fake);
  fs.writeFileSync(path.join(root, '.kiai', 'anchors.jsonl'), JSON.stringify(fake) + '\n');

  const st = await runCli(['status'], { cwd: root });
  assert.match(st.stdout, /ANCHOR EVIDENCE MISSING/, 'status must not be the one command that stays quiet');
  assert.match(st.stdout, /line 1 is not the line in the last commit/);

  // and an untouched tree still reads normally — the line only changes when there is something to say
  const clean = tmpRepo();
  await runCli(['anchor'], { cwd: clean });
  git(clean, ['add', '-A']); git(clean, ['commit', '-q', '-m', 'anchor']);
  const ok = await runCli(['status'], { cwd: clean });
  assert.match(ok.stdout, /anchors: 1 —/);
  assert.doesNotMatch(ok.stdout, /ANCHOR EVIDENCE MISSING/);
});

test('TS-128-05 a key the agent added to its own working copy is SIGNER NOT REVIEWED — both shapes', needSsh, async () => {
  // Measured 17/09 against the shipped tool: this printed `SIGNED by cto@example.com` and exited 0.
  // The signature was correct; the list that made it authoritative was writable by the signer.
  //
  // TWO shapes, because a fix for one is not a fix for the other (UOW-127 kept teaching this):
  //   (a) the list IS committed and the attacker appends a key to the working copy
  //   (b) the list was never committed at all, so nothing in it was ever reviewed
  // Shape (b) was classed as "could not check" in the first version of this UoW, and walked straight
  // through --require-signature.

  // ---- (a) committed list, key appended -----------------------------------------------------
  const a = tmpRepo();
  const lead = makeKey('lead');
  await runCli(['signers', '--add', 'lead@example.com', '--key', lead + '.pub'], { cwd: a });
  git(a, ['add', '-A']); git(a, ['commit', '-q', '-m', 'review: add lead']);
  const evil = makeKey('evil');
  await runCli(['signers', '--add', 'cto@example.com', '--key', evil + '.pub'], { cwd: a });
  await runCli(['accept', '--uow', 'UOW-900', '--decision', 'approve', '--by', 'cto@example.com', '--sign', '--key', evil], { cwd: a });

  const packetA = path.join(a, '.kiai', 'acceptance', 'acceptance-UOW-900.md');
  const ra = await runCli(['accept', '--check', packetA], { cwd: a });
  assert.match(ra.stdout, /SIGNER NOT REVIEWED/);
  assert.match(ra.stdout, /the signature by cto@example\.com checks out, but/, 'say the signature is fine — the problem is the key, and naming the wrong one sends the reader hunting');
  assert.match(ra.stdout, /not in the committed \.kiai\/allowed_signers/);
  const gateA = await runCli(['accept', '--check', packetA, '--require-signature'], { cwd: a });
  assert.equal(gateA.code, 1);
  assert.match(gateA.stderr, /SIGNER NOT REVIEWED/, 'the gate names the state that refused it, not a default "not signed"');

  // ---- (b) list never committed --------------------------------------------------------------
  const b = tmpRepo();
  const evil2 = makeKey('evil2');
  await runCli(['signers', '--add', 'cto@example.com', '--key', evil2 + '.pub'], { cwd: b });
  await runCli(['accept', '--uow', 'UOW-900', '--decision', 'approve', '--by', 'cto@example.com', '--sign', '--key', evil2], { cwd: b });

  const packetB = path.join(b, '.kiai', 'acceptance', 'acceptance-UOW-900.md');
  const rb = await runCli(['accept', '--check', packetB], { cwd: b });
  assert.match(rb.stdout, /SIGNER NOT REVIEWED/, 'a git repo CAN hold a reviewed list; this one holds none, which is a definite no');
  assert.match(rb.stdout, /is not committed in this repository/);
  assert.match(rb.stdout, /commit that file/, 'and the message says what to do about it');
  assert.equal((await runCli(['accept', '--check', packetB, '--require-signature'], { cwd: b })).code, 1);

  const v = await runCli(['verify', '--require-signature'], { cwd: b });
  assert.equal(v.code, 1);
  assert.match(v.stderr, /signed by a key no reviewed commit contains/);
});

test('TS-128-06 a key that WAS committed still passes — the fix must not refuse honest work', needSsh, async () => {
  const root = tmpRepo();
  const lead = makeKey('lead');
  await runCli(['signers', '--add', 'lead@example.com', '--key', lead + '.pub'], { cwd: root });
  git(root, ['add', '-A']); git(root, ['commit', '-q', '-m', 'review: add lead to allowed_signers']);
  await runCli(['accept', '--uow', 'UOW-900', '--decision', 'approve', '--by', 'lead@example.com', '--sign', '--key', lead], { cwd: root });

  const packet = path.join(root, '.kiai', 'acceptance', 'acceptance-UOW-900.md');
  const r = await runCli(['accept', '--check', packet, '--require-signature'], { cwd: root });
  assert.equal(r.code, 0, r.stdout + r.stderr);
  assert.match(r.stdout, /SIGNED by lead@example\.com/);
  assert.doesNotMatch(r.stdout, /NOT REVIEWED|REVIEW UNCHECKED/);

  const strict = await runCli(['accept', '--check', packet, '--require-reviewed-signer'], { cwd: root });
  assert.equal(strict.code, 0, 'the strict flag must also pass on a reviewed key');
});

test('TS-128-07 with no reviewed copy to ask, say so — do not claim review, do not cry forgery', needSsh, async () => {
  const root = tmpRepo({ gitInit: false });
  const solo = makeKey('solo');
  await runCli(['signers', '--add', 'solo@example.com', '--key', solo + '.pub'], { cwd: root });
  await runCli(['accept', '--uow', 'UOW-900', '--decision', 'approve', '--by', 'solo@example.com', '--sign', '--key', solo], { cwd: root });

  const packet = path.join(root, '.kiai', 'acceptance', 'acceptance-UOW-900.md');
  const r = await runCli(['accept', '--check', packet], { cwd: root });
  assert.match(r.stdout, /SIGNED by solo@example\.com/, 'the signature really was checked and really is good');
  assert.match(r.stdout, /REVIEW UNCHECKED — not a git repository/, 'and the gap is on the same line, not left for the reader to assume');
  assert.doesNotMatch(r.stdout, /SIGNER NOT REVIEWED/, 'unknown is not the same as no');

  assert.equal((await runCli(['accept', '--check', packet, '--require-signature'], { cwd: root })).code, 0,
    'a gap is not a forgery: --require-signature must not fire where no reviewed copy can exist');
  const strict = await runCli(['accept', '--check', packet, '--require-reviewed-signer'], { cwd: root });
  assert.equal(strict.code, 1, 'and the flag that DOES mean "prove review" refuses it');
  assert.match(strict.stderr, /nothing here says the key was ever reviewed/);
});

test('TS-128-08 "uncheckable" keeps meaning uncheckable — review gets its own counter and its own line', needSsh, async () => {
  // A first version of this UoW folded "the key was never reviewed" into the `uncheckable` count, and
  // `verify` then reported 2 uncheckable signatures it had in fact just checked successfully.
  const root = tmpRepo();
  const evil = makeKey('evil');
  await runCli(['signers', '--add', 'cto@example.com', '--key', evil + '.pub'], { cwd: root });
  await runCli(['accept', '--uow', 'UOW-900', '--decision', 'approve', '--by', 'cto@example.com', '--sign', '--key', evil], { cwd: root });

  const r = await runCli(['verify'], { cwd: root });
  assert.match(r.stdout, /decisions: 1 \(0 invalid, 0 unsigned, 0 uncheckable\)/, 'this signature WAS checked, and it checked out');
  assert.match(r.stdout, /signer review: 1 not reviewed, 0 could not be checked/, 'the new fact gets its own words');
  assert.equal(r.code, 0, 'a plain verify stays green: a repo that has not committed its signer list yet is not an attack');

  assert.equal((await runCli(['verify', '--require-reviewed-signer'], { cwd: root })).code, 1);
});

test('TS-128-09 SIGNER NOT REVIEWED is one of the states that fail a gate', () => {
  assert.equal(SIG_STATE.NOT_REVIEWED, 'SIGNER NOT REVIEWED');
  assert.ok(SIG_FAIL.has(SIG_STATE.NOT_REVIEWED), 'a state nobody checks is a state that protects nobody');
  assert.ok(!SIG_FAIL.has(SIG_STATE.SIGNED));
});

test('TS-128-10 every test file is actually run by `npm test`', () => {
  // harden.test.mjs sat in test/ passing 9 cases that `npm test` never executed, because the script
  // lists files by hand. A test nobody runs is worse than no test: it reads like coverage.
  const pkg = JSON.parse(fs.readFileSync(path.join(HERE, '..', 'package.json'), 'utf8'));
  const script = pkg.scripts.test;
  const onDisk = fs.readdirSync(HERE).filter((f) => f.endsWith('.test.mjs'));
  const missing = onDisk.filter((f) => !script.includes('test/' + f));
  assert.deepEqual(missing, [], 'these test files exist but `npm test` does not run them');
});
