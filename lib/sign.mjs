// kiai sign — a real signature on a human's gate decision.
//
// WHY THIS EXISTS
//   Until now `kiai accept --decision` was gated by an ENVIRONMENT VARIABLE, and the package said so
//   ("an environment check, not a cryptographic signature"). Every attack class that reaches an agent
//   session can set an environment variable, so an attacker could seal "the tech lead approved this"
//   into the hash chain — and the chain would then make that lie DURABLE rather than detectable.
//   A signature binds the decision to a key, and the key to a person named in a committed file.
//
// WHAT IT PROVES, AND WHAT IT DOES NOT
//   Proves: this exact packet body was signed by a key that `.kiai/allowed_signers` names, and has not
//   changed by one byte since.
//   Does NOT prove: that the signer read what they signed; that the agent was not compromised; that
//   the work is correct. It does not stop a compromised agent from doing damage — it stops a forged
//   APPROVAL, and it makes later tampering visible. Do not describe it as more than that.
//
// WHY ssh-keygen AND NOT sigstore
//   Zero new dependencies (OpenSSH ships everywhere git 2.34+ signs commits with it), zero new keys
//   (developers already have one), and it works fully offline — which is the only option compatible
//   with this package's promise that nothing leaves your machine. Sigstore/Rekor gives stronger public
//   non-repudiation and is the right OPTIONAL second layer; it needs the network, so it is not default.
//
// MEASURED 2026-09-17 on OpenSSH 10.2p1 (exit codes are the contract this module relies on):
//   good signature        -> 0
//   body changed          -> 255
//   identity not in file  -> 255
//   wrong namespace       -> 255
//   Anything else is treated as INVALID. Never as valid.

import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/** Signature namespace. Fixed: a signature made for KIAI must not verify as anything else. */
export const NAMESPACE = 'kiai';
export const ALLOWED_SIGNERS = path.join('.kiai', 'allowed_signers');
/** The same path as it appears in git, for messages: the file is committed as `.kiai/allowed_signers`. */
const ALLOWED_SIGNERS_POSIX = '.kiai/allowed_signers';

export const SIG_STATE = {
  SIGNED: 'SIGNED',
  UNSIGNED: 'UNSIGNED',
  INVALID: 'SIGNATURE INVALID',
  NOT_ALLOWED: 'SIGNER NOT ALLOWED',
  // There IS a signature, and we could not check it. Reported separately and never as SIGNED:
  // the first version of this module printed "SIGNED" when the signed packet was missing, which
  // turned `rm` into a way to make a rejected forgery pass a gate. A gate must never go green
  // because evidence is absent.
  UNCHECKABLE: 'SIGNATURE UNCHECKABLE',
  // There is a signature and this machine has no ssh-keygen: not the same thing as "unsigned".
  NOT_CHECKED: 'SIGNATURE NOT CHECKED',
  // UOW-128. The signature is correct AND the key is in the working copy of allowed_signers —
  // but that copy is writable by whoever runs the agent. This state means: nobody reviewed the
  // key. It is not 'invalid'; saying invalid would send the reader hunting the wrong problem.
  NOT_REVIEWED: 'SIGNER NOT REVIEWED',
};

/** States that must fail a gate. Anything not listed here is not a pass — it is an omission. */
export const SIG_FAIL = new Set([SIG_STATE.INVALID, SIG_STATE.NOT_ALLOWED, SIG_STATE.UNCHECKABLE, SIG_STATE.NOT_CHECKED, SIG_STATE.NOT_REVIEWED]);

/**
 * Run ssh-keygen without ever letting it ask for anything.
 *
 * A passphrase prompt inside an agent session would HANG, and a hung black box is worse than a loud
 * failure: stdin is closed and every askpass route is disabled, so a key we cannot use fails at once.
 */
function sshKeygen(args, { input = null, cwd = undefined, timeout = 15000 } = {}) {
  const env = {
    ...process.env,
    SSH_ASKPASS_REQUIRE: 'never',
    SSH_ASKPASS: '',
    DISPLAY: '',
    GIT_TERMINAL_PROMPT: '0',
  };
  const res = spawnSync('ssh-keygen', args, {
    cwd, env, timeout, encoding: 'utf8',
    input: input === null ? undefined : input,
    stdio: [input === null ? 'ignore' : 'pipe', 'pipe', 'pipe'],
  });
  return {
    status: res.error ? null : res.status,
    stdout: res.stdout || '',
    stderr: res.stderr || '',
    error: res.error ? res.error.message : null,
    timedOut: Boolean(res.error && res.error.code === 'ETIMEDOUT'),
  };
}

/** Is ssh-keygen usable here? Never throws: a missing tool must degrade to UNSIGNED, not crash. */
export function sshKeygenAvailable() {
  try {
    const v = spawnSync('ssh-keygen', ['-Y', 'check-novalidate', '-n', NAMESPACE, '-s', '/nonexistent'], { encoding: 'utf8', timeout: 10000 });
    if (v.error) return { ok: false, reason: v.error.code === 'ENOENT' ? 'ssh-keygen not found' : v.error.message };
    return { ok: true, reason: null };
  } catch (e) {
    return { ok: false, reason: String(e && e.message ? e.message : e) };
  }
}

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'kiai-sig-'));
}
function wipe(dir) {
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* best effort */ }
}

/** SHA256 fingerprint of a key file (public or private). null when it cannot be read. */
export function fingerprint(keyFile) {
  const r = sshKeygen(['-lf', keyFile]);
  if (r.status !== 0) return null;
  const m = r.stdout.match(/(SHA256:[A-Za-z0-9+/=]+)/);
  return m ? m[1] : null;
}

/**
 * Sign a text body. Returns { ok, blob, alg, fingerprint, error }.
 * The body is written to a temp file and the temp directory is removed even on failure — a signing
 * input left on disk is a copy of the evidence sitting outside the chain.
 */
export function signBlob(text, { keyFile, namespace = NAMESPACE } = {}) {
  if (!keyFile) return { ok: false, error: 'no key given (use --key, or set KIAI_SIGN_KEY)' };
  if (!fs.existsSync(keyFile)) return { ok: false, error: `key not found: ${keyFile}` };
  const avail = sshKeygenAvailable();
  if (!avail.ok) return { ok: false, error: avail.reason };

  const dir = tmpDir();
  try {
    const body = path.join(dir, 'body');
    fs.writeFileSync(body, text, 'utf8');
    const r = sshKeygen(['-Y', 'sign', '-f', keyFile, '-n', namespace, body]);
    if (r.timedOut) return { ok: false, error: 'ssh-keygen timed out — is the key passphrase-protected? there is no prompt in this context' };
    if (r.status !== 0) {
      const hint = /passphrase|incorrect|load/i.test(r.stderr)
        ? ' (a passphrase-protected key cannot be used here: no prompt is possible — use an agent-loaded or unencrypted key)'
        : '';
      return { ok: false, error: (r.stderr.trim() || r.error || `ssh-keygen exited ${r.status}`) + hint };
    }
    const sigFile = body + '.sig';
    if (!fs.existsSync(sigFile)) return { ok: false, error: 'ssh-keygen reported success but wrote no signature' };
    return {
      ok: true,
      blob: fs.readFileSync(sigFile, 'utf8'),
      alg: keyAlgorithm(keyFile),
      fingerprint: fingerprint(keyFile),
      error: null,
    };
  } catch (e) {
    return { ok: false, error: String(e && e.message ? e.message : e) };
  } finally {
    wipe(dir);
  }
}

/** `ssh-ed25519`, `rsa-sha2-512`, … as reported by ssh-keygen; 'unknown' rather than a guess. */
export function keyAlgorithm(keyFile) {
  const r = sshKeygen(['-lf', keyFile]);
  if (r.status !== 0) return 'unknown';
  const m = r.stdout.match(/\(([A-Z0-9]+)\)\s*$/m);
  if (!m) return 'unknown';
  const t = m[1].toUpperCase();
  return t === 'ED25519' ? 'ssh-ed25519' : t === 'RSA' ? 'rsa-sha2-512' : t === 'ECDSA' ? 'ecdsa-sha2-nistp256' : t.toLowerCase();
}

/**
 * SHA256 fingerprint of one `<keytype> <key>` pair from allowed_signers.
 *
 * `signers --list` prints it so that two lines carrying the SAME key under different names are
 * visible at a glance — the rename attack the intent underestimated: `find-principals` returns the
 * FIRST match, so a line added above an existing one makes that person's signatures report as
 * somebody else's, with no new key and no new signature.
 */
export function fingerprintOfKeyLine(keyLine) {
  const dir = tmpDir();
  try {
    const f = path.join(dir, 'k.pub');
    fs.writeFileSync(f, String(keyLine).trim() + '\n', 'utf8');
    return fingerprint(f);
  } catch {
    return null;
  } finally {
    wipe(dir);
  }
}

/** Which identity in `allowedSigners` made this signature? null when none does. */
export function findPrincipal(sigBlob, allowedSignersFile) {
  if (!fs.existsSync(allowedSignersFile)) return null;
  const dir = tmpDir();
  try {
    const sig = path.join(dir, 'x.sig');
    fs.writeFileSync(sig, sigBlob, 'utf8');
    const r = sshKeygen(['-Y', 'find-principals', '-f', allowedSignersFile, '-s', sig]);
    if (r.status !== 0) return null;
    const first = r.stdout.split(/\r?\n/).map((s) => s.trim()).filter(Boolean)[0];
    return first || null;
  } catch {
    return null;
  } finally {
    wipe(dir);
  }
}

/**
 * Verify a body against a signature. Returns { state, identity, detail }.
 *
 * Fail-closed: anything that is not an unambiguous success is a failure state. An exit code this
 * module has never seen is INVALID — never "probably fine".
 */
export function verifyBlob(text, sigBlob, { allowedSignersFile, identity = null, namespace = NAMESPACE } = {}) {
  if (!sigBlob) return { state: SIG_STATE.UNSIGNED, identity: null, detail: 'no signature on this decision' };
  const avail = sshKeygenAvailable();
  if (!avail.ok) return { state: SIG_STATE.NOT_CHECKED, identity: null, detail: `${avail.reason} — there IS a signature here; this machine cannot check it` };
  if (!fs.existsSync(allowedSignersFile)) {
    // No list to check against is 'could not check', not 'nobody may approve' — saying the second
    // when the first is true sends the reader looking for the wrong problem.
    return { state: SIG_STATE.NOT_CHECKED, identity: null, detail: `no ${ALLOWED_SIGNERS_POSIX} here to check the signature against` };
  }

  const who = identity || findPrincipal(sigBlob, allowedSignersFile);
  if (!who) {
    // The signature may be perfectly valid mathematically; it is still made by a key this repository
    // does not recognise, which is exactly the case an attacker's own key produces.
    return { state: SIG_STATE.NOT_ALLOWED, identity: null, detail: 'the signing key is not listed in ' + ALLOWED_SIGNERS_POSIX };
  }

  const dir = tmpDir();
  try {
    const sig = path.join(dir, 'x.sig');
    fs.writeFileSync(sig, sigBlob, 'utf8');
    const r = sshKeygen(['-Y', 'verify', '-f', allowedSignersFile, '-I', who, '-n', namespace, '-s', sig], { input: text });
    if (r.status === 0) {
      const line = (r.stdout || '').trim();
      // Prefer the fingerprint ssh-keygen just verified over the one the record claims: a record
      // is written by whoever ran the command, the verifier's output is not.
      const fp = (line.match(/(SHA256:[A-Za-z0-9+/=]+)/) || [])[1] || null;
      // `Good "kiai" signature for alice@example.com with ED25519 key SHA256:…` — the algorithm is
      // right there in the verifier's own output, so there is no reason to print the one a file or a
      // record merely CLAIMS. Same rule as the fingerprint.
      const alg = (line.match(/\bwith\s+([A-Za-z0-9-]+)\s+key\b/) || [])[1] || null;
      const norm = alg ? (alg.toUpperCase() === 'ED25519' ? 'ssh-ed25519' : alg.toUpperCase() === 'RSA' ? 'rsa-sha2-512' : alg.toLowerCase()) : null;
      return { state: SIG_STATE.SIGNED, identity: who, detail: line || null, verified_fingerprint: fp, verified_alg: norm };
    }
    if (r.timedOut) return { state: SIG_STATE.INVALID, identity: who, detail: 'ssh-keygen timed out' };
    const why = (r.stderr || '').trim().split(/\r?\n/)[0] || `ssh-keygen exited ${r.status}`;
    return { state: SIG_STATE.INVALID, identity: who, detail: why };
  } catch (e) {
    return { state: SIG_STATE.INVALID, identity: who, detail: String(e && e.message ? e.message : e) };
  } finally {
    wipe(dir);
  }
}

// ---- allowed_signers ---------------------------------------------------------------------

/**
 * UOW-128. Was the key that signed this reviewed by anyone, or did the signer add it themselves?
 *
 * UOW-127 proves "a key listed in .kiai/allowed_signers signed this". Measured 17/09, that is a much
 * weaker claim than it reads as: an agent that can write the working tree can run
 * `kiai signers --add "cto@example.com" --key <its own key>`, sign, and get `SIGNED by cto@example.com`
 * with a signature that is correct mathematically. The list is the authority, and the list was writable.
 *
 * So ask the question against the copy a human had to merge: `git show HEAD:.kiai/allowed_signers`.
 * We verify the SAME signature a second time against that copy instead of parsing key lines ourselves —
 * the question is not "is this file modified" (line endings and comments make that noisy) but "does the
 * committed list accept this exact signature".
 *
 * 'yes' | 'no' | 'unknown'. `unknown` is its own answer and never means yes: outside git, before the
 * first commit, or when allowed_signers was never committed, nothing here has been reviewed by anyone,
 * and saying so plainly is the whole point.
 */
/**
 * The committed signer list is the SAME for every decision in one run, but the first version asked git
 * four times per decision: 20 signed decisions cost 2.95 s against 0.15 s for `kiai status` (measured
 * 2026-09-17, 148 ms each). Ask once per root, for the lifetime of this process — the CLI is one-shot,
 * so there is no staleness window that a long-running server would have.
 */
const reviewedListCache = new Map();

function committedSignerList(root) {
  if (reviewedListCache.has(root)) return reviewedListCache.get(root);
  const rel = ALLOWED_SIGNERS.replace(/\\/g, '/');
  const g = (args) => {
    try {
      return execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 5000 });
    } catch {
      return null;
    }
  };
  let out;
  if ((g(['rev-parse', '--is-inside-work-tree']) || '').trim() !== 'true') {
    out = { kind: 'unknown', reason: 'not a git repository, so no reviewed copy of the signer list exists' };
  } else if (!g(['rev-parse', 'HEAD'])) {
    out = { kind: 'unknown', reason: 'this repository has no commit yet, so no signer has been reviewed' };
  } else if (g(['ls-files', '--error-unmatch', '--', rel]) === null) {
    // A definite NO, not an unknown. A git repository with commits CAN hold a reviewed list; this one
    // does not, so no signer in it has been through review — exactly the state an agent that wrote its
    // own key into the file leaves behind. Calling it 'unknown' let the measured attack walk straight
    // through --require-signature (caught by TS-128-05 while writing this UoW).
    out = { kind: 'none', reason: `${ALLOWED_SIGNERS_POSIX} is not committed in this repository, so no signer in it has been reviewed — commit that file (it is reviewed like code)` };
  } else {
    const committed = g(['show', 'HEAD:' + rel]);
    out = committed === null
      ? { kind: 'unknown', reason: `the committed copy of ${ALLOWED_SIGNERS_POSIX} could not be read` }
      : { kind: 'text', text: committed };
  }
  reviewedListCache.set(root, out);
  return out;
}

export function reviewedSigner(root, text, sigBlob, { namespace = NAMESPACE } = {}) {
  const unknown = (reason) => ({ state: 'unknown', identity: null, reason });
  if (!sigBlob) return unknown('no signature to check');
  const avail = sshKeygenAvailable();
  if (!avail.ok) return unknown(avail.reason);
  const list = committedSignerList(root);
  if (list.kind === 'unknown') return unknown(list.reason);
  if (list.kind === 'none') return { state: 'no', identity: null, reason: list.reason };
  const committed = list.text;

  const dir = tmpDir();
  try {
    const list = path.join(dir, 'allowed_signers');
    fs.writeFileSync(list, committed, 'utf8');
    const who = findPrincipal(sigBlob, list);
    if (!who) {
      return { state: 'no', identity: null, reason: `the signing key is not in the committed ${ALLOWED_SIGNERS_POSIX} — it was added to the working copy without going through review` };
    }
    const sig = path.join(dir, 'x.sig');
    fs.writeFileSync(sig, sigBlob, 'utf8');
    const r = sshKeygen(['-Y', 'verify', '-f', list, '-I', who, '-n', namespace, '-s', sig], { input: text });
    if (r.status === 0) return { state: 'yes', identity: who, reason: null };
    // The committed list names this key but will not verify against it: treat as not reviewed rather
    // than as unknown — something about the reviewed copy does not accept this signature.
    return { state: 'no', identity: who, reason: `the committed ${ALLOWED_SIGNERS_POSIX} does not verify this signature` };
  } catch (e) {
    return unknown(String(e && e.message ? e.message : e));
  } finally {
    wipe(dir);
  }
}

export function allowedSignersFile(root) {
  return path.join(root, ALLOWED_SIGNERS);
}

export const ALLOWED_SIGNERS_HEADER = [
  '# .kiai/allowed_signers — who may approve work in this repository.',
  '# One line per person:   <identity>  <ssh-key-type> <public-key>   (OpenSSH allowed_signers format)',
  '# Add one with:          kiai signers --add alice@example.com --key ~/.ssh/id_ed25519.pub',
  '#',
  '# This file is COMMITTED on purpose: it is reviewed like code, and a key appearing here is a',
  '# visible commit. Its limit, stated plainly: anyone who can change this repository can add their',
  '# own key. It narrows who can forge an approval; it does not make forgery impossible.',
  '',
].join('\n');

/** Parsed entries. Comments and blank lines are ignored; malformed lines are reported, not dropped silently. */
export function readAllowedSigners(root) {
  const file = allowedSignersFile(root);
  const out = { file, exists: fs.existsSync(file), entries: [], malformed: [], lines: 0, unreadable: null };
  if (!out.exists) return out;
  let text;
  // A directory, a broken symlink, a permission problem: report it. A black box that prints a
  // stack trace has already failed at the one thing it sells.
  try { text = fs.readFileSync(file, 'utf8'); } catch (e) {
    out.unreadable = String(e && e.message ? e.message : e);
    return out;
  }
  if (text.charCodeAt(0) === 0xFEFF) text = text.slice(1);
  const lines = text.split(/\r?\n/);
  out.lines = lines.length;
  for (const [i, raw] of lines.entries()) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const m = line.match(/^(\S+)\s+((?:sk-)?(?:ssh|ecdsa)-\S+)\s+(\S+)/);
    if (!m) { out.malformed.push({ line: i + 1, text: line.slice(0, 80) }); continue; }
    out.entries.push({ identity: m[1], keytype: m[2], key: m[3], line: i + 1 });
  }
  return out;
}

/** Append one identity. Refuses a duplicate identity+key rather than quietly growing the file. */
export function addSigner(root, identity, pubKeyFile) {
  const file = allowedSignersFile(root);
  // A comma makes OpenSSH read this as SEVERAL principals for one key — quietly granting a name
  // nobody reviewed. One line, one identity.
  if (!/^[^\s#,][^\s,]{0,200}$/.test(String(identity || ''))) return { ok: false, error: 'identity must be one non-blank token without a comma (an email or a name)' };
  if (!fs.existsSync(pubKeyFile)) return { ok: false, error: `public key not found: ${pubKeyFile}` };
  const pub = fs.readFileSync(pubKeyFile, 'utf8').trim().split(/\r?\n/)[0];
  if (!/^(?:sk-)?(?:ssh|ecdsa)-\S+\s+\S+/.test(pub)) return { ok: false, error: `not an OpenSSH public key: ${pubKeyFile} (did you point at the PRIVATE key?)` };
  const keyPart = pub.split(/\s+/).slice(0, 2).join(' ');

  const existing = readAllowedSigners(root);
  if (existing.unreadable) return { ok: false, error: `cannot read ${ALLOWED_SIGNERS_POSIX}: ${existing.unreadable}` };
  if (existing.entries.some((e) => `${e.keytype} ${e.key}` === keyPart && e.identity === identity)) {
    return { ok: false, error: 'this identity and key are already listed' };
  }
  // One key under two names is not a duplicate — it is a RENAME. `ssh-keygen -Y find-principals`
  // returns the FIRST matching line, so adding `cto@example.com` above `alice@example.com` for
  // Alice's key makes Alice's signatures report as the CTO's, with no new key and no new
  // signature. That is a forgery of identity, so it is refused here rather than explained later.
  const sameKey = existing.entries.filter((e) => `${e.keytype} ${e.key}` === keyPart);
  if (sameKey.length) {
    return { ok: false, error: `this key is already listed as ${sameKey.map((e) => e.identity).join(', ')} (line ${sameKey.map((e) => e.line).join(', ')}). One key, one identity: a second name for the same key would silently rename every signature it ever made. Remove the old line first if the rename is intended.` };
  }
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const head = existing.exists ? '' : ALLOWED_SIGNERS_HEADER;
    const body = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '';
    const sep = body && !body.endsWith('\n') ? '\n' : '';
    fs.writeFileSync(file, head + body + sep + `${identity} ${keyPart}\n`);
  } catch (e) {
    // A directory in place of the file, a read-only checkout, a permission problem: say it plainly.
    return { ok: false, error: `cannot write ${ALLOWED_SIGNERS_POSIX}: ${e && e.message ? e.message : e}` };
  }
  return { ok: true, identity, keytype: keyPart.split(' ')[0], file };
}
