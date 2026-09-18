// Tests for `kiai sign` (UOW-127): a real signature on a human's gate decision.
// Offline, temp dirs only. Keys are generated per-test in mkdtemp — ~/.ssh is NEVER read or written.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { appendRecord, buildRecord, sha256 } from '../lib/flight.mjs';
import { packetBody } from '../lib/accept.mjs';
import {
  signBlob, verifyBlob, addSigner, readAllowedSigners, allowedSignersFile,
  sshKeygenAvailable, fingerprint, fingerprintOfKeyLine, keyAlgorithm, SIG_STATE, SIG_FAIL, NAMESPACE,
} from '../lib/sign.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CLI = path.join(HERE, '..', 'bin', 'kiai.mjs');
const HAVE_SSH = sshKeygenAvailable().ok;
/** A machine without ssh-keygen must SKIP with a reason, never pass quietly. */
const needSsh = { skip: HAVE_SSH ? false : 'ssh-keygen not available on this machine' };

function tmpRepo() {
  const dir = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'kiai-sign-')));
  fs.mkdirSync(path.join(dir, '.kiai'), { recursive: true });
  const env = { KIAI_UOW: 'UOW-900' };
  // Real time, not a fixed date: the CLI writes with the real clock, and a fixture pinned to one day
  // lands in a different day-file from everything the test then does. That is exactly what broke at
  // 2026-09-18 00:00 — every record here had been stamped 2026-09-17.
  const base = Date.now() - 60_000;
  const t = (i) => new Date(base + i * 1000);
  appendRecord(dir, buildRecord({ session_id: 's1', hook_event_name: 'SessionStart' }, { cwd: dir, root: dir, env, now: t(1) }));
  fs.writeFileSync(path.join(dir, 'app.txt'), 'hello\n');
  appendRecord(dir, buildRecord({ session_id: 's1', hook_event_name: 'PreToolUse', tool_name: 'Write', tool_use_id: 't1', tool_input: { file_path: path.join(dir, 'app.txt'), content: 'hello\n' } }, { cwd: dir, root: dir, env, now: t(2) }));
  appendRecord(dir, buildRecord({ session_id: 's1', hook_event_name: 'Stop' }, { cwd: dir, root: dir, env, now: t(3) }));
  return dir;
}

function makeKey(name = 'k', passphrase = '') {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kiai-key-'));
  const file = path.join(dir, name);
  const r = spawnSync('ssh-keygen', ['-q', '-t', 'ed25519', '-f', file, '-N', passphrase, '-C', name], { stdio: 'ignore' });
  assert.equal(r.status, 0, 'ssh-keygen must be able to make a throwaway key');
  return file;
}

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

const PACKET = (root) => path.join(root, '.kiai', 'acceptance', 'acceptance-UOW-900.md');

// ---- TS-127-01 ---------------------------------------------------------------------------

test('TS-127-01 a signed decision reports SIGNED by the identity, and the record carries the signature', needSsh, async () => {
  const root = tmpRepo();
  const key = makeKey('lead');
  assert.equal((await runCli(['signers', '--add', 'lead@example.com', '--key', key + '.pub'], { cwd: root })).code, 0);

  const acc = await runCli(['accept', '--uow', 'UOW-900', '--decision', 'approve', '--by', 'lead@example.com', '--sign', '--key', key], { cwd: root });
  assert.equal(acc.code, 0, acc.stderr);

  // Fixture records carry a fixed date and the CLI writes with the real one, so past midnight they
  // land in two day-files. Reading only the first found nothing at 2026-09-18 00:00.
  const wdir = path.join(root, '.kiai', 'flight', fs.readdirSync(path.join(root, '.kiai', 'flight'))[0]);
  const chain = fs.readdirSync(wdir).filter((f) => f.endsWith('.jsonl')).sort().map((f) => fs.readFileSync(path.join(wdir, f), 'utf8')).join('');
  const dec = chain.split('\n').filter(Boolean).map((l) => JSON.parse(l)).find((r) => r.event === 'decision');
  assert.ok(Array.isArray(dec.sig), 'sig is an ARRAY from the first version: a post-quantum algorithm is added, not swapped');
  assert.equal(dec.sig.length, 1);
  assert.equal(dec.sig[0].alg, 'ssh-ed25519');
  assert.equal(dec.sig[0].namespace, NAMESPACE);
  assert.match(dec.sig[0].key_fingerprint, /^SHA256:/);
  assert.match(dec.sig[0].blob, /^-----BEGIN SSH SIGNATURE-----/);

  const chk = await runCli(['accept', '--check', PACKET(root)], { cwd: root });
  assert.equal(chk.code, 0, chk.stdout + chk.stderr);
  assert.match(chk.stdout, /SIGNED by lead@example\.com/);
  assert.match(chk.stdout, /ssh-ed25519/);
});

// ---- TS-127-02 ---------------------------------------------------------------------------

test('TS-127-02 one changed byte in the packet body is caught', needSsh, async () => {
  const root = tmpRepo();
  const key = makeKey('lead');
  await runCli(['signers', '--add', 'lead@example.com', '--key', key + '.pub'], { cwd: root });
  await runCli(['accept', '--uow', 'UOW-900', '--decision', 'approve', '--by', 'lead@example.com', '--sign', '--key', key], { cwd: root });

  const md = fs.readFileSync(PACKET(root), 'utf8');
  fs.writeFileSync(PACKET(root), md.replace('APPROVED', 'REJECTED'));
  const chk = await runCli(['accept', '--check', PACKET(root)], { cwd: root });
  assert.equal(chk.code, 1, 'a tampered packet must not pass');
  assert.match(chk.stdout, /MISMATCH/);
});

test('TS-127-02b the signature alone catches a body change even when the footer is recomputed', needSsh, () => {
  // An attacker who edits the packet AND fixes the Hash: footer defeats the footer. The signature
  // does not move: it was made over the original body.
  const key = makeKey('lead');
  const body = '# Acceptance packet\n\n- **Status:** APPROVED\n';
  const s = signBlob(body, { keyFile: key });
  assert.equal(s.ok, true, s.error);
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kiai-as-'));
  fs.mkdirSync(path.join(root, '.kiai'), { recursive: true });
  addSigner(root, 'lead@example.com', key + '.pub');
  const af = allowedSignersFile(root);
  assert.equal(verifyBlob(body, s.blob, { allowedSignersFile: af }).state, SIG_STATE.SIGNED);
  const forged = body.replace('APPROVED', 'REJECTED');
  assert.equal(verifyBlob(forged, s.blob, { allowedSignersFile: af }).state, SIG_STATE.INVALID);
});

// ---- TS-127-03 ---------------------------------------------------------------------------

test('TS-127-03 a mathematically perfect signature from a key nobody listed is SIGNER NOT ALLOWED', needSsh, async () => {
  const root = tmpRepo();
  const lead = makeKey('lead');
  const evil = makeKey('evil');
  await runCli(['signers', '--add', 'lead@example.com', '--key', lead + '.pub'], { cwd: root });

  // the attacker signs with their own key and even claims the lead's name
  const acc = await runCli(['accept', '--uow', 'UOW-900', '--decision', 'approve', '--by', 'lead@example.com', '--sign', '--key', evil], { cwd: root });
  assert.equal(acc.code, 0, 'the CLI still records it — and then says exactly what it is');

  const chk = await runCli(['accept', '--check', PACKET(root)], { cwd: root });
  assert.match(chk.stdout, /SIGNER NOT ALLOWED/);
  assert.equal(chk.code, 1, 'an unlisted signer must fail the check');
});

// ---- TS-127-04 / 05 ----------------------------------------------------------------------

test('TS-127-04 an unsigned decision stays readable but --require-signature refuses it', needSsh, async () => {
  const root = tmpRepo();
  const acc = await runCli(['accept', '--uow', 'UOW-900', '--decision', 'approve', '--by', 'Tech Lead'], { cwd: root });
  assert.equal(acc.code, 0, 'backward compatible: an old-style decision is still recordable');

  const plain = await runCli(['accept', '--check', PACKET(root)], { cwd: root });
  assert.equal(plain.code, 0);
  assert.match(plain.stdout, /UNSIGNED/);
  assert.match(plain.stdout, /environment variable/, 'and it says WHY that is weak');

  const strict = await runCli(['accept', '--check', PACKET(root), '--require-signature'], { cwd: root });
  assert.equal(strict.code, 1, 'this is the gate a CI would use');
});

test('TS-127-05 verify lists every decision by name and fails on a bad signature', needSsh, async () => {
  const root = tmpRepo();
  const lead = makeKey('lead');
  const evil = makeKey('evil');
  await runCli(['signers', '--add', 'lead@example.com', '--key', lead + '.pub'], { cwd: root });
  await runCli(['accept', '--uow', 'UOW-900', '--decision', 'approve', '--by', 'Tech Lead'], { cwd: root });

  const v1 = await runCli(['verify'], { cwd: root });
  assert.equal(v1.code, 0, 'an unsigned decision is not, by itself, a broken chain');
  assert.match(v1.stdout, /decisions: 1 \(0 invalid, 1 unsigned, 0 uncheckable\)/);

  const v2 = await runCli(['verify', '--require-signature'], { cwd: root });
  assert.equal(v2.code, 1);
  assert.match(v2.stderr, /not signed/);

  await runCli(['accept', '--uow', 'UOW-900', '--decision', 'approve', '--by', 'lead@example.com', '--sign', '--key', evil], { cwd: root });
  const v3 = await runCli(['verify'], { cwd: root });
  assert.equal(v3.code, 1, 'an unlisted signer fails verify even without --require-signature');
  assert.match(v3.stdout, /SIGNER NOT ALLOWED/);
});

test('TS-127-05b a packet replaced by a later decision is NOT reported as an invalid signature', needSsh, async () => {
  // Review 123 caught this class on anchors: a valid history must not raise a false alarm.
  const root = tmpRepo();
  const lead = makeKey('lead');
  await runCli(['signers', '--add', 'lead@example.com', '--key', lead + '.pub'], { cwd: root });
  await runCli(['accept', '--uow', 'UOW-900', '--decision', 'approve', '--by', 'lead@example.com', '--sign', '--key', lead], { cwd: root });
  await runCli(['accept', '--uow', 'UOW-900', '--decision', 'reject', '--by', 'lead@example.com', '--sign', '--key', lead], { cwd: root });

  const v = await runCli(['verify'], { cwd: root });
  assert.equal(v.code, 0, 'two honest decisions in sequence are not a failure');
  assert.doesNotMatch(v.stdout, /SIGNATURE INVALID/, 'the earlier packet was kept as .prev-*, so its signature still checks out');
  assert.match(v.stdout, /decisions: 2 \(0 invalid, 0 unsigned, 0 uncheckable\)/);
});

// ---- TS-127-06 / 07: the failure paths, which must never hang ----------------------------

test('TS-127-06 a passphrase-protected key fails fast instead of waiting for a prompt', needSsh, async () => {
  const root = tmpRepo();
  const key = makeKey('locked', 'a-passphrase');
  await runCli(['signers', '--add', 'lead@example.com', '--key', key + '.pub'], { cwd: root });
  const started = Date.now();
  const acc = await runCli(['accept', '--uow', 'UOW-900', '--decision', 'approve', '--by', 'lead@example.com', '--sign', '--key', key], { cwd: root, timeout: 20000 });
  const took = Date.now() - started;
  assert.equal(acc.code, 2, 'refused, not hung and not silently unsigned');
  assert.ok(took < 20000, `must not hang (took ${took} ms)`);
  assert.match(acc.stderr, /nothing was sealed/, 'and nothing is recorded that would claim to be signed');
  assert.ok(!fs.existsSync(PACKET(root)), 'no APPROVED packet may exist when signing failed');
});

test('TS-127-07 with no ssh-keygen: signing refuses, verifying degrades to UNSIGNED and does not crash', async () => {
  const root = tmpRepo();
  // an empty PATH removes ssh-keygen; node itself is launched by absolute path
  const noPath = { PATH: path.join(root, 'no-such-bin'), Path: path.join(root, 'no-such-bin') };
  const sign = await runCli(['accept', '--uow', 'UOW-900', '--decision', 'approve', '--by', 'x', '--sign', '--key', path.join(root, 'nope')], { cwd: root, env: noPath });
  assert.equal(sign.code, 2);
  assert.ok(!fs.existsSync(PACKET(root)));

  await runCli(['accept', '--uow', 'UOW-900', '--decision', 'approve', '--by', 'x'], { cwd: root });
  const v = await runCli(['verify'], { cwd: root, env: noPath });
  assert.equal(v.code, 0, 'a machine without ssh-keygen can still read its own black box');
  assert.match(v.stdout, /UNSIGNED/);
});

// ---- TS-127-08 / 10 ----------------------------------------------------------------------

test('TS-127-08 init creates allowed_signers, does not ignore it, and signers --list reports it', needSsh, async () => {
  const bare = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'kiai-bare-')));
  fs.mkdirSync(path.join(bare, '.git'));
  const init = await runCli(['init'], { cwd: bare });
  assert.equal(init.code, 0);
  const af = allowedSignersFile(bare);
  assert.ok(fs.existsSync(af), 'init creates the file so the question "who may approve?" is visible from day one');
  assert.match(fs.readFileSync(af, 'utf8'), /anyone who can change this repository can add their/, 'the file states its own limit');

  const ignore = fs.readFileSync(path.join(bare, '.kiai', '.gitignore'), 'utf8');
  assert.ok(!/allowed_signers/.test(ignore), 'it must travel in git or it proves nothing to anyone else');

  const empty = await runCli(['signers', '--list'], { cwd: bare });
  assert.match(empty.stdout, /0 signer\(s\)/);

  const key = makeKey('alice');
  const add = await runCli(['signers', '--add', 'alice@example.com', '--key', key + '.pub'], { cwd: bare });
  assert.equal(add.code, 0);
  assert.match(add.stdout, /COMMIT this file/);
  const list = await runCli(['signers', '--list'], { cwd: bare });
  assert.match(list.stdout, /1 signer\(s\)/);
  assert.match(list.stdout, /alice@example\.com\s+ssh-ed25519/);

  // pointing at the PRIVATE key by mistake must be caught, not written
  const bad = await runCli(['signers', '--add', 'bob@example.com', '--key', key], { cwd: bare });
  assert.equal(bad.code, 2);
  assert.match(bad.stderr, /PRIVATE key/);
  assert.equal(readAllowedSigners(bare).entries.length, 1);
});

test('TS-127-10 a key quietly added to allowed_signers is visible in what verify prints', needSsh, async () => {
  const root = tmpRepo();
  const lead = makeKey('lead');
  await runCli(['signers', '--add', 'lead@example.com', '--key', lead + '.pub'], { cwd: root });
  const before = readAllowedSigners(root);

  const evil = makeKey('evil');
  addSigner(root, 'lead@example.com', evil + '.pub');   // an attacker adding their own key under a trusted name
  const after = readAllowedSigners(root);
  assert.equal(after.entries.length, before.entries.length + 1, 'the file grew');
  const list = await runCli(['signers', '--list'], { cwd: root });
  assert.match(list.stdout, /2 signer\(s\)/, 'and `signers --list` shows both, so the extra line is visible');
});

// ---- TS-127-09 / 11: algorithm agility and non-ASCII --------------------------------------

test('TS-127-09 sig is a list, so a second algorithm can be added without re-signing history', needSsh, () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kiai-agil-'));
  fs.mkdirSync(path.join(root, '.kiai'), { recursive: true });
  const a = makeKey('a');
  const b = makeKey('b');
  addSigner(root, 'lead@example.com', a + '.pub');
  addSigner(root, 'lead@example.com', b + '.pub');
  const body = 'body under two signatures\n';
  const s1 = signBlob(body, { keyFile: a });
  const s2 = signBlob(body, { keyFile: b });
  assert.equal(s1.ok && s2.ok, true);
  const af = allowedSignersFile(root);
  for (const s of [s1, s2]) assert.equal(verifyBlob(body, s.blob, { allowedSignersFile: af }).state, SIG_STATE.SIGNED);
  assert.notEqual(s1.fingerprint, s2.fingerprint, 'two distinct keys, both accepted — the shape a PQ migration needs');
});

test('TS-127-11 a packet body with non-ASCII text signs and verifies (bytes, not characters)', needSsh, () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kiai-utf-'));
  fs.mkdirSync(path.join(root, '.kiai'), { recursive: true });
  const key = makeKey('vn');
  addSigner(root, 'lead@example.com', key + '.pub');
  const body = 'Hồ sơ nghiệm thu — UOW-900 · quyết định: CHẤP NHẬN ✅\n';
  const s = signBlob(body, { keyFile: key });
  assert.equal(s.ok, true, s.error);
  const af = allowedSignersFile(root);
  assert.equal(verifyBlob(body, s.blob, { allowedSignersFile: af }).state, SIG_STATE.SIGNED);
  assert.equal(verifyBlob(body.replace('CHẤP NHẬN', 'TỪ CHỐI'), s.blob, { allowedSignersFile: af }).state, SIG_STATE.INVALID);
});

// ---- what the GATE 3 review of 2026-09-17 caught (R P1…P6) --------------------------------

test('TS-127-14 deleting the packet must NOT turn a rejected signature into a green gate (R P1)', needSsh, async () => {
  // The first version printed `SIGNED` when the signed packet was missing and counted it as a pass,
  // so `rm` converted a forgery that had just been REFUSED into exit 0. A gate must never go green
  // because the evidence is gone.
  const root = tmpRepo();
  const alice = makeKey('alice');
  const mallory = makeKey('mallory');
  await runCli(['signers', '--add', 'alice@example.com', '--key', alice + '.pub'], { cwd: root });
  await runCli(['accept', '--uow', 'UOW-900', '--decision', 'approve', '--by', 'alice@example.com', '--sign', '--key', mallory], { cwd: root });

  const before = await runCli(['verify', '--require-signature'], { cwd: root });
  assert.equal(before.code, 1);
  assert.match(before.stdout, /SIGNER NOT ALLOWED/);

  fs.rmSync(PACKET(root));
  const after = await runCli(['verify', '--require-signature'], { cwd: root });
  assert.equal(after.code, 1, 'deleting the evidence must not pass the gate');
  assert.match(after.stdout, /SIGNATURE UNCHECKABLE/);
  assert.doesNotMatch(after.stdout, /: SIGNED\b/, 'and it must never be called SIGNED');

  const loose = await runCli(['verify'], { cwd: root });
  assert.equal(loose.code, 0, 'without the flag it is a warning, not a failure — backward compatible');
  assert.match(loose.stdout, /WARN — 1 decision\(s\) carry a signature that could not be checked/);
});

test('TS-127-15 --require-signature refuses a packet nobody sealed, and one with no chain at all (R P2)', needSsh, async () => {
  const root = tmpRepo();
  const alice = makeKey('alice');
  await runCli(['signers', '--add', 'alice@example.com', '--key', alice + '.pub'], { cwd: root });

  // a packet the attacker wrote themselves, footer computed to match
  const body = '# Acceptance packet — UOW-900\n\n**Status: APPROVED** by the CTO.\n\n';
  const forged = path.join(root, 'forged.md');
  fs.writeFileSync(forged, body + 'Hash: ' + sha256(body) + '\n');

  const loose = await runCli(['accept', '--check', forged], { cwd: root });
  assert.match(loose.stdout, /OK \(footer only\)/, 'a footer that matches its own body is not a claim about provenance');
  assert.match(loose.stdout, /NOT SEALED/);

  const strict = await runCli(['accept', '--check', forged, '--require-signature'], { cwd: root });
  assert.equal(strict.code, 1, 'a packet nobody sealed must not pass the CI gate');
  assert.match(strict.stderr, /not sealed by any decision record/);

  // the same file outside any repository: no chain to check it against
  const away = fs.mkdtempSync(path.join(os.tmpdir(), 'kiai-away-'));
  const copy = path.join(away, 'p.md');
  fs.copyFileSync(forged, copy);
  const outside = await runCli(['accept', '--check', copy, '--require-signature'], { cwd: away });
  assert.equal(outside.code, 1, 'no evidence available is not the same as evidence of approval');
});

test('TS-127-16 a signed packet carries its own signature, in both .md and .json (R P4, AC-1)', needSsh, async () => {
  const root = tmpRepo();
  const key = makeKey('lead');
  await runCli(['signers', '--add', 'lead@example.com', '--key', key + '.pub'], { cwd: root });
  await runCli(['accept', '--uow', 'UOW-900', '--decision', 'approve', '--by', 'lead@example.com', '--sign', '--key', key], { cwd: root });

  const md = fs.readFileSync(PACKET(root), 'utf8');
  assert.match(md, /^Signature \(ssh-ed25519, lead@example\.com, key SHA256:/m, 'the reader of the file can see who signed it');
  assert.match(md, /-----BEGIN SSH SIGNATURE-----/);
  const hashAt = md.lastIndexOf('Hash: ');
  assert.ok(md.indexOf('Signature (') > hashAt, 'the signature sits BELOW the footer, so the signed body is unchanged');

  const json = JSON.parse(fs.readFileSync(PACKET(root).replace(/\.md$/, '.json'), 'utf8'));
  assert.ok(Array.isArray(json.signature) && json.signature.length === 1, 'and a dashboard can read it without parsing Markdown');
  assert.equal(json.signature[0].identity, 'lead@example.com');

  // the packet still verifies with its signature appended
  const chk = await runCli(['accept', '--check', PACKET(root)], { cwd: root });
  assert.equal(chk.code, 0, chk.stdout + chk.stderr);
  assert.match(chk.stdout, /SIGNED by lead@example\.com/);
});

test('TS-127-17 the packet never advertises signing as "planned" once it is signed (R P3g)', needSsh, async () => {
  const root = tmpRepo();
  const key = makeKey('lead');
  await runCli(['signers', '--add', 'lead@example.com', '--key', key + '.pub'], { cwd: root });
  await runCli(['accept', '--uow', 'UOW-900', '--decision', 'approve', '--by', 'lead@example.com', '--sign', '--key', key, '--lang', 'both'], { cwd: root });
  const md = fs.readFileSync(PACKET(root), 'utf8');
  assert.doesNotMatch(md, /not a cryptographic signature \(planned\)/i, 'a signed packet that says signing is "planned" contradicts itself');
  assert.doesNotMatch(md, /chữ ký số \(dự tính\)/i);
});

test('TS-127-18 signers survives an unreadable allowed_signers instead of printing a stack trace (R P5)', needSsh, async () => {
  const root = tmpRepo();
  fs.mkdirSync(allowedSignersFile(root));           // a directory where the file should be
  const list = await runCli(['signers', '--list'], { cwd: root });
  assert.equal(list.code, 2);
  assert.match(list.stderr, /cannot read \.kiai\/allowed_signers/, 'says what is wrong, in the path git uses');
  assert.doesNotMatch(list.stderr, /at readAllowedSigners/, 'no stack trace: a black box that crashes has failed at its one job');

  const key = makeKey('k');
  const add = await runCli(['signers', '--add', 'a@example.com', '--key', key + '.pub'], { cwd: root });
  assert.equal(add.code, 2);
  assert.match(add.stderr, /cannot read \.kiai\/allowed_signers/, 'the reason is kept — it is what tells the user where to look');
  assert.doesNotMatch(add.stderr, new RegExp('\\n\\s+at '), 'but no stack frame: a black box that crashes has failed at its one job');
});

test('TS-127-19 one key cannot be given a second identity — that is a rename, not a duplicate (R P6)', needSsh, async () => {
  // `find-principals` returns the FIRST matching line, so a line added above an existing one makes
  // that person's signatures report as somebody else's: no new key, no new signature, new name.
  const root = tmpRepo();
  const alice = makeKey('alice');
  await runCli(['signers', '--add', 'alice@example.com', '--key', alice + '.pub'], { cwd: root });

  const rename = await runCli(['signers', '--add', 'cto@example.com', '--key', alice + '.pub'], { cwd: root });
  assert.equal(rename.code, 2, 'refused');
  assert.match(rename.stderr, /already listed as alice@example\.com/);
  assert.match(rename.stderr, /silently rename every signature/);
  assert.equal(readAllowedSigners(root).entries.length, 1, 'and nothing was written');

  // hand-edited in anyway: `signers --list` must make the duplicate key visible
  const af = allowedSignersFile(root);
  const pub = fs.readFileSync(alice + '.pub', 'utf8').trim().split(/\s+/).slice(0, 2).join(' ');
  fs.writeFileSync(af, fs.readFileSync(af, 'utf8') + `cto@example.com ${pub}\n`);
  const list = await runCli(['signers', '--list'], { cwd: root });
  assert.match(list.stdout, /SHA256:/, 'fingerprints are printed (AC-9)');
  assert.match(list.stdout, /SAME KEY as alice@example\.com/, 'and the duplicate is called out');
});

test('TS-127-20 --sign without --decision refuses instead of writing an unsigned draft (R N3)', needSsh, async () => {
  const root = tmpRepo();
  const key = makeKey('lead');
  const r = await runCli(['accept', '--uow', 'UOW-900', '--sign', '--key', key], { cwd: root });
  assert.equal(r.code, 2, 'a flag that silently does nothing lies about the file it produced');
  assert.match(r.stderr, /only means something together with --decision/);
  assert.ok(!fs.existsSync(path.join(root, '.kiai', 'acceptance', 'acceptance-UOW-900.draft.md')));
});

test('TS-127-21 a signature this machine cannot check is not called "unsigned" (R N5)', needSsh, async () => {
  const root = tmpRepo();
  const key = makeKey('lead');
  await runCli(['signers', '--add', 'lead@example.com', '--key', key + '.pub'], { cwd: root });
  await runCli(['accept', '--uow', 'UOW-900', '--decision', 'approve', '--by', 'lead@example.com', '--sign', '--key', key], { cwd: root });

  const noPath = { PATH: path.join(root, 'no-such-bin'), Path: path.join(root, 'no-such-bin') };
  const v = await runCli(['verify'], { cwd: root, env: noPath });
  assert.match(v.stdout, /SIGNATURE NOT CHECKED/, 'there IS a signature here — saying "unsigned" would be false');
  const strict = await runCli(['verify', '--require-signature'], { cwd: root, env: noPath });
  assert.equal(strict.code, 1, 'and a gate cannot pass on a signature nobody checked');
});

test('TS-127-22 a signed packet checks out on its own, and a recomputed footer cannot hide an edit (R P2, AC-3)', needSsh, async () => {
  // The footer is not a defence: an attacker who edits the body recomputes it. The signature does not
  // move. `--check` used to find the signature only through a decision record whose hash matched the
  // file — which that edit breaks — so the signature was never consulted. Now the file is read.
  const root = tmpRepo();
  const key = makeKey('lead');
  await runCli(['signers', '--add', 'lead@example.com', '--key', key + '.pub'], { cwd: root });
  await runCli(['accept', '--uow', 'UOW-900', '--decision', 'approve', '--by', 'lead@example.com', '--sign', '--key', key], { cwd: root });

  const good = await runCli(['accept', '--check', PACKET(root)], { cwd: root });
  assert.equal(good.code, 0, good.stdout + good.stderr);
  assert.match(good.stdout, /SIGNED by lead@example\.com/);

  // edit the body AND fix the footer so it matches again
  const md = fs.readFileSync(PACKET(root), 'utf8');
  const hashAt = md.lastIndexOf('\nHash: ');
  const head = md.slice(0, hashAt);
  const tail = md.slice(md.indexOf('\n', hashAt + 1) + 1);
  const edited = head.replace('APPROVED', 'REJECTED') + '\n';
  fs.writeFileSync(PACKET(root), edited + 'Hash: ' + sha256(edited) + '\n' + tail);

  const forged = await runCli(['accept', '--check', PACKET(root)], { cwd: root });
  assert.match(forged.stdout, /OK \(footer only\)/, 'the footer really does still match — that is the point');
  assert.match(forged.stdout, /SIGNATURE INVALID/, 'and the signature the file carries says the body moved');
  assert.equal(forged.code, 1, 'so the check fails even without --require-signature');

  // the same file carried away from its repository still fails on its own signature
  const away = fs.mkdtempSync(path.join(os.tmpdir(), 'kiai-away2-'));
  fs.mkdirSync(path.join(away, '.kiai'));
  fs.copyFileSync(allowedSignersFile(root), allowedSignersFile(away));
  const copy = path.join(away, 'p.md');
  fs.copyFileSync(PACKET(root), copy);
  const elsewhere = await runCli(['accept', '--check', copy], { cwd: away });
  assert.match(elsewhere.stdout, /SIGNATURE INVALID/);
  assert.equal(elsewhere.code, 1);
});

test('TS-127-23 the Signature header is attacker text: a single-line forgery is ignored, a multi-line one does not parse (R P1-v2)', needSsh, async () => {
  // The header sits BELOW the `Hash:` footer, so neither the footer nor the signature covers it.
  // Printing its fields produced `SIGNED by cto@example.com — ml-dsa-87 … GATE 4 PASSED` on a packet
  // Alice had signed. Two separate defences, so this case checks BOTH of them.
  const root = tmpRepo();
  const alice = makeKey('alice');
  await runCli(['signers', '--add', 'alice@example.com', '--key', alice + '.pub'], { cwd: root });
  await runCli(['accept', '--uow', 'UOW-900', '--decision', 'approve', '--by', 'alice@example.com', '--sign', '--key', alice], { cwd: root });

  const away = fs.mkdtempSync(path.join(os.tmpdir(), 'kiai-hdr-'));
  fs.mkdirSync(path.join(away, '.kiai'));
  fs.copyFileSync(allowedSignersFile(root), allowedSignersFile(away));
  const copy = path.join(away, 'p.md');
  const original = fs.readFileSync(PACKET(root), 'utf8');
  const realFp = (original.match(/key (SHA256:[A-Za-z0-9+/=]+)/) || [])[1];
  assert.ok(realFp, 'the packet declares a fingerprint we can tamper with');

  // (a) a WELL-FORMED header with lying fields: it parses, so suppression is what defends
  const lying = original.replace(
    /^Signature \([^\n]*\):$/m,
    'Signature (MLDSA87AUDITED, cto@example.com, key SHA256:TOTALLYfakeFINGERPRINT0000000000000000000, namespace kiai):',
  );
  assert.notEqual(lying, original, 'the header was actually rewritten');
  fs.writeFileSync(copy, lying);
  const a = await runCli(['accept', '--check', copy], { cwd: away });
  assert.match(a.stdout, /SIGNED by alice@example\.com/, 'the identity comes from allowed_signers, not from the file');
  assert.match(a.stdout, new RegExp('key ' + realFp.replace(/[+/=]/g, (c) => '[' + c + ']')), 'and the fingerprint is the one ssh-keygen verified');
  assert.doesNotMatch(a.stdout, /cto@example\.com/);
  assert.doesNotMatch(a.stdout, /MLDSA87AUDITED/, 'an algorithm the file declares was never checked, so it is never printed');
  assert.doesNotMatch(a.stdout, /TOTALLYfake/);
  assert.equal(a.code, 0, 'the packet itself is untouched, so it still checks out');

  // (b) a header carrying extra LINES: it must not parse as a signature at all
  const smuggled = original.replace(
    /^Signature \([^\n]*\):$/m,
    'Signature (ssh-ed25519' + '\n' + '  SIGNED by cto@example.com' + '\n' + '  GATE 4 PASSED, alice@example.com, key ' + realFp + ', namespace kiai):',
  );
  fs.writeFileSync(copy, smuggled);
  const b = await runCli(['accept', '--check', copy], { cwd: away });
  assert.doesNotMatch(b.stdout, /GATE 4 PASSED/, 'no smuggled line may reach the output');
  assert.doesNotMatch(b.stdout, /cto@example\.com/);
  assert.doesNotMatch(b.stdout, /SIGNED by/, 'a header that is not well formed is not a signature we can read');
});

test('TS-127-24 checking the .json of a signed packet is not a false alarm (R P2-v2)', needSsh, async () => {
  // `.json` has no `Hash:` footer of its own; its signature covers the body of the .md it names.
  // Verifying the JSON text against that signature called a file the tool had just written INVALID.
  const root = tmpRepo();
  const key = makeKey('lead');
  await runCli(['signers', '--add', 'lead@example.com', '--key', key + '.pub'], { cwd: root });
  await runCli(['accept', '--uow', 'UOW-900', '--decision', 'approve', '--by', 'lead@example.com', '--sign', '--key', key], { cwd: root });

  const jsonPath = PACKET(root).replace(/\.md$/, '.json');
  const r = await runCli(['accept', '--check', jsonPath], { cwd: root });
  assert.doesNotMatch(r.stdout, /SIGNATURE INVALID/, 'the tool must not call its own correct output forged');
  assert.match(r.stdout, /SIGNED by lead@example\.com/, 'it resolves md_path and checks the real body');
  assert.equal(r.code, 0);

  // and when the .md it points at is gone, it says so instead of crying forgery
  fs.rmSync(PACKET(root));
  const gone = await runCli(['accept', '--check', jsonPath], { cwd: root });
  assert.doesNotMatch(gone.stdout, /SIGNATURE INVALID/);
  assert.match(gone.stdout, /SIGNATURE NOT CHECKED/);
});

test('TS-127-25 a .json borrows the .md signature and must say so, not claim it as its own (R3-P)', needSsh, async () => {
  // A `.json` carries no signature: the signature covers the `.md` body, and the only link between the
  // two is `md_sha256` — written inside the .json by whoever wrote it. Saying plain `SIGNED` let a
  // .json whose own decision read "reject by nobody" print `SIGNED by alice@example.com`, exit 0.
  const root = tmpRepo();
  const alice = makeKey('alice');
  await runCli(['signers', '--add', 'alice@example.com', '--key', alice + '.pub'], { cwd: root });
  await runCli(['accept', '--uow', 'UOW-900', '--decision', 'approve', '--by', 'alice@example.com', '--sign', '--key', alice], { cwd: root });

  const away = fs.mkdtempSync(path.join(os.tmpdir(), 'kiai-json-'));
  fs.mkdirSync(path.join(away, '.kiai'));
  fs.copyFileSync(allowedSignersFile(root), allowedSignersFile(away));
  fs.copyFileSync(PACKET(root), path.join(away, 'acceptance-UOW-900.md'));
  const j = JSON.parse(fs.readFileSync(PACKET(root).replace(/\.md$/, '.json'), 'utf8'));
  j.decision = { decision: 'reject', by: 'nobody', at: '2020-01-01T00:00:00Z', via: 'human' };
  const lie = path.join(away, 'lie.json');
  fs.writeFileSync(lie, JSON.stringify(j, null, 2) + '\n');

  const r = await runCli(['accept', '--check', lie, '--require-signature'], { cwd: away });
  assert.match(r.stdout, /SIGNED \(of the \.md it points at\) by alice@example\.com/, 'the borrowing is named in the line itself');
  assert.match(r.stdout, /this \.json carries no signature of its own/);
  assert.equal(r.code, 1, 'and with no chain to vouch for its contents, the gate refuses it');

  // the same .json inside its own repository is vouched for by the chain, so it passes
  const home = await runCli(['accept', '--check', PACKET(root).replace(/\.md$/, '.json'), '--require-signature'], { cwd: root });
  assert.equal(home.code, 0, home.stdout + home.stderr);
  assert.match(home.stdout, /SIGNED \(of the \.md it points at\)/);
});

test('TS-127-26 md_path names a file beside the packet, never a path out of it (R3-N20)', needSsh, async () => {
  // Unfiltered, `../../secret/x` made --check a file-existence-and-hash oracle, and the output showed
  // only the basename — hiding that it had left the directory.
  const away = fs.mkdtempSync(path.join(os.tmpdir(), 'kiai-trav-'));
  const pkg = path.join(away, 'pkg');
  fs.mkdirSync(pkg);
  fs.mkdirSync(path.join(away, 'secret'));
  const loot = path.join(away, 'secret', 'loot.txt');
  fs.writeFileSync(loot, 'not part of any packet\n');

  const trav = path.join(pkg, 'trav.json');
  fs.writeFileSync(trav, JSON.stringify({ v: 1, uow: 'UOW-900', md_path: '../secret/loot.txt', md_sha256: sha256(fs.readFileSync(loot, 'utf8')) }, null, 2) + '\n');
  const r = await runCli(['accept', '--check', trav], { cwd: pkg });
  assert.equal(r.code, 1, 'a path out of the packet directory is refused');
  assert.match(r.stdout, /md_path must name a file next to this one, not a path/);
  assert.match(r.stdout, /\.\.\/secret\/loot\.txt/, 'and the real value is shown, not a basename that hides it');
  assert.doesNotMatch(r.stdout, /md_sha256 matches/, 'the hash of a file outside the directory is never confirmed');

  // the honest case still works: a companion NAME beside the file
  const md = '# Acceptance packet\n\nbody\n\n';
  fs.writeFileSync(path.join(pkg, 'p.md'), md + 'Hash: ' + sha256(md) + '\n');
  const okJson = path.join(pkg, 'p.json');
  fs.writeFileSync(okJson, JSON.stringify({ v: 1, uow: 'UOW-900', md_path: 'p.md', md_sha256: sha256(md + 'Hash: ' + sha256(md) + '\n') }, null, 2) + '\n');
  const good = await runCli(['accept', '--check', okJson], { cwd: pkg });
  assert.match(good.stdout, /OK — \.json points at p\.md \(md_sha256 matches\)/, 'a plain companion name is still accepted');
});

test('TS-127-27 the algorithm printed is the one ssh-keygen verified (R3-N24)', needSsh, () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kiai-alg-'));
  fs.mkdirSync(path.join(root, '.kiai'));
  const key = makeKey('lead');
  addSigner(root, 'lead@example.com', key + '.pub');
  const body = 'a body\n';
  const sig = signBlob(body, { keyFile: key });
  const res = verifyBlob(body, sig.blob, { allowedSignersFile: allowedSignersFile(root) });
  assert.equal(res.state, SIG_STATE.SIGNED);
  assert.equal(res.verified_alg, 'ssh-ed25519', 'taken from ssh-keygen\'s own "with ED25519 key" line');
  assert.match(res.verified_fingerprint, /^SHA256:/);
});

test('TS-127-28 a .json the chain does not carry fails the gate INSIDE the repository too (R4-P)', needSsh, async () => {
  // R3 closed the NO CHAIN branch and left its twin open. A `.json` always borrows the .md's signature,
  // so `!own.length` is never true and the NOT SEALED branch never set noEvidence: the same forged file
  // that exits 1 outside the repository exited 0 inside it, which is where CI runs.
  const root = tmpRepo();
  const alice = makeKey('alice');
  await runCli(['signers', '--add', 'alice@example.com', '--key', alice + '.pub'], { cwd: root });
  await runCli(['accept', '--uow', 'UOW-900', '--decision', 'approve', '--by', 'alice@example.com', '--sign', '--key', alice], { cwd: root });

  const realJson = PACKET(root).replace(/[.]md$/, '.json');
  const j = JSON.parse(fs.readFileSync(realJson, 'utf8'));
  j.decision = { decision: 'reject', by: 'nobody', at: '2020-01-01T00:00:00Z', via: 'human' };
  const lie = path.join(path.dirname(realJson), 'lie.json');
  fs.writeFileSync(lie, JSON.stringify(j, null, 2) + '\n');

  const r = await runCli(['accept', '--check', lie, '--require-signature'], { cwd: root });
  assert.match(r.stdout, /NOT SEALED/, 'no record here carries this file');
  assert.equal(r.code, 1, 'and so the gate refuses it, in the repository as well as outside it');
  assert.match(r.stderr, /no decision record here carries its hash/);

  // the honest .json beside it, which the chain DOES carry, still passes — the fix must not over-tighten
  const good = await runCli(['accept', '--check', realJson, '--require-signature'], { cwd: root });
  assert.equal(good.code, 0, good.stdout + good.stderr);
});

// ---- the module's own contract -----------------------------------------------------------

test('TS-127-12 verifyBlob is fail-closed on every path that is not an unambiguous success', needSsh, () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kiai-fc-'));
  fs.mkdirSync(path.join(root, '.kiai'), { recursive: true });
  const key = makeKey('k');
  const body = 'x\n';
  const s = signBlob(body, { keyFile: key });
  const af = allowedSignersFile(root);

  assert.equal(verifyBlob(body, s.blob, { allowedSignersFile: af }).state, SIG_STATE.NOT_CHECKED, 'no list to check against is "could not check", not "nobody may approve" (R N14)');
  fs.writeFileSync(af, '# only comments\n');
  assert.equal(verifyBlob(body, s.blob, { allowedSignersFile: af }).state, SIG_STATE.NOT_ALLOWED);
  addSigner(root, 'k@example.com', key + '.pub');
  assert.equal(verifyBlob(body, s.blob, { allowedSignersFile: af }).state, SIG_STATE.SIGNED);
  assert.equal(verifyBlob(body, 'not a signature at all', { allowedSignersFile: af }).state, SIG_STATE.NOT_ALLOWED);
  assert.equal(verifyBlob(body, null, { allowedSignersFile: af }).state, SIG_STATE.UNSIGNED);

  assert.equal(signBlob(body, { keyFile: '' }).ok, false, 'no key ⇒ refuse, never produce an unsigned "signature"');
  assert.equal(signBlob(body, { keyFile: path.join(root, 'missing') }).ok, false);
  assert.equal(keyAlgorithm(path.join(root, 'missing')), 'unknown', 'unknown is said, not guessed');
  assert.equal(fingerprint(path.join(root, 'missing')), null);
});

test('TS-127-13 the signature covers exactly the text the Hash: footer covers', needSsh, () => {
  const md = '# Acceptance packet\n\nbody line\n\nHash: ' + sha256('# Acceptance packet\n\nbody line\n\n') + '\n';
  const body = packetBody(md);
  assert.equal(body, '# Acceptance packet\n\nbody line\n\n', 'one definition of "the packet", used by both');
  assert.equal(packetBody('no footer here'), null);
});
