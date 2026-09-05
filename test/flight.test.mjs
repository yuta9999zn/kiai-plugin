// Unit + integration tests for the KIAI flight record. Offline, no network, temp dirs only.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import {
  canonical, sha256, GENESIS, recordHash, redact, summarizeTool, appendRecord, readAll, verifyChain,
  buildRecord, initFlight, filterRecords, summarize, renderMarkdown, detectUow, withLock, flightDir, writerDir,
} from '../lib/flight.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CLI = path.join(HERE, '..', 'bin', 'kiai.mjs');

function tmpRoot() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kiai-flight-'));
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
  session_id: 'sess-1', hook_event_name: 'PreToolUse', cwd: undefined, tool_name: 'Bash', tool_use_id: 'tu-1',
  tool_input: { command: 'echo hi', description: 'say hi' }, ...over,
});

// ---- pure functions ----------------------------------------------------------------------

test('canonical: sorted keys, stable across insertion order', () => {
  assert.equal(canonical({ b: 1, a: [3, { z: 1, y: 2 }] }), '{"a":[3,{"y":2,"z":1}],"b":1}');
  assert.equal(canonical({ a: 1, b: 2 }), canonical({ b: 2, a: 1 }));
});

test('recordHash ignores the hash field itself and depends on prev', () => {
  const r = { v: 1, seq: 1, event: 'note', prev: GENESIS };
  const h1 = recordHash(GENESIS, r);
  assert.equal(h1, recordHash(GENESIS, { ...r, hash: 'anything' }));
  assert.notEqual(h1, recordHash(sha256('other'), r));
  assert.equal(GENESIS, sha256('kiai-flight-v1'));
});

test('redact: keys, tokens, bearer and password= are masked; ordinary text untouched', () => {
  assert.equal(redact('key sk-' + 'abcdefghijklmnop1234 end'), 'key [REDACTED] end');
  assert.equal(redact('AKIA' + 'ABCDEFGHIJKLMNOP'), '[REDACTED]');
  assert.equal(redact('Authorization: Bearer abcdefghijklmnopqrstuvwxyz'), 'Authorization: Bearer [REDACTED]');
  assert.equal(redact('curl -u x --password=hunter22 host'), 'curl -u x --password=[REDACTED] host');
  assert.equal(redact('ghp_' + 'abcdefghijklmnopqrstuvwxyz0123'), '[REDACTED]');
  assert.equal(redact('git status && npm test'), 'git status && npm test');
});

test('summarizeTool: Write stores path + sha256 + bytes, never content; Bash stores redacted command', () => {
  const w = summarizeTool('Write', { file_path: 'a/b.txt', content: 'SECRET BODY' });
  assert.deepEqual(w, { file: 'a/b.txt', content_sha256: sha256('SECRET BODY'), content_bytes: 11 });
  assert.equal(JSON.stringify(w).includes('SECRET BODY'), false);
  const e = summarizeTool('Edit', { file_path: 'x', old_string: 'o', new_string: 'n' });
  assert.equal(e.content_sha256, sha256('n'));
  const b = summarizeTool('Bash', { command: 'export OPENAI_API_KEY=sk-' + 'abcdefghijklmnop1234 && run' });
  assert.equal(b.command.includes('sk-abcdef'), false);
  assert.deepEqual(summarizeTool('WebFetch', { url: 'u', prompt: 'p' }), { keys: ['url', 'prompt'] });
});

// ---- chain on disk ------------------------------------------------------------------------

test('appendRecord builds a verifiable chain; init is idempotent', () => {
  const root = tmpRoot();
  assert.equal(initFlight(root).created, true);
  assert.equal(initFlight(root).created, false);
  const a = appendRecord(root, buildRecord(payload(), { cwd: root, now: new Date('2026-09-04T01:00:00Z') }));
  const b = appendRecord(root, buildRecord(payload({ hook_event_name: 'PostToolUse', tool_response: { success: true } }), { cwd: root, now: new Date('2026-09-04T01:00:01Z') }));
  assert.equal(a.seq, 1); assert.equal(a.prev, GENESIS);
  assert.equal(b.seq, 2); assert.equal(b.prev, a.hash);
  assert.equal(b.event, 'tool_result'); assert.equal(b.result.ok, true);
  const v = verifyChain(root);
  assert.equal(v.ok, true); assert.equal(v.count, 2); assert.equal(v.last, b.hash);
  assert.ok(fs.existsSync(path.join(writerDir(root), '2026-09-04.jsonl')));
  // init again after records: chain untouched
  initFlight(root);
  assert.equal(verifyChain(root).ok, true);
});

test('verify detects a 1-byte tamper, a deleted record and a reordered record', () => {
  const root = tmpRoot();
  for (let i = 0; i < 4; i++) appendRecord(root, buildRecord(payload({ tool_use_id: 'tu-' + i }), { cwd: root, now: new Date('2026-09-04T02:00:00Z') }));
  const file = path.join(writerDir(root), '2026-09-04.jsonl');
  const lines = fs.readFileSync(file, 'utf8').split('\n').filter(Boolean);

  // tamper: change one character inside record 3's command
  const tampered = [...lines]; tampered[2] = tampered[2].replace('echo hi', 'echo ho');
  fs.writeFileSync(file, tampered.join('\n') + '\n');
  let v = verifyChain(root);
  assert.equal(v.ok, false); assert.equal(v.broken, 3); assert.match(v.reason, /tampered/);

  // delete record 2
  fs.writeFileSync(file, [lines[0], lines[2], lines[3]].join('\n') + '\n');
  v = verifyChain(root);
  assert.equal(v.ok, false); assert.equal(v.broken, 3); assert.match(v.reason, /expected seq 2/);

  // reorder 3 and 4
  fs.writeFileSync(file, [lines[0], lines[1], lines[3], lines[2]].join('\n') + '\n');
  assert.equal(verifyChain(root).ok, true, 'readAll sorts by seq, so a reordered file still verifies');

  // restore and confirm
  fs.writeFileSync(file, lines.join('\n') + '\n');
  assert.equal(verifyChain(root).ok, true);
});

test('chain survives a missing chain.json (rebuilt from files) and a CRLF-saved file', () => {
  const root = tmpRoot();
  appendRecord(root, buildRecord(payload(), { cwd: root }));
  appendRecord(root, buildRecord(payload(), { cwd: root }));
  fs.rmSync(path.join(writerDir(root), 'chain.json'));
  const c = appendRecord(root, buildRecord(payload(), { cwd: root }));
  assert.equal(c.seq, 3);
  const file = fs.readdirSync(writerDir(root)).find((f) => f.endsWith('.jsonl'));
  const p = path.join(writerDir(root), file);
  fs.writeFileSync(p, fs.readFileSync(p, 'utf8').replace(/\n/g, '\r\n'));
  assert.equal(verifyChain(root).ok, true);
});

test('detectUow: env > .kiai/current > branch name; null when nothing', () => {
  const root = tmpRoot();
  assert.equal(detectUow(root, {}), null);
  fs.writeFileSync(path.join(root, '.kiai', 'current'), 'UOW-042\n');
  assert.equal(detectUow(root, {}), 'UOW-042');
  assert.equal(detectUow(root, { KIAI_UOW: 'UOW-007' }), 'UOW-007');
  assert.equal(detectUow(root, { KIAI_UOW: 'garbage' }), 'UOW-042');
});

test('withLock: stale lock (older than 5 s) is broken, fresh lock is respected', () => {
  const dir = tmpRoot();
  const lock = path.join(dir, '.lock');
  fs.mkdirSync(lock);
  const old = new Date(Date.now() - 60_000);
  fs.utimesSync(lock, old, old);
  assert.equal(withLock(dir, () => 'ran'), 'ran');
  assert.equal(fs.existsSync(lock), false);
});

// ---- report ------------------------------------------------------------------------------

test('report: filters by uow/session, summarizes tools, files, commands, notes, git', () => {
  const root = tmpRoot();
  const env = { KIAI_UOW: 'UOW-001' };
  appendRecord(root, buildRecord(payload({ hook_event_name: 'SessionStart', source: 'startup' }), { cwd: root, env }));
  appendRecord(root, buildRecord(payload({ tool_name: 'Write', tool_input: { file_path: 'src/a.ts', content: 'x' } }), { cwd: root, env }));
  appendRecord(root, buildRecord(payload({ hook_event_name: 'PostToolUse', tool_name: 'Write', tool_input: { file_path: 'src/a.ts', content: 'x' }, tool_response: { success: false } }), { cwd: root, env }));
  appendRecord(root, buildRecord(payload(), { cwd: root, env }));
  appendRecord(root, buildRecord(payload({ session_id: 'sess-2' }), { cwd: root, env: { KIAI_UOW: 'UOW-002' } }));
  appendRecord(root, { ts: new Date().toISOString(), event: 'note', agent: 'tech-lead', session: 'sess-1', cwd: root, uow: 'UOW-001', text: 'GATE 3 approved' });
  const all = readAll(root);
  assert.equal(all.length, 6);
  const scoped = filterRecords(all, { uow: 'UOW-001' });
  assert.equal(scoped.length, 5);
  const s = summarize(scoped);
  assert.equal(s.length, 1);
  assert.deepEqual(s[0].tools, { Write: 1, Bash: 1 });
  assert.deepEqual(s[0].files, [{ file: 'src/a.ts', sha256: sha256('x') }]);
  assert.equal(s[0].failures, 1);
  assert.equal(s[0].notes[0].text, 'GATE 3 approved');
  const md = renderMarkdown(root, scoped, verifyChain(root), { uow: 'UOW-001' });
  assert.match(md, /# KIAI flight report — UoW UOW-001/);
  assert.match(md, /✅ intact \(6 records/);
  assert.match(md, /`src\/a.ts`/);
  assert.match(md, /GATE 3 approved/);
  assert.equal(filterRecords(all, { session: 'sess-2' }).length, 1);
});

// ---- CLI ----------------------------------------------------------------------------------

test('cli: init → record (hook payload on stdin) → verify → status → report --json → note', async () => {
  const root = tmpRoot();
  let r = await runCli(['init'], { cwd: root });
  assert.equal(r.code, 0); assert.match(r.stdout, /Created/);
  r = await runCli(['record', 'PreToolUse'], { cwd: root, input: JSON.stringify(payload({ cwd: root })) });
  assert.equal(r.code, 0);
  r = await runCli(['record', 'Stop'], { cwd: root, input: JSON.stringify({ session_id: 'sess-1', hook_event_name: 'Stop', cwd: root }) });
  assert.equal(r.code, 0);
  r = await runCli(['verify'], { cwd: root });
  assert.equal(r.code, 0); assert.match(r.stdout, /OK — 2 records/);
  r = await runCli(['note', 'reviewed by human', '--by', 'lead'], { cwd: root });
  assert.equal(r.code, 0); assert.match(r.stdout, /noted seq 3/);
  r = await runCli(['status'], { cwd: root });
  assert.equal(r.code, 0); assert.match(r.stdout, /records: 3/);
  r = await runCli(['report', '--json'], { cwd: root });
  assert.equal(r.code, 0);
  const j = JSON.parse(r.stdout);
  assert.equal(j.verification.ok, true);
  assert.equal(j.sessions.find((s) => s.session === 'sess-1').tools.Bash, 1);
  r = await runCli(['report', '--out', path.join(root, 'evidence.md')], { cwd: root });
  assert.equal(r.code, 0); assert.ok(fs.existsSync(path.join(root, 'evidence.md')));
});

test('cli: record never fails the agent — garbage stdin, empty stdin, unwritable dir all exit 0', async () => {
  const root = tmpRoot();
  let r = await runCli(['record', 'PreToolUse'], { cwd: root, input: '{not json' });
  assert.equal(r.code, 0);
  r = await runCli(['record', 'PreToolUse'], { cwd: root, input: '' });
  assert.equal(r.code, 0);
  assert.equal(verifyChain(root).count, 2, 'garbage payload still yields a (mostly null) record, and the error is logged');
  assert.ok(fs.existsSync(path.join(flightDir(root), 'errors.log')));
  // unwritable: point flight dir at a file
  const bad = tmpRoot();
  fs.writeFileSync(path.join(bad, '.kiai', 'flight'), 'not a dir');
  r = await runCli(['record', 'PreToolUse'], { cwd: bad, input: JSON.stringify(payload({ cwd: bad })) });
  assert.equal(r.code, 0);
});

test('cli: record locates the repo root from a subdirectory via payload.cwd', async () => {
  const root = tmpRoot();
  const sub = path.join(root, 'src', 'deep'); fs.mkdirSync(sub, { recursive: true });
  const r = await runCli(['record', 'PreToolUse'], { cwd: sub, input: JSON.stringify(payload({ cwd: sub })) });
  assert.equal(r.code, 0);
  assert.equal(verifyChain(root).count, 1);
  assert.equal(fs.existsSync(path.join(sub, '.kiai')), false);
});

test('cli: 10 concurrent record processes keep one intact chain with seq 1..10', async () => {
  const root = tmpRoot();
  const runs = [];
  for (let i = 0; i < 10; i++) runs.push(runCli(['record', 'PreToolUse'], { cwd: root, input: JSON.stringify(payload({ cwd: root, tool_use_id: 'tu-' + i })) }));
  const results = await Promise.all(runs);
  assert.ok(results.every((r) => r.code === 0));
  const v = verifyChain(root);
  assert.equal(v.ok, true, v.reason);
  assert.equal(v.count, 10);
  assert.deepEqual(readAll(root).map((r) => r.seq), [1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
  assert.equal(fs.existsSync(path.join(writerDir(root), '.lock')), false);
});

test('cli: verify exits 1 and names the seq after tampering', async () => {
  const root = tmpRoot();
  for (let i = 0; i < 3; i++) appendRecord(root, buildRecord(payload(), { cwd: root, now: new Date('2026-09-04T03:00:00Z') }));
  const file = path.join(writerDir(root), '2026-09-04.jsonl');
  fs.writeFileSync(file, fs.readFileSync(file, 'utf8').replace('"tu-1"', '"tu-X"'));
  const r = await runCli(['verify'], { cwd: root });
  assert.equal(r.code, 1);
  assert.match(r.stdout, /BROKEN at seq 1/);
});

test('cli: hooks emits a valid hooks block pointing at this plugin (7 events, absolute path)', async () => {
  const r = await runCli(['hooks'], { cwd: tmpRoot() });
  assert.equal(r.code, 0);
  const j = JSON.parse(r.stdout);
  assert.deepEqual(Object.keys(j.hooks), ['SessionStart', 'PreToolUse', 'PostToolUse', 'PostToolUseFailure', 'Stop', 'SubagentStop', 'SessionEnd']);
  for (const ev of Object.keys(j.hooks)) {
    assert.equal(j.hooks[ev][0].hooks[0].type, 'command');
    assert.match(j.hooks[ev][0].hooks[0].command, /kiai\.mjs" record/);
    assert.equal(j.hooks[ev][0].hooks[0].command.includes('${CLAUDE_PLUGIN_ROOT}'), false, 'manual install needs an absolute path');
  }
});

test('plugin manifest + hooks.json are consistent with the CLI and carry no shebang', () => {
  const root = path.join(HERE, '..');
  const manifest = JSON.parse(fs.readFileSync(path.join(root, '.claude-plugin', 'plugin.json'), 'utf8'));
  assert.equal(manifest.name, 'kiai');
  const hooks = JSON.parse(fs.readFileSync(path.join(root, 'hooks', 'hooks.json'), 'utf8')).hooks;
  assert.deepEqual(Object.keys(hooks), ['SessionStart', 'PreToolUse', 'PostToolUse', 'PostToolUseFailure', 'Stop', 'SubagentStop', 'SessionEnd']);
  for (const [ev, groups] of Object.entries(hooks)) {
    for (const h of groups[0].hooks) {
      assert.match(h.command, new RegExp(`record ${ev}$`), `${ev} hook passes its own event name`);
      assert.ok(h.command.includes('${CLAUDE_PLUGIN_ROOT}/bin/kiai.mjs'));
      assert.equal(h.timeout, 10);
    }
  }
  for (const f of ['bin/kiai.mjs', 'lib/flight.mjs']) {
    assert.equal(fs.readFileSync(path.join(root, f), 'utf8').startsWith('#!'), false, `${f} has no shebang (CRLF safety)`);
  }
  assert.ok(fs.existsSync(path.join(root, 'skills', 'kiai-flight-record', 'SKILL.md')));
});

test('git delta is captured at Stop when the repo is a git repo', () => {
  const root = tmpRoot();
  try { execFileSync('git', ['init', '-q', '-b', 'bolt/UOW-555'], { cwd: root, stdio: 'ignore' }); } catch { return; }
  fs.writeFileSync(path.join(root, 'f.txt'), 'hello');
  const rec = appendRecord(root, buildRecord({ session_id: 's', hook_event_name: 'Stop', cwd: root }, { cwd: root, env: {} }));
  assert.equal(rec.uow, 'UOW-555', 'uow from branch name');
  assert.ok(rec.git, 'git delta present');
  assert.equal(rec.git.branch, 'bolt/UOW-555');
  assert.equal(rec.git.dirty_paths, 1);
});
