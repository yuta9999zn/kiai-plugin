// UOW-123 (TS-123-01..06): anchors — committed witnesses of chain heads.
// The lie this closes: a clone has no chain.json, so before anchors a cut TAIL verified as OK.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import {
  appendRecord, buildRecord, verifyChain, sha256,
  buildAnchor, appendAnchor, readAnchors, anchorHash, anchorsFile, anchorsTracked, checkAnchors,
} from '../lib/flight.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CLI = path.join(HERE, '..', 'bin', 'kiai.mjs');

function tmpRoot() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kiai-anchor-'));
  fs.mkdirSync(path.join(dir, '.kiai', 'flight'), { recursive: true });
  return fs.realpathSync.native(dir);
}
function runCli(args, { cwd, input = '', env = {} } = {}) {
  const clean = { ...process.env };
  delete clean.CLAUDECODE; delete clean.CLAUDE_CODE_ENTRYPOINT; delete clean.KIAI_ALLOW_AGENT_DECISION; delete clean.KIAI_ACTOR; delete clean.KIAI_UOW;
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [CLI, ...args], { cwd, env: { ...clean, ...env }, stdio: ['pipe', 'pipe', 'pipe'] });
    let out = '', err = '';
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { err += d; });
    child.stdin.end(input);
    child.on('close', (code) => resolve({ code, stdout: out, stderr: err }));
  });
}
const git = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
const hook = (root, i) => JSON.stringify({
  session_id: 's1', hook_event_name: 'PreToolUse', tool_name: 'Write', tool_use_id: `t${i}`,
  tool_input: { file_path: path.join(root, `f${i}.txt`), content: `line ${i}\n` }, cwd: root,
});
/** Append records numbered `from`..`to` (inclusive), tagged with UOW-801 so `accept` can see them. */
async function seed(root, from, to = from) {
  for (let i = from; i <= to; i++) {
    fs.writeFileSync(path.join(root, `f${i}.txt`), `line ${i}\n`);
    const r = await runCli(['record', 'PreToolUse'], { cwd: root, input: hook(root, i), env: { KIAI_UOW: 'UOW-801' } });
    assert.equal(r.code, 0, r.stderr);
  }
}
/** The one file of the one writer, as lines. */
function chainFile(root) {
  const dir = path.join(root, '.kiai', 'flight');
  const w = fs.readdirSync(dir).find((e) => fs.statSync(path.join(dir, e)).isDirectory());
  const f = fs.readdirSync(path.join(dir, w)).find((x) => /^\d{4}-\d{2}-\d{2}\.jsonl$/.test(x));
  return path.join(dir, w, f);
}

test('anchor: appends a witness line, is append-only, and refuses without a black box or with nothing to anchor (AC-1)', async () => {
  const bare = fs.mkdtempSync(path.join(os.tmpdir(), 'kiai-nobox-'));
  let r = await runCli(['anchor'], { cwd: bare });
  assert.equal(r.code, 2); assert.match(r.stderr, /no \.kiai\/ .* run `kiai init` first/);
  assert.equal(fs.existsSync(path.join(bare, '.kiai')), false, 'anchor never creates a black box');

  const root = tmpRoot();
  r = await runCli(['anchor'], { cwd: root });
  assert.equal(r.code, 1); assert.match(r.stderr, /no records to anchor yet/);

  await seed(root, 1, 4);
  r = await runCli(['anchor', '--by', 'tech lead', '--note', 'after 4'], { cwd: root });
  assert.equal(r.code, 0, r.stderr);
  assert.match(r.stdout, /^ANCHORED — 4 records in 1 chain\(s\), head [0-9a-f]{16}… → \.kiai\/anchors\.jsonl line 1/m);
  assert.match(r.stdout, /NEXT: commit \.kiai\/anchors\.jsonl/);

  const anchors = readAnchors(root);
  assert.equal(anchors.length, 1);
  const a = anchors[0];
  assert.equal(a.v, 1); assert.equal(a.by, 'tech lead'); assert.equal(a.note, 'after 4');
  assert.equal(a.records, 4); assert.equal(a.writers.length, 1); assert.equal(a.writers[0].count, 4);
  assert.equal(a.writers[0].last, verifyChain(root).chains[0].last);
  assert.equal(a._ok, true, 'hash of a freshly written anchor matches');
  assert.equal(a.git.repo, false, 'no git in this tmp dir');

  await seed(root, 5);
  r = await runCli(['anchor'], { cwd: root });
  assert.equal(r.code, 0, r.stderr);
  const two = readAnchors(root);
  assert.equal(two.length, 2, 'append-only: the first anchor is kept');
  assert.equal(two[0].records, 4); assert.equal(two[1].records, 5);
});

test('anchor closes the tail-cut hole: a COPY without chain.json sees BROKEN after records are removed (AC-2, AC-3)', async () => {
  const root = tmpRoot();
  await seed(root, 1, 6);
  let r = await runCli(['anchor', '--by', 'lead'], { cwd: root });
  assert.equal(r.code, 0, r.stderr);
  await seed(root, 7, 8); // two more records AFTER the anchor
  r = await runCli(['verify'], { cwd: root });
  assert.equal(r.code, 0, r.stdout);
  assert.match(r.stdout, /^OK — 8 records/m, 'writing past an anchor is normal');
  assert.match(r.stdout, /^ANCHORED — 1 anchor\(s\), latest .* covering 6 records/m);

  // a copy of the repository WITHOUT the machine-local witness (what a clone or a zip looks like)
  const copy = fs.mkdtempSync(path.join(os.tmpdir(), 'kiai-copy-'));
  fs.cpSync(root, copy, { recursive: true });
  for (const w of fs.readdirSync(path.join(copy, '.kiai', 'flight'))) {
    const p = path.join(copy, '.kiai', 'flight', w, 'chain.json');
    if (fs.existsSync(p)) fs.rmSync(p);
  }
  r = await runCli(['verify'], { cwd: copy });
  assert.equal(r.code, 0, 'the untouched copy still verifies');

  // cut the last 3 records — before UOW-123 this copy verified OK
  const file = chainFile(copy);
  const lines = fs.readFileSync(file, 'utf8').split('\n').filter((l) => l.trim());
  fs.writeFileSync(file, lines.slice(0, -3).join('\n') + '\n');
  r = await runCli(['verify'], { cwd: copy });
  assert.equal(r.code, 1, r.stdout);
  assert.match(r.stdout, /BROKEN at seq 5 — tail truncated since anchor .*: writer .* had 6 records \(head [0-9a-f]{16}…\), files end at seq 5/);
  assert.match(r.stdout, /^ANCHOR MISMATCH — tail truncated since anchor/m);

  // rewriting a record that the anchor covers is caught as well (content hash changes)
  const copy2 = fs.mkdtempSync(path.join(os.tmpdir(), 'kiai-copy2-'));
  fs.cpSync(root, copy2, { recursive: true });
  const f2 = chainFile(copy2);
  const l2 = fs.readFileSync(f2, 'utf8').split('\n').filter((l) => l.trim());
  const rec = JSON.parse(l2[2]);
  rec.hash = sha256('nope');
  l2[2] = JSON.stringify(rec);
  fs.writeFileSync(f2, l2.join('\n') + '\n');
  r = await runCli(['verify'], { cwd: copy2 });
  assert.equal(r.code, 1);
});

test('anchor: an EDITED anchor line is ignored with a warning and can never fake a broken chain (AC-4)', async () => {
  const root = tmpRoot();
  await seed(root, 1, 3);
  await runCli(['anchor'], { cwd: root });
  const file = anchorsFile(root);
  const a = JSON.parse(fs.readFileSync(file, 'utf8').trim());
  a.writers[0].count = 999;                       // claim there were 999 records
  fs.writeFileSync(file, JSON.stringify(a) + '\n');
  const r = await runCli(['verify'], { cwd: root });
  assert.equal(r.code, 0, r.stdout);
  assert.match(r.stdout, /^OK — 3 records/m);
  assert.match(r.stdout, /WARN — 1 anchor line\(s\) ignored — hash does not match/);
  assert.match(r.stdout, /^NOT ANCHORED — .*\[1 anchor line\(s\) ignored\]/m);
  assert.equal(readAnchors(root)[0]._ok, false);

  // a well-formed anchor whose hash matches IS used, so the two paths differ only by the hash
  const good = buildAnchor(root, { by: 'x' });
  assert.equal(anchorHash(good), good.hash);
  const v = verifyChain(root);
  assert.equal(checkAnchors(root, v.chains).bad, 1);

  // garbage lines are ignored the same way and never throw
  fs.appendFileSync(file, '{not json\n\n');
  assert.equal((await runCli(['verify'], { cwd: root })).code, 0);
  assert.equal(readAnchors(root).filter((x) => x._ok).length, 0);
});

test('anchor: git state is reported honestly — no repo, repo without a commit, committed, modified (AC-1, AC-9)', async () => {
  const root = tmpRoot();
  await seed(root, 1, 2);
  assert.equal(anchorsTracked(root), 'no-git');

  git(root, 'init', '-q', '.');
  git(root, 'config', 'user.email', 'a@b.c');
  git(root, 'config', 'user.name', 'probe');
  assert.equal(anchorsTracked(root), 'no-commit');
  let r = await runCli(['anchor'], { cwd: root });
  assert.equal(r.code, 0, r.stderr);
  assert.match(r.stdout, /git repository with no commit yet/);
  assert.match(r.stdout, /no commit yet — the anchor is only a local file so far/);
  assert.equal(buildAnchor(root, {}).git.repo, true, 'inside a repo even before the first commit');

  git(root, 'add', '-A');
  git(root, 'commit', '-q', '-m', 'first');
  assert.equal(anchorsTracked(root), 'committed');
  r = await runCli(['verify'], { cwd: root });
  assert.match(r.stdout, /the anchors file is committed, so anyone with this history can check it/);

  await seed(root, 3);
  await runCli(['anchor'], { cwd: root });
  assert.equal(anchorsTracked(root), 'modified');
  r = await runCli(['verify'], { cwd: root });
  assert.match(r.stdout, /WARNING: anchors\.jsonl differs from the committed copy/);
});

test('anchor: status counts anchors; accept --decision writes one and --check reports it (AC-5, AC-6)', async () => {
  const root = tmpRoot();
  await seed(root, 1, 3);
  let r = await runCli(['status'], { cwd: root });
  assert.match(r.stdout, /anchors: 0 — none \(run `kiai anchor`\)/);
  assert.match(r.stdout, /anchors file: no-git/);

  r = await runCli(['accept', '--uow', 'UOW-801', '--decision', 'approve', '--by', 'tech lead'], { cwd: root, env: { KIAI_UOW: 'UOW-801' } });
  assert.equal(r.code, 0, r.stderr);
  assert.match(r.stdout, /anchored: \d+ records → \.kiai\/anchors\.jsonl/);
  const anchors = readAnchors(root);
  assert.equal(anchors.length, 1, 'accept --decision anchors the chain it just sealed');
  assert.equal(anchors[0].note, 'sealed UOW-801');
  assert.equal(anchors[0].records, verifyChain(root).count);

  r = await runCli(['status'], { cwd: root });
  assert.match(r.stdout, /anchors: 1 — latest .* by tech lead, \d+ records/);

  // The packet is rendered BEFORE its own decision record exists, and the anchor must cover that record,
  // so the first packet of a repository honestly says "not anchored"; `--check` reports the state now (AC-5).
  const md = fs.readFileSync(path.join(root, '.kiai', 'acceptance', 'acceptance-UOW-801.md'), 'utf8');
  assert.match(md, /^- \*\*Anchored:\*\* ⚠ not anchored/m, 'a packet never claims an anchor it cannot have yet');
  const second = await runCli(['accept', '--uow', 'UOW-801', '--decision', 'approve', '--by', 'tech lead'], { cwd: root, env: { KIAI_UOW: 'UOW-801' } });
  assert.equal(second.code, 0, second.stderr);
  const md2 = fs.readFileSync(path.join(root, '.kiai', 'acceptance', 'acceptance-UOW-801.md'), 'utf8');
  assert.match(md2, /^- \*\*Anchored:\*\* \S+ covering \d+ records/m, 'a later packet carries the anchor written by the previous decision (AC-5)');

  r = await runCli(['accept', '--check', path.join('.kiai', 'acceptance', 'acceptance-UOW-801.md')], { cwd: root });
  assert.equal(r.code, 0, r.stderr);
  assert.match(r.stdout, /^OK \(footer only\) — packet hash/m);
  assert.match(r.stdout, /^SEALED — decision record seq/m);
  assert.match(r.stdout, /^ANCHORED — 2 anchor\(s\), latest .* covering \d+ records/m);

  // a draft does NOT anchor (it changes nothing in the chain)
  const before = readAnchors(root).length;
  await runCli(['accept', '--uow', 'UOW-801'], { cwd: root, env: { KIAI_UOW: 'UOW-801' } });
  assert.equal(readAnchors(root).length, before, 'a draft neither seals nor anchors');
});

test('anchors.jsonl is append-only text: two branches that each add one anchor merge with union and both survive (AC-1, plan 3b#2)', async () => {
  const root = tmpRoot();
  await seed(root, 1, 2);
  git(root, 'init', '-q', '.');
  git(root, 'config', 'user.email', 'a@b.c');
  git(root, 'config', 'user.name', 'probe');
  fs.writeFileSync(path.join(root, '.gitattributes'), '.kiai/anchors.jsonl merge=union\n');
  await runCli(['anchor', '--note', 'base'], { cwd: root });
  git(root, 'add', '-A'); git(root, 'commit', '-q', '-m', 'base');
  const main = git(root, 'rev-parse', '--abbrev-ref', 'HEAD');

  git(root, 'checkout', '-q', '-b', 'side');
  await seed(root, 3);
  await runCli(['anchor', '--note', 'side'], { cwd: root });
  git(root, 'add', '-A'); git(root, 'commit', '-q', '-m', 'side anchor');

  git(root, 'checkout', '-q', main);
  await runCli(['anchor', '--note', 'main'], { cwd: root });
  git(root, 'add', '-A'); git(root, 'commit', '-q', '-m', 'main anchor');

  execFileSync('git', ['merge', '--no-edit', 'side'], { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  const notes = readAnchors(root).map((a) => a.note);
  assert.deepEqual(notes.slice().sort(), ['base', 'main', 'side'], 'union merge keeps every anchor line');
  assert.equal(readAnchors(root).every((a) => a._ok), true, 'union merge does not corrupt any line');
});


test('review 123: an .gitignore rule that swallows .kiai/ is its OWN state — `git add` would refuse, so verify must say so (ứng viên seal x, đo 07/09)', async () => {
  const root = tmpRoot();
  git(root, 'init', '-q', '.');
  git(root, 'config', 'user.email', 'a@b.c');
  git(root, 'config', 'user.name', 'probe');
  fs.writeFileSync(path.join(root, '.gitignore'), '.kiai/\n');
  await seed(root, 1, 2);
  let r = await runCli(['anchor', '--by', 'lead'], { cwd: root });
  assert.equal(r.code, 0, r.stderr);
  assert.equal(anchorsTracked(root), 'ignored', 'ignored must not be reported as untracked/no-commit');
  assert.match(r.stdout, /IGNORED by a \.gitignore rule/);
  r = await runCli(['verify'], { cwd: root });
  assert.equal(r.code, 0);
  assert.match(r.stdout, /IGNORED by a \.gitignore rule .* `git add -f \.kiai\/anchors\.jsonl`/);
  r = await runCli(['status'], { cwd: root });
  assert.match(r.stdout, /anchors file: ignored/);
});

test('review 123 N1: a writers[] entry with count <= 0 proves nothing and is skipped, instead of asking for record seq -3', async () => {
  const root = tmpRoot();
  await seed(root, 1, 3);
  await runCli(['anchor'], { cwd: root });
  const file = anchorsFile(root);
  const a = JSON.parse(fs.readFileSync(file, 'utf8').trim());
  a.writers[0].count = -3;
  a.hash = anchorHash({ ...a, hash: undefined });
  delete a.hash;
  const fixed = { ...a };
  fixed.hash = anchorHash(fixed);
  fs.writeFileSync(file, JSON.stringify(fixed) + '\n');
  assert.equal(readAnchors(root)[0]._ok, true, 'the line itself is well formed — only the count is nonsense');
  const r = await runCli(['verify'], { cwd: root });
  assert.equal(r.code, 0, r.stdout);
  assert.doesNotMatch(r.stdout, /seq -3/);
});

test('review 123: a working tree BEHIND an anchor (git revert of a commit that carried records) is BROKEN, and the message names both readings', async () => {
  const root = tmpRoot();
  git(root, 'init', '-q', '.');
  git(root, 'config', 'user.email', 'a@b.c');
  git(root, 'config', 'user.name', 'probe');
  await seed(root, 1, 3);
  git(root, 'add', '-A'); git(root, 'commit', '-q', '-m', '3 records');
  await seed(root, 4, 5);
  git(root, 'add', '-A'); git(root, 'commit', '-q', '-m', '2 more');
  const withRecords = git(root, 'rev-parse', 'HEAD');
  await runCli(['anchor', '--by', 'lead'], { cwd: root });
  git(root, 'add', '-A'); git(root, 'commit', '-q', '-m', 'anchor@5');
  execFileSync('git', ['revert', '--no-edit', withRecords], { cwd: root, stdio: ['ignore', 'pipe', 'pipe'] });
  const r = await runCli(['verify'], { cwd: root });
  assert.equal(r.code, 1, 'an honest revert still lands on BROKEN — that is the design, so the text must explain it');
  assert.match(r.stdout, /tail truncated since anchor/);
  assert.match(r.stdout, /this working tree is BEHIND the anchor .*git log -p -- \.kiai\/anchors\.jsonl/);
});
