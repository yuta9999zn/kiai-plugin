// Tests for `kiai import codex` (UOW-124): KIAI records built from the session logs Codex CLI writes.
// Offline, temp dirs only. Fixtures are real Codex rollouts — see test/fixtures/codex/README.md.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { appendRecord, buildRecord, readAll, readWriter, verifyChain, flightDir, writerId, sha256 } from '../lib/flight.mjs';
import { importCodex, codexWriter, listRollouts, sessionMeta, readRollout, insideRoot, codexHome } from '../lib/import-codex.mjs';
import { collectUow, isTestCommand, unwrapCommand, reconcileDisk, buildPacket, renderPacket } from '../lib/accept.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CLI = path.join(HERE, '..', 'bin', 'kiai.mjs');
const FIXTURES = path.join(HERE, 'fixtures', 'codex');

function tmpRoot(name = 'kiai-import-') {
  const dir = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), name)));
  fs.mkdirSync(path.join(dir, '.kiai'), { recursive: true });
  return dir;
}

/**
 * Copy fixtures into a fake CODEX_HOME, substituting the repository path for the `__ROOT__` token.
 * Lines are parsed and re-serialised so a Windows path's backslashes cannot corrupt the JSON.
 */
function fakeCodexHome(root, files) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-home-'));
  const day = path.join(home, 'sessions', '2026', '09', '17');
  fs.mkdirSync(day, { recursive: true });
  // Keys matter too: `patch_apply_end.changes` is keyed BY PATH.
  const swap = (v) => (typeof v === 'string' ? v.split('__ROOT__').join(root)
    : Array.isArray(v) ? v.map(swap)
      : v && typeof v === 'object' ? Object.fromEntries(Object.entries(v).map(([k, x]) => [swap(k), swap(x)])) : v);
  for (const [fixture, name] of Object.entries(files)) {
    const out = fs.readFileSync(path.join(FIXTURES, fixture), 'utf8')
      .split(/\r?\n/).filter((l) => l.trim())
      .map((l) => JSON.stringify(swap(JSON.parse(l))))
      .join('\n') + '\n';
    fs.writeFileSync(path.join(day, name), out);
  }
  return home;
}

function runCli(args, { cwd, env = {} } = {}) {
  const clean = { ...process.env }; delete clean.CLAUDECODE; delete clean.CLAUDE_CODE_ENTRYPOINT; delete clean.KIAI_WRITER;
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [CLI, ...args], { cwd, env: { ...clean, ...env }, stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = ''; let stderr = '';
    child.stdout.on('data', (d) => { stdout += d; });
    child.stderr.on('data', (d) => { stderr += d; });
    child.on('close', (code) => resolve({ code, stdout, stderr }));
    child.stdin.end('');
  });
}

const ENV = { KIAI_UOW: 'UOW-124' };
// Exactly how Codex invokes a shell (measured: 996/996 real CommandExecution records).
const PWSH = String.raw`C:\Users\nguye\.cache\codex-runtimes\codex-primary-runtime\dependencies\pwsh\pwsh.exe`;
const codexRecords = (root) => readWriter(path.join(flightDir(root), codexWriter(root)), codexWriter(root));

// ---- TS-124-01 --------------------------------------------------------------------------

test('TS-124-01 import reads sessions from this repo only: another repo and a headless rollout are skipped, with reasons', () => {
  const root = tmpRoot();
  const home = fakeCodexHome(root, {
    'inside-codemode.jsonl': 'rollout-2026-09-17T10-37-38-a.jsonl',
    'outside-repo.jsonl': 'rollout-2026-09-17T10-38-00-b.jsonl',
    'no-meta.jsonl': 'rollout-2026-09-17T10-39-00-c.jsonl',
  });
  const res = importCodex(root, { home, env: { ...process.env, ...ENV } });

  assert.equal(res.files_seen, 3);
  assert.equal(res.files_read, 1, 'only the session whose cwd is this repo is read');
  assert.ok(res.imported > 0);
  const reasons = res.skipped.map((s) => s.reason).sort();
  assert.deepEqual(reasons, ['no session_meta line', 'session cwd is outside this repo']);
  // nothing from the other repository reached the chain
  const sessions = new Set(codexRecords(root).map((r) => r.session));
  assert.ok(!sessions.has('00000000-outside-0000-000000000000'));
});

test('TS-124-01b no .kiai/ and no sessions directory are both refused with exit 2', async () => {
  const bare = fs.mkdtempSync(path.join(os.tmpdir(), 'kiai-bare-'));
  fs.mkdirSync(path.join(bare, '.git'));
  const r1 = await runCli(['import', 'codex'], { cwd: bare });
  assert.equal(r1.code, 2);
  assert.match(r1.stderr, /no \.kiai\//);
  assert.ok(!fs.existsSync(path.join(bare, '.kiai')), 'a refused import creates nothing');

  const root = tmpRoot();
  const empty = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-empty-'));
  const r2 = await runCli(['import', 'codex', '--home', empty], { cwd: root });
  assert.equal(r2.code, 2);
  assert.match(r2.stderr, /no Codex sessions directory/);
  assert.ok(r2.stderr.includes(empty), 'the message names the directory it looked in');
});

// ---- TS-124-02 --------------------------------------------------------------------------

test('TS-124-02 imported records carry agent/via/src, land in their own chain, and leave the hook chain untouched', () => {
  const root = tmpRoot();
  // a hook record first: this is the live chain that must not move
  appendRecord(root, buildRecord({ session_id: 's1', hook_event_name: 'SessionStart' }, { cwd: root, root, env: ENV }));
  const hookDir = path.join(flightDir(root), writerId(root, {}));
  const before = readWriter(hookDir);
  assert.equal(before.length, 1);

  const home = fakeCodexHome(root, { 'inside-codemode.jsonl': 'rollout-2026-09-17T10-37-38-a.jsonl' });
  importCodex(root, { home, env: { ...process.env, ...ENV } });

  const after = readWriter(hookDir);
  assert.equal(after.length, 1, 'the hook chain gained no records');
  assert.equal(after[0].hash, before[0].hash, 'the hook chain head is unchanged');

  const recs = codexRecords(root);
  assert.ok(recs.length >= 8);
  assert.ok(codexWriter(root).endsWith('-codex'));
  for (const r of recs) {
    assert.equal(r.agent, 'codex-cli');
    assert.equal(r.via, 'import', 'every imported record says so on its face');
    assert.equal(typeof r.src.file, 'string');
    assert.equal(r.src.sha256.length, 64);
    assert.ok(r.src.ordinal === null || Number.isInteger(r.src.ordinal), 'the source ordinal, or null — never invented');
    assert.ok(Number.isInteger(r.src.line) && r.src.line >= 1, 'the real line number in the source file');
    assert.equal(typeof r.src.kind, 'string');
    assert.ok(!path.isAbsolute(r.src.file), 'the source path is relative to the sessions dir, not the machine');
  }
  assert.equal(recs[0].event, 'session_start');
  assert.equal(recs[0].client.cli_version, '0.153.4');
  assert.equal(verifyChain(root).ok, true);
});

// ---- TS-124-03 --------------------------------------------------------------------------

test('TS-124-03 importing twice writes nothing the second time; new log lines import as exactly those lines', () => {
  const root = tmpRoot();
  const home = fakeCodexHome(root, { 'inside-codemode.jsonl': 'rollout-2026-09-17T10-37-38-a.jsonl' });
  const first = importCodex(root, { home, env: { ...process.env, ...ENV } });
  assert.ok(first.imported > 0);

  const second = importCodex(root, { home, env: { ...process.env, ...ENV } });
  assert.equal(second.imported, 0, 'a second import is a no-op');
  assert.equal(second.duplicates, first.imported);
  assert.equal(codexRecords(root).length, first.imported);

  // Codex keeps writing to the same rollout: two more lines, two more records.
  const file = path.join(home, 'sessions', '2026', '09', '17', 'rollout-2026-09-17T10-37-38-a.jsonl');
  const extra = [
    { timestamp: '2026-09-17T04:00:00.000Z', ordinal: 900, type: 'event_msg', payload: { type: 'item_completed', item: { type: 'CommandExecution', id: 'exec-new-1', command: ['echo', 'later'], cwd: root, status: 'completed', stdout: 'later\n' } } },
    { timestamp: '2026-09-17T04:00:01.000Z', ordinal: 901, type: 'event_msg', payload: { type: 'task_complete', turn_id: 't2', last_agent_message: 'done' } },
  ].map((o) => JSON.stringify(o)).join('\n') + '\n';
  fs.appendFileSync(file, extra);

  const third = importCodex(root, { home, env: { ...process.env, ...ENV } });
  assert.equal(third.imported, 2);
  assert.equal(verifyChain(root).ok, true);
});

test('TS-124-03b ONE session spread over several rollout files loses nothing (R P1)', () => {
  // 8 of the 85 real logs on the build machine belong to a session with more than one file; one
  // session has 30. Every file restarts its line numbering, so a key built on the session alone made
  // the second file's lines collide with the first file's and vanish as "already imported".
  const root = tmpRoot();
  const home = fakeCodexHome(root, {
    'inside-codemode.jsonl': 'rollout-2026-09-17T10-37-38-a.jsonl',
    'no-meta.jsonl': 'rollout-2026-09-17T10-38-00-b.jsonl',
  });
  const dir = path.join(home, 'sessions', '2026', '09', '17');
  // give file b the SAME session_meta as file a, so both files belong to one session
  const a = fs.readFileSync(path.join(dir, 'rollout-2026-09-17T10-37-38-a.jsonl'), 'utf8').split('\n').filter(Boolean);
  const b = fs.readFileSync(path.join(dir, 'rollout-2026-09-17T10-38-00-b.jsonl'), 'utf8').split('\n').filter(Boolean);
  fs.writeFileSync(path.join(dir, 'rollout-2026-09-17T10-38-00-b.jsonl'), [a[0], ...b].join('\n') + '\n');

  const res = importCodex(root, { home, env: { ...process.env, ...ENV } });
  assert.equal(res.files_read, 2);
  assert.equal(res.duplicates, 0, 'two files of one session are not each other’s duplicates');
  const recs = codexRecords(root);
  const perFile = new Map();
  for (const r of recs) perFile.set(r.src.file, (perFile.get(r.src.file) || 0) + 1);
  assert.equal(perFile.size, 2, 'both files contributed records');
  for (const n of perFile.values()) assert.ok(n > 1);
  assert.equal(new Set(recs.map((r) => `${r.src.file}#${r.src.line}`)).size, recs.length, 'one record per source line');
  assert.equal(importCodex(root, { home, env: { ...process.env, ...ENV } }).imported, 0, 'still idempotent');
});

test('TS-124-03c a rollout with no `ordinal` (every Codex up to 0.148.x) imports fully and says ordinal: null (R P2)', () => {
  const root = tmpRoot();
  const home = fakeCodexHome(root, { 'legacy-functioncall.jsonl': 'rollout-2026-09-17T10-40-00-legacy.jsonl' });
  const dir = path.join(home, 'sessions', '2026', '09', '17');
  const first = fs.readFileSync(path.join(dir, 'rollout-2026-09-17T10-40-00-legacy.jsonl'), 'utf8');
  assert.ok(!first.split('\n').filter(Boolean).some((l) => 'ordinal' in JSON.parse(l)), 'the fixture must carry no ordinal');

  // a second file of the SAME session, the case that used to import zero records
  const lines = first.split('\n').filter(Boolean);
  fs.writeFileSync(path.join(dir, 'rollout-2026-09-17T10-41-00-legacy2.jsonl'), [lines[0], JSON.stringify({
    timestamp: '2026-08-14T16:30:00.000Z', type: 'event_msg',
    payload: { type: 'item_completed', item: { type: 'CommandExecution', id: 'exec-legacy-2', command: ['rm', '-rf', 'build'], cwd: root, status: 'completed', stdout: '' } },
  })].join('\n') + '\n');

  const res = importCodex(root, { home, env: { ...process.env, ...ENV } });
  assert.equal(res.files_read, 2);
  const recs = codexRecords(root);
  for (const r of recs) {
    assert.equal(r.src.ordinal, null, 'a position the source never wrote must not be invented');
    assert.ok(Number.isInteger(r.src.line) && r.src.line >= 1, 'the line number is real and points into the file');
  }
  assert.ok(recs.some((r) => r.input && r.input.command === 'rm -rf build'), 'the second file’s command reached the chain');
  assert.equal(importCodex(root, { home, env: { ...process.env, ...ENV } }).imported, 0);
});

test('TS-124-03d an imported stop claims no git state (R P4)', () => {
  const root = tmpRoot();
  const home = fakeCodexHome(root, { 'inside-codemode.jsonl': 'rollout-2026-09-17T10-37-38-a.jsonl' });
  importCodex(root, { home, env: { ...process.env, ...ENV } });
  const stop = codexRecords(root).find((r) => r.event === 'stop');
  assert.ok(stop, 'task_complete became a stop record');
  assert.equal(stop.git, undefined, 'the tree at IMPORT time is not the tree when Codex stopped; say nothing rather than something false');
});

// ---- TS-124-04 --------------------------------------------------------------------------

test('TS-124-04 both rollout shapes are read: code-mode custom_tool_call and legacy function_call', () => {
  const root = tmpRoot();
  const home = fakeCodexHome(root, {
    'inside-codemode.jsonl': 'rollout-2026-09-17T10-37-38-a.jsonl',
    'legacy-functioncall.jsonl': 'rollout-2026-09-17T10-40-00-legacy.jsonl',
  });
  const res = importCodex(root, { home, env: { ...process.env, ...ENV } });
  assert.equal(res.files_read, 2);
  const recs = codexRecords(root);

  // code mode: the model sends JavaScript; we keep what it called and what it ran, not the source
  const codeCall = recs.find((r) => r.src.kind === 'custom_tool_call' && r.input && r.input.tools);
  assert.ok(codeCall, 'a custom_tool_call became a tool_call');
  assert.equal(codeCall.event, 'tool_call');
  assert.equal(codeCall.tool, 'exec');
  assert.match(codeCall.tool_use_id, /^call_/);
  assert.equal(codeCall.input.code_sha256.length, 64);

  // legacy: arguments is a JSON string
  const legacy = recs.find((r) => r.event === 'tool_call' && r.tool === 'shell');
  assert.ok(legacy, 'a function_call became a tool_call');
  assert.equal(legacy.tool_use_id, 'call_legacy_1');
  assert.equal(legacy.input.command, 'npm test');
  const legacyOut = recs.find((r) => r.event === 'tool_result' && r.tool_use_id === 'call_legacy_1');
  assert.ok(legacyOut, 'its output was paired by call_id');

  // both shapes produce a prompt record, hashed not stored
  const prompts = recs.filter((r) => r.event === 'prompt');
  assert.equal(prompts.length, 2, 'one from item:UserMessage, one from event_msg.user_message');
  for (const p of prompts) assert.equal(p.prompt_sha256.length, 64);
});

// ---- TS-124-05 --------------------------------------------------------------------------

test('TS-124-05 file changes are recorded as path + hash + size, and no file content reaches .kiai/', () => {
  const root = tmpRoot();
  const home = fakeCodexHome(root, {
    'inside-codemode.jsonl': 'rollout-2026-09-17T10-37-38-a.jsonl',
    'legacy-functioncall.jsonl': 'rollout-2026-09-17T10-40-00-legacy.jsonl',
  });
  importCodex(root, { home, env: { ...process.env, ...ENV } });
  const recs = codexRecords(root);

  const change = recs.find((r) => r.tool === 'FileChange');
  assert.ok(change, 'item_completed FileChange became a tool_result');
  const hello = change.input.files.find((f) => f.file === 'hello.txt');
  assert.ok(hello, 'the path is relative to the repository');
  assert.equal(hello.change, 'add');
  assert.equal(hello.content_sha256, sha256('HELLO_KIAI_FIXTURE\n'));
  assert.equal(hello.content_bytes, 19);

  const patch = recs.find((r) => r.tool === 'apply_patch');
  assert.ok(patch, 'legacy patch_apply_end became a tool_result');
  const byPath = Object.fromEntries(patch.input.files.map((f) => [f.file, f]));
  assert.equal(byPath['greeting.txt'].change, 'add');
  assert.equal(byPath['greeting.txt'].content_sha256, sha256('LEGACY_FIXTURE_CONTENT\n'));
  assert.equal(byPath['README.md'].change, 'update');
  assert.equal(byPath['README.md'].content_sha256, undefined, 'an update carries a diff, not the whole file: no full-file hash may be claimed');
  assert.equal(byPath['gone.txt'].change, 'delete');

  // THE LOCK: the first version of this importer copied file contents into the chain through a raw
  // preview of the code-mode source. Nothing under .kiai/ may contain the fixtures' contents.
  const seen = [];
  const walk = (dir) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) walk(full);
      else seen.push(fs.readFileSync(full, 'utf8'));
    }
  };
  walk(path.join(root, '.kiai'));
  const all = seen.join('\n');
  for (const secretish of ['HELLO_KIAI_FIXTURE', 'LEGACY_FIXTURE_CONTENT', 'Begin Patch']) {
    assert.ok(!all.includes(secretish), `file content "${secretish}" must never be written into the flight record`);
  }
});

test('TS-124-05c a log written with the OTHER separator still resolves inside the repo (CI, ubuntu)', () => {
  const root = tmpRoot();
  const home = fakeCodexHome(root, { 'inside-codemode.jsonl': 'rollout-2026-09-17T10-37-38-a.jsonl' });
  const file = path.join(home, 'sessions', '2026', '09', '17', 'rollout-2026-09-17T10-37-38-a.jsonl');
  // A Windows-recorded rollout read on a POSIX host (and the reverse): the separator between the repo
  // root and the file is the one the OTHER platform uses. It is still a file inside this repository.
  const other = path.sep === '\\' ? root.split('\\').join('/') : root.split('/').join('\\');
  fs.appendFileSync(file, JSON.stringify({
    timestamp: '2026-09-17T04:30:00.000Z', ordinal: 970, type: 'event_msg',
    payload: {
      type: 'item_completed',
      item: { type: 'FileChange', id: 'exec-sep', status: 'completed', stdout: '', changes: { [`${other}${path.sep === '\\' ? '/' : '\\'}deep${path.sep === '\\' ? '/' : '\\'}file.txt`]: { type: 'add', content: 'SEP\n' } } },
    },
  }) + '\n');
  importCodex(root, { home, env: { ...process.env, ...ENV } });
  const rec = codexRecords(root).find((r) => r.tool_use_id === 'exec-sep');
  assert.equal(rec.input.files[0].file, 'deep/file.txt');
  assert.equal(rec.input.files[0].outside_repo, undefined, 'it must not be reported as a write outside the repository');
});

test('TS-124-05b a code-mode blob we cannot read is labelled, never copied in', () => {
  const root = tmpRoot();
  const home = fakeCodexHome(root, { 'inside-codemode.jsonl': 'rollout-2026-09-17T10-37-38-a.jsonl' });
  const file = path.join(home, 'sessions', '2026', '09', '17', 'rollout-2026-09-17T10-37-38-a.jsonl');
  fs.appendFileSync(file, JSON.stringify({
    timestamp: '2026-09-17T04:10:00.000Z', ordinal: 950, type: 'response_item',
    payload: { type: 'custom_tool_call', call_id: 'call_opaque', name: 'exec', input: 'SOME_OPAQUE_PAYLOAD_9f3a' },
  }) + '\n');
  importCodex(root, { home, env: { ...process.env, ...ENV } });
  const rec = codexRecords(root).find((r) => r.tool_use_id === 'call_opaque');
  assert.equal(rec.input.shape, 'unrecognised');
  assert.equal(rec.input.code_sha256, sha256('SOME_OPAQUE_PAYLOAD_9f3a'));
  assert.ok(!JSON.stringify(rec).includes('SOME_OPAQUE_PAYLOAD_9f3a'));
});

// ---- TS-124-06 --------------------------------------------------------------------------

test('TS-124-06 --dry-run reports what it would write and writes nothing', async () => {
  const root = tmpRoot();
  const home = fakeCodexHome(root, { 'inside-codemode.jsonl': 'rollout-2026-09-17T10-37-38-a.jsonl' });
  const before = verifyChain(root);

  const dry = await runCli(['import', 'codex', '--home', home, '--dry-run'], { cwd: root, env: ENV });
  assert.equal(dry.code, 0);
  assert.match(dry.stdout, /DRY RUN — nothing written/);
  const after = verifyChain(root);
  assert.equal(after.count, before.count, 'the chain did not move');
  assert.equal(after.last, before.last);

  const wet = await runCli(['import', 'codex', '--home', home], { cwd: root, env: ENV });
  assert.equal(wet.code, 0);
  const n = Number(wet.stdout.match(/imported (\d+) record/)[1]);
  assert.equal(Number(dry.stdout.match(/imported (\d+) record/)[1]), n, 'the dry run counted exactly what the real run wrote');
  assert.equal(verifyChain(root).count, before.count + n);
});

// ---- TS-124-07 --------------------------------------------------------------------------

test('TS-124-07 verify and anchor treat the imported chain as one more writer', async () => {
  const root = tmpRoot();
  appendRecord(root, buildRecord({ session_id: 's1', hook_event_name: 'SessionStart' }, { cwd: root, root, env: ENV }));
  const home = fakeCodexHome(root, { 'inside-codemode.jsonl': 'rollout-2026-09-17T10-37-38-a.jsonl' });
  importCodex(root, { home, env: { ...process.env, ...ENV } });

  const v = await runCli(['verify'], { cwd: root, env: ENV });
  assert.equal(v.code, 0);
  assert.match(v.stdout, /OK — \d+ records in 2 chains/);

  const a = await runCli(['anchor', '--by', 'test'], { cwd: root, env: ENV });
  assert.equal(a.code, 0);
  assert.match(a.stdout, /ANCHORED — \d+ records in 2 chain\(s\)/);
  assert.equal((await runCli(['verify'], { cwd: root, env: ENV })).code, 0, 'the anchor covers both chains');
});

// ---- TS-124-08 --------------------------------------------------------------------------

test('TS-124-08 report and accept both say how much of the evidence was imported', async () => {
  const root = tmpRoot();
  fs.writeFileSync(path.join(root, 'hello.txt'), 'HELLO_KIAI_FIXTURE\n');
  const home = fakeCodexHome(root, { 'inside-codemode.jsonl': 'rollout-2026-09-17T10-37-38-a.jsonl' });
  importCodex(root, { home, env: { ...process.env, ...ENV } });

  const rep = await runCli(['report'], { cwd: root, env: ENV });
  assert.equal(rep.code, 0);
  assert.match(rep.stdout, /- Agents: `codex-cli`/);
  assert.match(rep.stdout, /⚠ Imported records: \d+ of \d+/);

  const acc = await runCli(['accept', '--uow', 'UOW-124'], { cwd: root, env: ENV });
  assert.equal(acc.code, 0);
  assert.match(acc.stdout, /warnings: .*imported-records/);
  const packet = fs.readFileSync(path.join(root, '.kiai', 'acceptance', 'acceptance-UOW-124.draft.md'), 'utf8');
  assert.match(packet, /\*\*Agents:\*\* `codex-cli`/);
  assert.match(packet, /IMPORTED from an agent log after the fact/);
  // the point of the packet: a file Codex wrote is reconciled against the disk
  assert.match(packet, /`hello\.txt`/);
  assert.match(packet, /matches/);
});

// ---- TS-124-09 --------------------------------------------------------------------------

test('TS-124-09 hooks --agent codex prints the Codex block and warns that it is unconfirmed; plain hooks is unchanged', async () => {
  const root = tmpRoot();
  const claude = await runCli(['hooks'], { cwd: root });
  const codex = await runCli(['hooks', '--agent', 'codex'], { cwd: root });
  assert.equal(codex.code, 0);

  const block = JSON.parse(codex.stdout).hooks;
  for (const ev of ['SessionStart', 'UserPromptSubmit', 'PreToolUse', 'PermissionRequest', 'PostToolUse', 'PreCompact', 'PostCompact', 'SubagentStart', 'SubagentStop', 'Stop', 'Interrupt', 'SessionEnd']) {
    assert.ok(block[ev], `Codex event ${ev} is in the block`);
    assert.ok(block[ev][0].hooks[0].commandWindows, 'Codex takes a Windows-specific command');
  }
  assert.match(codex.stderr, /UNCONFIRMED/);
  assert.match(codex.stderr, /kiai import codex/, 'the warning points at the path that does work');

  assert.deepEqual(JSON.parse(claude.stdout), JSON.parse((await runCli(['hooks', '--agent', 'claude'], { cwd: root })).stdout));
  assert.equal(JSON.parse(claude.stdout).hooks.PermissionRequest, undefined, 'the Claude block is untouched');

  const bad = await runCli(['hooks', '--agent', 'nope'], { cwd: root });
  assert.equal(bad.code, 2);
});

// ---- TS-124-10 --------------------------------------------------------------------------

test('TS-124-10 secrets in a Codex log are redacted on the way into the chain', () => {
  const root = tmpRoot();
  const home = fakeCodexHome(root, { 'inside-codemode.jsonl': 'rollout-2026-09-17T10-37-38-a.jsonl' });
  const file = path.join(home, 'sessions', '2026', '09', '17', 'rollout-2026-09-17T10-37-38-a.jsonl');
  // Split so the repo-wide secret-scan gate does not see a credential shape in this source file.
  const key = 'sk-' + 'abcdefghijklmnopqrstuvwxyz0123456789';
  const token = 'ghp_' + 'abcdefghijklmnopqrstuvwxyz0123456789';
  fs.appendFileSync(file, [
    JSON.stringify({
      timestamp: '2026-09-17T04:20:00.000Z', ordinal: 960, type: 'response_item',
      payload: { type: 'custom_tool_call', call_id: 'call_secret', name: 'exec', input: `const r = await tools.exec_command({"cmd":"curl -H 'Authorization: Bearer ${key}' https://x"});` },
    }),
    JSON.stringify({
      timestamp: '2026-09-17T04:20:01.000Z', ordinal: 961, type: 'event_msg',
      payload: { type: 'item_completed', item: { type: 'CommandExecution', id: 'exec-secret', command: ['git', 'push', `https://x:${token}@github.com/a/b`], cwd: root, status: 'completed', stdout: 'ok' } },
    }),
  ].join('\n') + '\n');

  importCodex(root, { home, env: { ...process.env, ...ENV } });
  const text = fs.readFileSync(path.join(flightDir(root), codexWriter(root), fs.readdirSync(path.join(flightDir(root), codexWriter(root))).find((f) => f.endsWith('.jsonl'))), 'utf8');
  assert.ok(!text.includes(key), 'an API key in a code-mode command is redacted');
  assert.ok(!text.includes(token), 'a token in an argv is redacted');
  assert.ok(text.includes('[REDACTED]'));
});

// ---- unit level -------------------------------------------------------------------------

test('TS-124-11 the pieces behave on their own: home resolution, listing, meta, containment, unreadable lines', () => {
  const root = tmpRoot();
  assert.equal(codexHome({ home: 'X:/given' }).sessionsDir, path.join('X:/given', 'sessions'));
  assert.equal(codexHome({ env: { CODEX_HOME: 'Y:/env' } }).sessionsDir, path.join('Y:/env', 'sessions'));

  const home = fakeCodexHome(root, { 'inside-codemode.jsonl': 'rollout-2026-09-17T10-37-38-a.jsonl' });
  const files = listRollouts(path.join(home, 'sessions'));
  assert.equal(files.length, 1);

  const { lines, bad } = readRollout(files[0]);
  assert.equal(bad, 0);
  assert.equal(sessionMeta(lines).cli_version, '0.153.4');
  assert.equal(sessionMeta([{ type: 'event_msg' }]), null);

  fs.appendFileSync(files[0], 'not json at all\n');
  assert.equal(readRollout(files[0]).bad, 1, 'a half-written line is counted, not thrown');

  assert.equal(insideRoot(root, root), true);
  assert.equal(insideRoot(root, path.join(root, 'sub')), true);
  assert.equal(insideRoot(root, path.dirname(root)), false);
  assert.equal(insideRoot(root, null), false);
});

test('TS-124-08b a file Codex only EDITED is still listed in the packet, with no hash claimed for it', async () => {
  const root = tmpRoot();
  fs.writeFileSync(path.join(root, 'README.md'), 'old\n');
  const home = fakeCodexHome(root, { 'legacy-functioncall.jsonl': 'rollout-2026-09-17T10-40-00-legacy.jsonl' });
  importCodex(root, { home, env: { ...process.env, ...ENV } });
  await runCli(['accept', '--uow', 'UOW-124'], { cwd: root, env: ENV });
  const packet = fs.readFileSync(path.join(root, '.kiai', 'acceptance', 'acceptance-UOW-124.draft.md'), 'utf8');
  const row = packet.split('\n').find((l) => l.includes('`README.md`'));
  assert.ok(row, 'a file the agent updated must not vanish from the packet just because no full hash exists');
  assert.match(row, /\| edit \|/);
  assert.match(row, /\| — \|/, 'the hash cell is empty, not the string "null"');
  assert.match(row, /edit-only/);
  assert.ok(packet.split('\n').find((l) => l.includes('`gone.txt`') && l.includes('| delete |')), 'a deleted file is listed as deleted');
});

test('TS-124-08c one Codex command is one command in the packet, not two (x seal)', () => {
  // Codex logs a command twice: the model's REQUEST (code mode — JavaScript calling exec_command)
  // and the runtime's EFFECT (a CommandExecution item with the real argv). Their ids come from
  // different spaces (`call_…` vs `exec-…`), so no id match can pair them. Counting both showed one
  // `npm test` run as two rows — one of them with an unknown result beside the real one.
  const root = tmpRoot();
  const home = fakeCodexHome(root, { 'inside-codemode.jsonl': 'rollout-2026-09-17T10-37-38-a.jsonl' });
  const file = path.join(home, 'sessions', '2026', '09', '17', 'rollout-2026-09-17T10-37-38-a.jsonl');
  fs.appendFileSync(file, [
    JSON.stringify({
      timestamp: '2026-09-17T04:40:00.000Z', ordinal: 980, type: 'response_item',
      payload: { type: 'custom_tool_call', call_id: 'call_test_run', name: 'exec', input: 'const r = await tools.exec_command({"cmd":"npm test","workdir":"."});' },
    }),
    JSON.stringify({
      timestamp: '2026-09-17T04:40:05.000Z', ordinal: 981, type: 'event_msg',
      // The REAL shape: 996 of 996 CommandExecution records measured on the build machine wrap the
      // command in a pwsh.exe behind an absolute path. Not one is a bare ['npm','test'] — the first
      // version of this case used that shape and therefore proved nothing about reality.
      payload: { type: 'item_completed', item: { type: 'CommandExecution', id: 'exec-test-run', command: [PWSH, '-Command', 'npm test'], cwd: root, status: 'completed', stdout: '71 passing\n' } },
    }),
  ].join('\n') + '\n');

  importCodex(root, { home, env: { ...process.env, ...ENV } });
  const recs = codexRecords(root);
  assert.ok(recs.some((r) => r.event === 'tool_call' && r.input && r.input.commands), 'the request is still recorded as evidence');
  const effect = recs.find((r) => r.event === 'tool_result' && r.input && typeof r.input.command === 'string' && r.input.command.includes('npm test'));
  assert.ok(effect, 'so is the effect');
  assert.ok(effect.input.command.includes('pwsh.exe'), 'and the effect carries the wrapper Codex really used');

  const c = collectUow(recs, 'UOW-124');
  assert.equal(c.commands.filter((x) => x.includes('npm test')).length, 1, 'one run, one command in the packet');
  assert.equal(c.tests.length, 1, 'one run, one test row — the wrapper must not hide the test from isTestCommand');
  assert.equal(c.tests[0].ok, true, 'and it carries the outcome the runtime reported, not "unknown"');
});

test('TS-124-08d a wrapped command is still recognised as a test run (R2-P1)', () => {
  // Every real Codex command arrives as `<abs path>\pwsh.exe -Command <real command>`; without
  // unwrapping, an acceptance packet reports that NO test ran for a session that ran the suite.
  assert.equal(isTestCommand('npm test'), true);
  assert.equal(isTestCommand(`${PWSH} -Command npm test`), true);
  assert.equal(isTestCommand(`${PWSH} -NoProfile -Command npm test`), true);
  assert.equal(isTestCommand('/bin/bash -lc "npm test"'), true);
  assert.equal(isTestCommand('cmd.exe /c npm test'), true);
  assert.equal(isTestCommand(String.raw`C:\Program Files\Git\bin\bash.exe` + ' -lc ' + JSON.stringify('npm test')), true, 'Git for Windows ships bash.exe');
  assert.equal(isTestCommand('sh.exe -c ' + JSON.stringify('npm test')), true);
  assert.equal(isTestCommand('/opt/tools/mysh -c npm test'), false, 'a program that merely ends in sh is not a shell we know');
  assert.equal(isTestCommand('./scripts/ci.sh -c npm test'), false);
  assert.equal(unwrapCommand(`${PWSH} -Command git status --short`), 'git status --short');
  assert.equal(unwrapCommand('npm test'), 'npm test', 'a bare command is left alone');
  assert.equal(isTestCommand(`${PWSH} -Command git commit -m "fix jest"`), false, 'a look-alike still does not count');
});

test('TS-124-08e a command the runtime never reported separately is NOT dropped (R2-P2)', () => {
  // One code-mode blob can run several commands while the runtime reports an item for only one of
  // them. Dropping every request of a session that had any effect loses the others entirely.
  const root = tmpRoot();
  const home = fakeCodexHome(root, { 'inside-codemode.jsonl': 'rollout-2026-09-17T10-37-38-a.jsonl' });
  const file = path.join(home, 'sessions', '2026', '09', '17', 'rollout-2026-09-17T10-37-38-a.jsonl');
  fs.appendFileSync(file, [
    JSON.stringify({
      timestamp: '2026-09-17T04:50:00.000Z', ordinal: 990, type: 'response_item',
      payload: { type: 'custom_tool_call', call_id: 'call_two', name: 'exec', input: 'await tools.exec_command({"cmd":"npm test"}); await tools.exec_command({"cmd":"npm run lint"});' },
    }),
    JSON.stringify({
      timestamp: '2026-09-17T04:50:09.000Z', ordinal: 991, type: 'event_msg',
      payload: { type: 'item_completed', item: { type: 'CommandExecution', id: 'exec-only-one', command: [PWSH, '-Command', 'npm test'], cwd: root, status: 'completed', stdout: 'ok\n' } },
    }),
  ].join('\n') + '\n');

  importCodex(root, { home, env: { ...process.env, ...ENV } });
  const c = collectUow(codexRecords(root), 'UOW-124');
  assert.equal(c.commands.filter((x) => x.includes('npm test')).length, 1, 'the reported one is counted once');
  assert.ok(c.commands.some((x) => x.includes('npm run lint')), 'the unreported one is still evidence and must survive');
});

test('TS-124-08f a path that climbs out of the repo is not called "inside" (R2-P4)', () => {
  const root = tmpRoot();
  const outside = path.join(path.dirname(root), `escapee-${path.basename(root)}.txt`);
  fs.writeFileSync(outside, 'NOT PART OF THIS REPO\n');
  const rel = path.relative(root, outside).split(path.sep).join('/');
  const home = fakeCodexHome(root, { 'inside-codemode.jsonl': 'rollout-2026-09-17T10-37-38-a.jsonl' });
  const file = path.join(home, 'sessions', '2026', '09', '17', 'rollout-2026-09-17T10-37-38-a.jsonl');
  fs.appendFileSync(file, JSON.stringify({
    timestamp: '2026-09-17T04:55:00.000Z', ordinal: 995, type: 'event_msg',
    payload: { type: 'patch_apply_end', call_id: 'exec-escape', success: true, stdout: '', changes: { [rel]: { type: 'add', content: 'NOT PART OF THIS REPO\n' } } },
  }) + '\n');

  importCodex(root, { home, env: { ...process.env, ...ENV } });
  const rec = codexRecords(root).find((r) => r.tool_use_id === 'exec-escape');
  assert.equal(rec.input.files[0].outside_repo, true, 'a ../ path must be flagged, not silently adopted');
  const c = collectUow(codexRecords(root), 'UOW-124');
  const entry = c.files.find((f) => f.path.includes('escapee-'));
  assert.equal(entry.outside, true);
  assert.equal(reconcileDisk(root, [entry])[0].disk, 'outside', 'and never read off disk as if it were ours');
});

test('TS-124-08g a patch trimmed by the cap says so IN THE RENDERED PACKET, summed over records (R3-P1)', () => {
  // Twice now a fix was written correctly and never wired up: a field appeared in renderPacket that
  // collectUow never produced. A new field is only closed when a case asserts it in the OUTPUT.
  const root = tmpRoot();
  const home = fakeCodexHome(root, { 'inside-codemode.jsonl': 'rollout-2026-09-17T10-37-38-a.jsonl' });
  const file = path.join(home, 'sessions', '2026', '09', '17', 'rollout-2026-09-17T10-37-38-a.jsonl');
  const bigPatch = (id, n) => {
    const changes = {};
    for (let i = 0; i < n; i++) changes[`gen/f${i}.txt`] = { type: 'add', content: `x${i}` };
    return JSON.stringify({
      timestamp: '2026-09-17T05:00:00.000Z', type: 'event_msg',
      payload: { type: 'patch_apply_end', call_id: id, success: true, stdout: '', changes },
    });
  };
  // two patches over the cap of 100: 150 -> 50 hidden, 130 -> 30 hidden
  fs.appendFileSync(file, [bigPatch('exec-big-1', 150), bigPatch('exec-big-2', 130)].join('\n') + '\n');

  importCodex(root, { home, env: { ...process.env, ...ENV } });
  const recs = codexRecords(root);
  const marker = recs.find((r) => r.tool_use_id === 'exec-big-1').input.files.find((f) => f.change === 'truncated');
  assert.equal(marker.files_total, 150, 'the record keeps the true total');
  assert.equal(marker.files_kept, 100);

  const c = collectUow(recs, 'UOW-124');
  assert.equal(c.files_truncated, 80, 'summed over BOTH records, not taken from the last one');

  const pkg = buildPacket({ root, records: recs, verification: verifyChain(root), uow: 'UOW-124' });
  assert.equal(pkg.files_truncated, 80);
  const md = renderPacket(pkg, 'en');
  assert.match(md, /80 further changed path\(s\) are NOT listed/, 'the reader of the packet must see it');
  assert.match(renderPacket(pkg, 'vi'), /80 .*KH\u00d4NG \u0111\u01b0\u1ee3c li\u1ec7t/);
});

test('TS-124-12 --session imports one file even from another repo, and flags every record as out of tree', () => {
  const root = tmpRoot();
  const home = fakeCodexHome(root, { 'outside-repo.jsonl': 'rollout-2026-09-17T10-38-00-b.jsonl' });
  const file = path.join(home, 'sessions', '2026', '09', '17', 'rollout-2026-09-17T10-38-00-b.jsonl');
  const res = importCodex(root, { home, sessionFile: file, env: { ...process.env, ...ENV } });
  assert.ok(res.imported > 0);
  for (const r of codexRecords(root)) assert.equal(r.cwd_outside_root, true);
});
