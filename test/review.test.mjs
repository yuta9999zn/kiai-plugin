// Tests written from the independent GATE 3 review of UOW-119 (2026-09-05): P1 tail truncation,
// P2 Markdown injection, P3 redaction coverage, P4 multi-writer git workflow, N1 dropped records,
// N2 no writes outside a repo, N8 CLI edge cases. Offline, temp dirs only.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import {
  GENESIS, recordHash, redact, summarizeTool, appendRecord, readAll, verifyChain, buildRecord, noteRecord,
  renderMarkdown, filterRecords, writerDir, writerId, flightDir, withLock, cell, listWriters,
} from '../lib/flight.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CLI = path.join(HERE, '..', 'bin', 'kiai.mjs');

function tmpRoot() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kiai-review-'));
  fs.mkdirSync(path.join(dir, '.kiai'), { recursive: true });
  return dir;
}

function runCli(args, { cwd, input = '', env = {} } = {}) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [CLI, ...args], { cwd, env: { ...process.env, ...env }, stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = ''; let stderr = '';
    child.stdout.on('data', (d) => { stdout += d; });
    child.stderr.on('data', (d) => { stderr += d; });
    child.on('close', (code) => resolve({ code, stdout, stderr }));
    child.stdin.end(input);
  });
}

const payload = (over = {}) => ({
  session_id: 'sess-1', hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_use_id: 'tu-1',
  tool_input: { command: 'echo hi', description: 'say hi' }, ...over,
});

function seed(root, n, over = {}) {
  for (let i = 0; i < n; i++) appendRecord(root, buildRecord(payload({ tool_use_id: 'tu-' + i, ...over }), { cwd: root, now: new Date(Date.UTC(2026, 8, 5, 1, 0, i)) }));
  return path.join(writerDir(root), '2026-09-05.jsonl');
}

// ---- P1: the local pointer is a witness against tail truncation / rewriting ----------------

test('P1 verify: deleting the LAST record is detected while this machine holds the pointer', () => {
  const root = tmpRoot();
  const file = seed(root, 4);
  const lines = fs.readFileSync(file, 'utf8').split('\n').filter(Boolean);
  fs.writeFileSync(file, lines.slice(0, 3).join('\n') + '\n');
  const v = verifyChain(root);
  assert.equal(v.ok, false);
  assert.equal(v.broken, 3);
  assert.match(v.reason, /tail truncated: this machine last wrote seq 4/);
});

test('P1 verify: rewriting the last record and recomputing its own hash is detected', () => {
  const root = tmpRoot();
  const file = seed(root, 3);
  const lines = fs.readFileSync(file, 'utf8').split('\n').filter(Boolean);
  const recs = lines.map((l) => JSON.parse(l));
  const last = { ...recs[2], input: { ...recs[2].input, command: 'rm -rf /' } };
  last.hash = recordHash(recs[1].hash, last);
  fs.writeFileSync(file, [lines[0], lines[1], JSON.stringify(last)].join('\n') + '\n');
  const v = verifyChain(root);
  assert.equal(v.ok, false);
  assert.match(v.reason, /tail rewritten/);
});

test('P1 verify: deleting the whole day file while the pointer remains is detected; status exits 1', async () => {
  const root = tmpRoot();
  const file = seed(root, 2);
  fs.rmSync(file);
  const v = verifyChain(root);
  assert.equal(v.ok, false);
  assert.match(v.reason, /tail truncated.*files end at seq 0/);
  const r = await runCli(['status'], { cwd: root });
  assert.equal(r.code, 1);
  assert.match(r.stdout, /BROKEN/);
});

test('P1 append: when files and pointer disagree, append continues from the files and seals an anomaly', () => {
  const root = tmpRoot();
  const file = seed(root, 4);
  const lines = fs.readFileSync(file, 'utf8').split('\n').filter(Boolean);
  fs.writeFileSync(file, lines.slice(0, 2).join('\n') + '\n'); // someone truncated the tail
  const next = appendRecord(root, buildRecord(payload(), { cwd: root }));
  assert.equal(next.seq, 3, 'continues from the files, not from the pointer');
  assert.equal(next.prev, JSON.parse(lines[1]).hash);
  assert.deepEqual(next.anomaly, { kind: 'pointer_mismatch', pointer_seq: 4, pointer_last: JSON.parse(lines[3]).hash, files_seq: 2, files_last: JSON.parse(lines[1]).hash });
  const v = verifyChain(root);
  assert.equal(v.ok, true, 'the chain is consistent again, and the anomaly is part of it');
  assert.equal(v.anomalies, 1);
  // the anomaly cannot be removed without breaking the chain
  const now = fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
  delete now[2].anomaly;
  fs.writeFileSync(file, now.map((r) => JSON.stringify(r)).join('\n') + '\n');
  assert.equal(verifyChain(root).ok, false);
});

test('P1 append: a stale pointer (older than the files) is also recorded, and seq never jumps or repeats', () => {
  const root = tmpRoot();
  seed(root, 5);
  fs.writeFileSync(path.join(writerDir(root), 'chain.json'), JSON.stringify({ seq: 2, last: 'deadbeef' }));
  const rec = appendRecord(root, buildRecord(payload(), { cwd: root }));
  assert.equal(rec.seq, 6);
  assert.equal(rec.anomaly.kind, 'pointer_mismatch');
  assert.equal(verifyChain(root).ok, true);
});

// ---- P4: one chain per writer — two clones / worktrees never touch the same file --------------

test('P4 two writers (two clones of one repo) keep separate chains; a git merge of both is intact', () => {
  if (!hasGit()) return;
  const bare = fs.mkdtempSync(path.join(os.tmpdir(), 'kiai-bare-'));
  execFileSync('git', ['init', '-q', '--bare', bare]);
  const a = fs.mkdtempSync(path.join(os.tmpdir(), 'kiai-a-'));
  const b = fs.mkdtempSync(path.join(os.tmpdir(), 'kiai-b-'));
  const g = (cwd, ...args) => execFileSync('git', args, { cwd, stdio: 'ignore' });
  g(a, 'clone', '-q', bare, '.'); g(a, 'config', 'user.email', 't@t'); g(a, 'config', 'user.name', 't'); g(a, 'checkout', '-q', '-b', 'main');
  fs.mkdirSync(path.join(a, '.kiai'));
  appendRecord(a, buildRecord(payload(), { cwd: a }));
  g(a, 'add', '-A'); g(a, 'commit', '-q', '-m', 'a1'); g(a, 'push', '-q', '-u', 'origin', 'main');
  g(b, 'clone', '-q', '-b', 'main', bare, '.'); g(b, 'config', 'user.email', 't@t'); g(b, 'config', 'user.name', 't');
  assert.equal(verifyChain(b).ok, true, 'a fresh clone verifies without any chain.json');
  appendRecord(b, buildRecord(payload({ session_id: 'sess-b' }), { cwd: b }));
  g(b, 'add', '-A'); g(b, 'commit', '-q', '-m', 'b1'); g(b, 'push', '-q');
  appendRecord(a, buildRecord(payload(), { cwd: a }));
  g(a, 'add', '-A'); g(a, 'commit', '-q', '-m', 'a2');
  g(a, 'pull', '-q', '--no-rebase', '--no-edit');
  const v = verifyChain(a);
  assert.equal(v.ok, true, v.reason);
  assert.equal(v.chains.length, 2, 'two writers, two chains');
  assert.equal(v.count, 3);
  assert.notEqual(writerId(a), writerId(b));
  const md = renderMarkdown(a, readAll(a), v);
  assert.match(md, /in 2 chains/);
});

test('P4 writer id: stable for one tree, different for another tree, overridable by KIAI_WRITER', () => {
  const root = tmpRoot();
  assert.equal(writerId(root), writerId(root));
  assert.notEqual(writerId(root), writerId(tmpRoot()));
  assert.match(writerId(root), /^[a-z0-9-]{1,16}-[0-9a-f]{6}$/);
  assert.equal(writerId(root, { KIAI_WRITER: 'ci-runner' }), 'ci-runner');
  assert.notEqual(writerId(root, { KIAI_WRITER: '../evil' }), '../evil');
});

test('P4 legacy flat layout (v0 probe files) is still read and verified as its own chain', () => {
  const root = tmpRoot();
  const legacy = flightDir(root); fs.mkdirSync(legacy, { recursive: true });
  const r1 = { v: 1, ts: '2026-09-04T00:00:00.000Z', event: 'note', agent: 'x', session: null, cwd: root, uow: null, text: 'old', seq: 1, prev: GENESIS };
  r1.hash = recordHash(GENESIS, r1);
  fs.writeFileSync(path.join(legacy, '2026-09-04.jsonl'), JSON.stringify(r1) + '\n');
  appendRecord(root, buildRecord(payload(), { cwd: root }));
  const v = verifyChain(root);
  assert.equal(v.ok, true, v.reason);
  assert.deepEqual(v.chains.map((c) => c.id ?? c.writer).sort(), ['', writerId(root)].sort());
  assert.equal(listWriters(root).length, 2);
});

// ---- N1: a record that cannot take the lock is not lost silently ------------------------------

test('N1 lock busy: the unsealed record lands in dropped.jsonl and verify/report warn about it', async () => {
  const root = tmpRoot();
  seed(root, 1);
  const lock = path.join(writerDir(root), '.lock');
  fs.mkdirSync(lock);
  assert.throws(() => withLock(writerDir(root), () => 'never', 150), /lock busy/);
  const r = await runCli(['record', 'PreToolUse'], { cwd: root, input: JSON.stringify(payload({ cwd: root, tool_use_id: 'dropped-1' })), env: { KIAI_LOCK_BUDGET_MS: '150' } });
  assert.equal(r.code, 0, 'hook still never fails the agent');
  assert.match(r.stderr, /lock busy/);
  fs.rmdirSync(lock);
  const dropped = fs.readFileSync(path.join(writerDir(root), 'dropped.jsonl'), 'utf8');
  assert.match(dropped, /"tool_use_id":"dropped-1"/);
  assert.match(dropped, /"dropped":"lock busy"/);
  const v = verifyChain(root);
  assert.equal(v.ok, true); assert.equal(v.count, 1); assert.equal(v.dropped, 1);
  const out = await runCli(['verify'], { cwd: root });
  assert.equal(out.code, 0);
  assert.match(out.stdout, /1 warning/); assert.match(out.stdout, /WARN — 1 dropped record/);
  assert.match(renderMarkdown(root, readAll(root), v), /Dropped records: 1/);
});

// ---- N2: never create .kiai outside a repo ----------------------------------------------------

test('N2 record outside any repo writes nothing and exits 0; a payload cwd that does not exist is ignored', async () => {
  const nowhere = fs.mkdtempSync(path.join(os.tmpdir(), 'kiai-nowhere-'));
  let r = await runCli(['record', 'PreToolUse'], { cwd: nowhere, input: JSON.stringify(payload({ cwd: nowhere })) });
  assert.equal(r.code, 0);
  assert.match(r.stderr, /nothing recorded/);
  assert.equal(fs.existsSync(path.join(nowhere, '.kiai')), false);
  const root = tmpRoot();
  const ghost = path.join(nowhere, 'nope', 'deeper');
  r = await runCli(['record', 'PreToolUse'], { cwd: root, input: JSON.stringify(payload({ cwd: ghost })) });
  assert.equal(r.code, 0);
  assert.equal(fs.existsSync(path.join(ghost, '.kiai')), false, 'no directory conjured from a bogus cwd');
  assert.equal(verifyChain(root).count, 1, 'recorded in the real repo instead');
});

// ---- P2: the evidence report cannot be forged from agent-controlled strings ---------------------

test('P2 report: pipes, newlines, headings and backticks in session/file/note/uow are neutralised', () => {
  const root = tmpRoot();
  const evilSession = 'x | 0 | 2099 | 2099 | 999 | 0 | 0 |\n## Session `INJECTED`';
  appendRecord(root, buildRecord(payload({ session_id: evilSession, tool_name: 'Write', tool_input: { file_path: 'a`|b.ts\n## FAKE', content: 'x' } }), { cwd: root }));
  appendRecord(root, noteRecord('line1\n## FAKE HEADING injected\n| a | b |\n- Chain: ✅ intact (999 records)', { cwd: root, by: 'x**bold**|y' }));
  const md = renderMarkdown(root, readAll(root), verifyChain(root), { uow: 'UOW-1 | x\n# H' });
  const lines = md.split('\n');
  const headings = lines.filter((l) => /^#/.test(l));
  assert.equal(headings.length, 3, 'title + one heading per session (evil session, notes): injected text never opens a heading of its own');
  assert.equal(lines.some((l) => /^#+ (FAKE|Session `INJECTED`)/.test(l)), false);
  assert.equal(lines.some((l) => /^- Chain: ✅ intact \(999/.test(l)), false, 'no forged chain line at column 0');
  const tableRows = lines.filter((l) => l.startsWith('|'));
  for (const row of tableRows) assert.equal(row.split(/(?<!\\)\|/).length, 9, `every table row has 7 cells: ${row}`);
  assert.match(md, /UoW UOW-1 \\\| x # H/);
  assert.match(md, /a'\\\|b\.ts ## FAKE/);
  assert.equal(cell('a\nb|c`d'), 'a b\\|c\'d');
});

// ---- P3: redaction covers the common credential families ---------------------------------------

// Fixture strings are concatenated so GitHub push protection does not mistake them for live secrets.
const SECRETS = [
  ['export AWS_SECRET_ACCESS_KEY=wJalrXUtnFEMI/K7MDENG/' + 'bPxRfiCYEXAMPLEKEY', 'wJalrXUtnFEMI'],
  ['github_' + 'pat_11ABCDEFG0abcdefghijklmnopqrstuvwxyz0123456789ABCDEFGHIJ', 'pat_11ABCDEFG0abcdef'],
  ['curl https://hooks.slack.com/' + 'services/T00000000/B00000000/' + 'X'.repeat(24), 'B00000000/XXXX'],
  ['git clone https://user:P%40ssw0rd123@github.com/org/repo.git', 'P%40ssw0rd123'],
  ['curl -H "Authorization: Basic dXNlcjpwYXNzd29yZDEyMw==" https://api', 'dXNlcjpwYXNzd29yZDEyMw=='],
  ['Authorization: Bearer abc123', 'Bearer abc123'],
  ['export DATABASE_URL=postgres://admin:s3cretPass@db.internal:5432/prod', 's3cretPass'],
  ['mysql -u root -p hunter2222 db', 'hunter2222'],
  ['mysql -u root --password hunter2222 db', 'hunter2222'],
  ['{"password":"hunter2222"}', 'hunter2222'],
  ['password=Zq7pvKt', 'Zq7pvKt'],
  ['curl -u admin:SuperSecret99 https://host', 'SuperSecret99'],
  ['SECRET_KEY=9f8e7d6c5b4a39281706f5e4d3c2b1a0', '9f8e7d6c5b4a'],
  ['token=Xw3nyRb', 'Xw3nyRb'],
  ['sk_live' + '_51H8abcdefghijklmnopqrstuvwxyz0123', '51H8abcdefghij'],
  ['sk_test' + '_51H8abcdefghijklmnopqrstuvwxyz0123', '51H8abcdefghij'],
  ['npm_' + 'abcdefghijklmnopqrstuvwxyz0123456789', 'abcdefghijklmnopqrstuvwxyz0123456789'],
  ['SG.' + 'abcdefghijklmnopqrstuv.wxyz0123456789abcdefghijklmnopqrstuvwxyz0123', 'wxyz0123456789abcdef'],
  ['TWILIO_API_KEY=SK' + '0123456789abcdef0123456789abcdef', 'SK0123456789abcdef'],
  ['glpat-' + 'abcdefghijklmnopqrst', 'abcdefghijklmnopqrst'],
  ['hf_' + 'abcdefghijklmnopqrstuvwxyz0123456', 'abcdefghijklmnopqrstuvwxyz0123456'],
  ['AccountName=x;AccountKey=abcdefghijklmnopqrstuvwxyz0123456789ABCDEF==;EndpointSuffix=core', 'abcdefghijklmnopqrstuvwxyz0123456789ABCDEF'],
  ['sshpass -p hunter2222 ssh host', 'hunter2222'],
  ['ANTHROPIC_API_KEY="sk-ant-' + 'api03-abcdefghijklmnop"', 'abcdefghijklmnop'],
  ['-----BEGIN OPENSSH ' + 'PRIVATE KEY-----\nb3BlbnNzaC1rZXk\n-----END OPENSSH ' + 'PRIVATE KEY-----', 'b3BlbnNzaC1rZXk'],
];

test('P3 redact: 25 common credential shapes never reach a record (Bash command, description, note, Grep pattern)', () => {
  const root = tmpRoot();
  for (const [text, marker] of SECRETS) {
    assert.equal(redact(text).includes(marker), false, `redact() leaked: ${text}`);
    const bash = summarizeTool('Bash', { command: text, description: text });
    assert.equal(JSON.stringify(bash).includes(marker), false, `Bash summary leaked: ${text}`);
    const grep = summarizeTool('Grep', { pattern: text, path: text });
    assert.equal(JSON.stringify(grep).includes(marker), false, `Grep summary leaked: ${text}`);
    appendRecord(root, noteRecord(text, { cwd: root, by: text }));
  }
  const jsonl = fs.readFileSync(path.join(writerDir(root), fs.readdirSync(writerDir(root)).find((f) => f.endsWith('.jsonl'))), 'utf8');
  for (const [text, marker] of SECRETS) assert.equal(jsonl.includes(marker), false, `note leaked: ${text}`);
});

test('P3 redact: ordinary commands are left alone (ports, flags, plain words)', () => {
  for (const ok of ['docker run -p 8080:80 nginx', 'git commit -m "tokenizer update"', 'ssh -p 2222 host', 'npm test -- --grep password', 'echo author: An', 'curl -u admin: https://host']) {
    assert.equal(redact(ok).includes('[REDACTED]'), false, `false positive: ${ok}`);
  }
});

// ---- N8: CLI edges ------------------------------------------------------------------------------

test('N8 cli: --since garbage exits 2 with a message; --out into a missing directory is created; verify names the file of a bad line', async () => {
  const root = tmpRoot();
  seed(root, 1);
  let r = await runCli(['report', '--since', 'garbage'], { cwd: root });
  assert.equal(r.code, 2); assert.match(r.stderr, /cannot parse date/);
  assert.equal(filterRecords(readAll(root), { since: '2026-09-01' }).length, 1);
  r = await runCli(['report', '--out', path.join('deep', 'er', 'evidence.md')], { cwd: root });
  assert.equal(r.code, 0);
  assert.ok(fs.existsSync(path.join(root, 'deep', 'er', 'evidence.md')));
  const file = path.join(writerDir(root), '2026-09-05.jsonl');
  fs.appendFileSync(file, '{"v":1,"event":"note","no_seq":true}\n');
  r = await runCli(['verify'], { cwd: root });
  assert.equal(r.code, 1);
  assert.match(r.stdout, /seq-less line in 2026-09-05\.jsonl/);
});

function hasGit() {
  try { execFileSync('git', ['--version'], { stdio: 'ignore' }); return true; } catch { return false; }
}
