// Tests for `kiai accept` (UOW-120): acceptance packet from the flight record. Offline, temp dirs only.
// Cases marked (R) come from the independent GATE 3 review of 2026-09-06.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { appendRecord, buildRecord, noteRecord, readAll, verifyChain, sha256, writerDir, relativizePath } from '../lib/flight.mjs';
import { collectUow, reconcileDisk, buildPacket, renderPacket, checkPacket, findSealing, isTestCommand } from '../lib/accept.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CLI = path.join(HERE, '..', 'bin', 'kiai.mjs');

function tmpRoot() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kiai-accept-'));
  fs.mkdirSync(path.join(dir, '.kiai'), { recursive: true });
  return dir;
}
/** Run the CLI as a human would: outside any agent session (CLAUDECODE unset). */
function runCli(args, { cwd, input = '', env = {} } = {}) {
  const clean = { ...process.env }; delete clean.CLAUDECODE; delete clean.CLAUDE_CODE_ENTRYPOINT; delete clean.KIAI_ALLOW_AGENT_DECISION; delete clean.KIAI_ACTOR;
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [CLI, ...args], { cwd, env: { ...clean, ...env }, stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = ''; let stderr = '';
    child.stdout.on('data', (d) => { stdout += d; });
    child.stderr.on('data', (d) => { stderr += d; });
    child.on('close', (code) => resolve({ code, stdout, stderr }));
    child.stdin.end(input);
  });
}
const ENV = { KIAI_UOW: 'UOW-777' };
const hook = (over = {}) => ({ session_id: 'sess-A', hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_use_id: 'tu-1', tool_input: { command: 'echo hi' }, ...over });
const rec = (root, over, opts = {}) => appendRecord(root, buildRecord(hook(over), { cwd: root, root, env: ENV, ...opts }));

/** A realistic UoW: write a file (absolute path, as Claude Code sends it), edit another, run tests (ok / failed / no result), stop, note. */
function seedUow(root) {
  const t = (i) => new Date(Date.UTC(2026, 8, 6, 1, 0, i));
  fs.writeFileSync(path.join(root, 'src.txt'), 'hello world\n');
  rec(root, { hook_event_name: 'SessionStart', source: 'startup' }, { now: t(0) });
  rec(root, { tool_name: 'Write', tool_use_id: 'tu-w', tool_input: { file_path: path.join(root, 'src.txt'), content: 'hello world\n' } }, { now: t(1) });
  rec(root, { hook_event_name: 'PostToolUse', tool_name: 'Write', tool_use_id: 'tu-w', tool_input: { file_path: path.join(root, 'src.txt'), content: 'hello world\n' }, tool_response: { success: true } }, { now: t(2) });
  rec(root, { tool_name: 'Edit', tool_use_id: 'tu-e', tool_input: { file_path: 'lib/other.js', old_string: 'a', new_string: 'b' } }, { now: t(3) });
  rec(root, { tool_use_id: 'tu-t1', tool_input: { command: 'npm test' } }, { now: t(4) });
  rec(root, { hook_event_name: 'PostToolUse', tool_use_id: 'tu-t1', tool_input: { command: 'npm test' }, tool_response: { stdout: 'ok', stderr: '', interrupted: false } }, { now: t(5) });
  rec(root, { tool_use_id: 'tu-t2', tool_input: { command: 'pytest -q' } }, { now: t(6) });
  rec(root, { hook_event_name: 'PostToolUse', tool_use_id: 'tu-t2', tool_input: { command: 'pytest -q' }, tool_response: { stdout: '', stderr: 'boom', interrupted: true } }, { now: t(7) });
  rec(root, { tool_use_id: 'tu-t3', tool_input: { command: 'cargo test' } }, { now: t(8) }); // no result → unknown
  rec(root, { hook_event_name: 'Stop' }, { now: t(9) });
  appendRecord(root, noteRecord('reviewed, one follow-up', { cwd: root, env: ENV, by: 'lead', now: t(10) }));
  // an unrelated UoW in ANOTHER session (must not leak in) and an untagged write in the SAME session (must be counted)
  rec(root, { session_id: 'sess-B', tool_use_id: 'tu-x', tool_input: { command: 'npm test' } }, { env: { KIAI_UOW: 'UOW-999' }, now: t(11) });
  rec(root, { tool_name: 'Write', tool_use_id: 'tu-u', tool_input: { file_path: 'untagged.txt', content: 'u' } }, { env: {}, now: t(12) });
}

test('isTestCommand recognises runners at the start of a command segment and ignores look-alikes (R N2)', () => {
  for (const c of ['npm test', 'npm run test', 'pnpm test -- --grep x', 'node --test test/', 'pytest -q', 'python -m pytest', 'go test ./...', 'cargo test', 'bundle exec rspec spec/', 'npx jest', 'npx vitest run', 'mvn -q test', './gradlew test', 'dotnet test', 'make test', 'cd api && npm test', 'CI=1 npm test', 'npm ci && npm test && echo done']) assert.ok(isTestCommand(c), c);
  for (const c of ['git status', 'npm install', 'echo test', 'ls tests/', 'cat testimony.txt', 'git commit -m "fix jest config"', 'cat pytest.ini', 'grep -r "npm test" docs/']) assert.equal(isTestCommand(c), false, c);
});

test('relativizePath: inside root → posix relative; outside → kept + flagged; relative untouched', () => {
  const root = tmpRoot();
  assert.deepEqual(relativizePath(root, path.join(root, 'a', 'b.txt')), { file: 'a/b.txt', outside: false });
  assert.deepEqual(relativizePath(root, 'c/d.txt'), { file: 'c/d.txt', outside: false });
  const out = relativizePath(root, path.join(os.tmpdir(), 'elsewhere.txt'));
  assert.equal(out.outside, true); assert.ok(path.isAbsolute(out.file));
});

test('collectUow: scopes by uow, pairs tests with results, keeps last write per file, notes, counts untagged records in the same sessions (R N7)', () => {
  const root = tmpRoot(); seedUow(root);
  const c = collectUow(readAll(root), 'UOW-777');
  assert.equal(c.records, 11);
  assert.equal(c.sessions.length, 1);
  assert.equal(c.sessions[0].calls, 5);
  assert.deepEqual(c.tests.map((x) => [x.command, x.ok]), [['npm test', true], ['pytest -q', false], ['cargo test', null]]);
  assert.equal(c.files.length, 2);
  assert.equal(c.files.find((f) => f.path === 'src.txt').kind, 'write', 'absolute path recorded relative to root');
  assert.equal(c.files.find((f) => f.path === 'lib/other.js').kind, 'edit');
  assert.equal(c.notes[0].text, 'reviewed, one follow-up');
  assert.deepEqual(c.untagged, { records: 1, writes: 1 });
  assert.equal(collectUow(readAll(root), 'UOW-999').records, 1);
});

test('reconcileDisk: matches / matches-eol / changed-after / missing / edit-only / outside; NotebookEdit is edit-only (R P5, N1)', () => {
  const root = tmpRoot(); seedUow(root);
  rec(root, { tool_name: 'NotebookEdit', tool_use_id: 'tu-nb', tool_input: { notebook_path: path.join(root, 'nb.ipynb'), new_source: 'print(1)' } });
  fs.writeFileSync(path.join(root, 'nb.ipynb'), '{"cells":[]}');
  rec(root, { tool_name: 'Write', tool_use_id: 'tu-out', tool_input: { file_path: path.join(os.tmpdir(), 'kiai-outside-' + process.pid + '.txt'), content: 'x' } });
  const get = (name) => reconcileDisk(root, collectUow(readAll(root), 'UOW-777').files).find((f) => f.path.endsWith(name));
  assert.equal(get('src.txt').disk, 'matches');
  assert.equal(get('lib/other.js').disk, 'edit-only');
  assert.equal(get('nb.ipynb').disk, 'edit-only');
  assert.equal(get('kiai-outside-' + process.pid + '.txt').disk, 'outside');
  fs.writeFileSync(path.join(root, 'src.txt'), 'hello world\r\n');
  assert.equal(get('src.txt').disk, 'matches-eol');
  fs.appendFileSync(path.join(root, 'src.txt'), 'tampered\n');
  assert.equal(get('src.txt').disk, 'changed-after');
  fs.rmSync(path.join(root, 'src.txt'));
  assert.equal(get('src.txt').disk, 'missing');
});

test('reconcileDisk: a moved repo and a clone still match (R P1) — relative records, and legacy absolute records re-based from cwd', () => {
  const root = tmpRoot(); seedUow(root);
  // legacy absolute record (v0.1 style) pointing into the ORIGINAL location
  appendRecord(root, { ts: new Date().toISOString(), event: 'tool_call', agent: 'claude-code', session: 'sess-A', cwd: root, uow: 'UOW-777', tool: 'Write', tool_use_id: 'tu-legacy', input: { file: path.join(root, 'legacy.txt'), content_sha256: sha256('L'), content_bytes: 1 } });
  fs.writeFileSync(path.join(root, 'legacy.txt'), 'L');
  const moved = root + '-moved';
  fs.renameSync(root, moved);
  const files = reconcileDisk(moved, collectUow(readAll(moved), 'UOW-777').files);
  assert.equal(files.find((f) => f.path === 'src.txt').disk, 'matches', 'relative record follows the repo');
  assert.equal(files.find((f) => f.path.endsWith('legacy.txt')).disk, 'matches', 'absolute record re-based from its cwd');
});

test('renderPacket: EN / VI / both labels, footer hash verifies, injection neutralised, warnings rendered', () => {
  const root = tmpRoot(); seedUow(root);
  rec(root, { tool_name: 'Write', tool_use_id: 'tu-inj', tool_input: { file_path: 'evil`|x.ts\n## FAKE', content: 'z' } });
  appendRecord(root, noteRecord('line\n# FAKE HEADING\n| a | b |', { cwd: root, env: ENV, by: 'x|y**bold**' }));
  const v = verifyChain(root);
  const pkg = buildPacket({ root, records: readAll(root), verification: v, uow: 'UOW-777', ac: '- [ ] AC1 works\n# not a heading\n| not | a table |\n\n', now: new Date('2026-09-06T02:00:00Z') });
  const en = renderPacket(pkg, 'en'); const vi = renderPacket(pkg, 'vi'); const both = renderPacket(pkg, 'both');
  assert.match(en, /^# Acceptance packet — UOW-777/); assert.match(vi, /^# Hồ sơ nghiệm thu — UOW-777/); assert.match(both, /^# Hồ sơ nghiệm thu \/ Acceptance packet — UOW-777/);
  assert.match(en, /DRAFT — no decision recorded/);
  assert.match(en, /✅ matches/); assert.match(en, /edit-only/); assert.match(en, /✅ completed/); assert.match(en, /❌ interrupted/); assert.match(en, /· unknown/);
  assert.match(en, /1 records in the same sessions carry another or no UoW tag/);
  assert.equal(/\*\*bold\*\*/.test(en), false, 'asterisks in agent strings cannot open bold');
  for (const md of [en, vi, both]) {
    assert.equal(checkPacket(md).ok, true);
    const lines = md.split('\n');
    assert.equal(lines.some((l) => /^#+ (FAKE|not a heading)/.test(l)), false, 'no injected heading');
    assert.equal(lines.filter((l) => /^#/.test(l)).length, 10, 'exactly title + 9 sections');
    for (const row of lines.filter((l) => l.startsWith('|') && !l.startsWith('|---'))) {
      assert.ok([4, 6, 8].includes(row.split(/(?<!\\)\|/).length), `table row has a consistent cell count: ${row}`);
    }
    assert.match(md, /> - \[ \] AC1 works/);
    assert.match(md, /> \\# not a heading/);
    assert.match(md, /> \\\| not \| a table \|/);
    assert.equal(/^> $/m.test(md), false, 'no trailing-whitespace quote lines');
  }
  assert.equal(checkPacket(en.replace('hello', 'hellO').replace('UOW-777', 'UOW-778')).ok, false);
  assert.equal(checkPacket('no footer here').ok, false);
});

test('cli accept: draft writes .draft.md/.json without touching the chain; decision seals a record with packet, body and json hashes; --check finds the sealing record (R N4, N5)', async () => {
  const root = tmpRoot(); seedUow(root);
  const before = verifyChain(root).count;
  let r = await runCli(['accept', '--uow', 'UOW-777', '--out', 'out'], { cwd: root });
  assert.equal(r.code, 0, r.stderr);
  assert.match(r.stdout, /DRAFT packet for UOW-777/);
  const draftMd = path.join(root, 'out', 'acceptance-UOW-777.draft.md');
  assert.ok(fs.existsSync(draftMd) && fs.existsSync(path.join(root, 'out', 'acceptance-UOW-777.draft.json')));
  assert.equal(verifyChain(root).count, before, 'draft adds no record');
  const j = JSON.parse(fs.readFileSync(path.join(root, 'out', 'acceptance-UOW-777.draft.json'), 'utf8'));
  assert.equal(j.draft, true); assert.equal(j.md_sha256, sha256(fs.readFileSync(draftMd, 'utf8')));
  assert.equal(j.files.find((f) => f.path === 'src.txt').disk, 'matches');
  assert.equal(j.repository_name, path.basename(root));

  r = await runCli(['accept', '--uow', 'UOW-777', '--decision', 'approve', '--by', 'tech lead', '--note', 'ship it token=abcd1234efgh', '--out', 'out'], { cwd: root });
  assert.equal(r.code, 0, r.stderr);
  assert.match(r.stdout, /APPROVE packet/); assert.match(r.stdout, /sealed into flight record: seq/);
  const mdPath = path.join(root, 'out', 'acceptance-UOW-777.md');
  const md = fs.readFileSync(mdPath, 'utf8');
  const v = verifyChain(root);
  assert.equal(v.ok, true); assert.equal(v.count, before + 1);
  const dec = readAll(root).find((x) => x.event === 'decision');
  assert.equal(dec.decision, 'approve'); assert.equal(dec.by, 'tech lead'); assert.equal(dec.uow, 'UOW-777'); assert.equal(dec.via, 'human'); assert.equal(dec.agent, 'kiai-cli');
  assert.equal(dec.packet_sha256, sha256(md), 'record carries the hash of the written packet');
  assert.equal(dec.packet_body_sha256, checkPacket(md).expected);
  assert.equal(dec.json_sha256, sha256(fs.readFileSync(path.join(root, 'out', 'acceptance-UOW-777.json'), 'utf8')));
  assert.equal(dec.packet_path, 'out/acceptance-UOW-777.md');
  assert.ok(dec.heads[0].count === before, 'packet heads are those BEFORE the decision record');
  assert.match(md, /\*\*APPROVED\*\* — Decided by: \*\*tech lead\*\*/);
  assert.match(md, /ship it token=\[REDACTED\]/, 'note is redacted in the packet too (R N3)');
  assert.equal(md.includes('abcd1234efgh'), false);
  assert.equal(md.includes(root), false, 'no absolute dev path in the packet (R N8)');
  assert.equal(findSealing(readAll(root), md).length, 1);
  assert.equal(findSealing(readAll(root), md.replace(/\n/g, '\r\n')).length, 1, 'body hash survives CRLF re-encoding');

  r = await runCli(['accept', '--check', mdPath], { cwd: root });
  assert.equal(r.code, 0); assert.match(r.stdout, /OK \(footer only\) — packet hash/); assert.match(r.stdout, /SEALED — decision record seq \d+ .*APPROVE by tech lead/);
  r = await runCli(['accept', '--check', path.join(root, 'out', 'acceptance-UOW-777.json')], { cwd: root });
  assert.equal(r.code, 0); assert.match(r.stdout, /OK — \.json points at acceptance-UOW-777\.md/); assert.match(r.stdout, /SEALED/);
  r = await runCli(['accept', '--check', draftMd], { cwd: root });
  assert.equal(r.code, 0); assert.match(r.stdout, /NOT SEALED/);
  fs.writeFileSync(mdPath + '.copy.md', md.replace('tech lead', 'tech leaf'));
  r = await runCli(['accept', '--check', mdPath + '.copy.md'], { cwd: root });
  assert.equal(r.code, 1); assert.match(r.stdout, /MISMATCH/); assert.match(r.stdout, /NOT SEALED/);
  // a later draft in the same --out does not touch the sealed packet and names the earlier decision (R P3)
  r = await runCli(['accept', '--uow', 'UOW-777', '--lang', 'both', '--out', 'out'], { cwd: root });
  assert.equal(r.code, 0);
  assert.equal(fs.readFileSync(mdPath, 'utf8'), md, 'sealed packet untouched');
  const draft2 = fs.readFileSync(draftMd, 'utf8');
  assert.match(draft2, /BẢN NHÁP — đã có quyết định trước, mới nhất \/ DRAFT — earlier decision\(s\) exist, latest: CHẤP NHẬN \/ APPROVED/);
  assert.match(draft2, /→ \*\*approve\*\*: ship it/);
  // a second decision keeps the first sealed packet under a .prev-<sha8> name
  r = await runCli(['accept', '--uow', 'UOW-777', '--decision', 'conditional', '--by', 'tech lead', '--out', 'out'], { cwd: root });
  assert.equal(r.code, 0, r.stderr);
  const prev = fs.readdirSync(path.join(root, 'out')).filter((f) => /^acceptance-UOW-777\.prev-[0-9a-f]{8}\.md$/.test(f));
  assert.equal(prev.length, 1); assert.equal(fs.readFileSync(path.join(root, 'out', prev[0]), 'utf8'), md);
  r = await runCli(['report', '--uow', 'UOW-777'], { cwd: root });
  assert.match(r.stdout, /DECISION APPROVE on UOW-777/);
  r = await runCli(['accept', '--uow', 'UOW-777', '--lang', 'vi', '--out', 'out3'], { cwd: root });
  assert.match(fs.readFileSync(path.join(root, 'out3', 'acceptance-UOW-777.draft.md'), 'utf8'), /^# Hồ sơ nghiệm thu — UOW-777/);
});

test('cli accept: lock busy at --decision leaves NO packet on disk and exits 1 cleanly (R P2)', async () => {
  const root = tmpRoot(); seedUow(root);
  const lock = path.join(writerDir(root), '.lock'); fs.mkdirSync(lock);
  const r = await runCli(['accept', '--uow', 'UOW-777', '--decision', 'approve', '--by', 'lead', '--out', 'out'], { cwd: root, env: { KIAI_LOCK_BUDGET_MS: '200' } });
  fs.rmdirSync(lock);
  assert.equal(r.code, 1);
  assert.match(r.stderr, /could not seal the decision .*lock busy/);
  assert.equal(r.stderr.includes('    at '), false, 'no stack trace');
  assert.equal(fs.existsSync(path.join(root, 'out')) && fs.readdirSync(path.join(root, 'out')).length > 0, false, 'no packet files left behind');
  assert.equal(readAll(root).some((x) => x.event === 'decision'), false);
});

test('cli accept: a decision from inside an agent session is refused; with KIAI_ALLOW_AGENT_DECISION=1 it is recorded and flagged as such (R P4)', async () => {
  const root = tmpRoot(); seedUow(root);
  let r = await runCli(['accept', '--uow', 'UOW-777', '--decision', 'approve', '--by', 'human', '--out', 'out'], { cwd: root, env: { CLAUDECODE: '1' } });
  assert.equal(r.code, 1); assert.match(r.stderr, /decisions are taken by a human outside the agent session/);
  assert.equal(readAll(root).some((x) => x.event === 'decision'), false);
  r = await runCli(['accept', '--uow', 'UOW-777', '--out', 'out'], { cwd: root, env: { CLAUDECODE: '1' } });
  assert.equal(r.code, 0, 'drafts are fine from inside an agent session');
  r = await runCli(['accept', '--uow', 'UOW-777', '--decision', 'approve', '--by', 'bot', '--out', 'out'], { cwd: root, env: { CLAUDECODE: '1', KIAI_ALLOW_AGENT_DECISION: '1' } });
  assert.equal(r.code, 0, r.stderr); assert.match(r.stdout, /recorded from inside an agent session/);
  const dec = readAll(root).find((x) => x.event === 'decision');
  assert.equal(dec.via, 'agent-session');
  const md = fs.readFileSync(path.join(root, 'out', 'acceptance-UOW-777.md'), 'utf8');
  assert.match(md, /Recorded via: ⚠ AGENT SESSION/); assert.match(md, /This decision was recorded from inside an agent session/);
  // default --by is the OS user, never the literal 'human'
  r = await runCli(['accept', '--uow', 'UOW-777', '--decision', 'reject', '--out', 'out'], { cwd: root });
  assert.equal(r.code, 0, r.stderr);
  const dec2 = readAll(root).filter((x) => x.event === 'decision').pop();
  assert.notEqual(dec2.by, 'human'); assert.ok(dec2.by.length > 0);
});

test('cli accept: refuses on a broken chain, refuses a decision with no records, uses .kiai/ac/<uow>.md, flags an AC file written by the agent (R N6), validates flags', async () => {
  const root = tmpRoot(); seedUow(root);
  fs.mkdirSync(path.join(root, '.kiai', 'ac'));
  fs.writeFileSync(path.join(root, '.kiai', 'ac', 'UOW-777.md'), '- [ ] AC from file password=hunter2222\n');
  let r = await runCli(['accept', '--uow', 'UOW-777'], { cwd: root });
  assert.equal(r.code, 0);
  let md = fs.readFileSync(path.join(root, '.kiai', 'acceptance', 'acceptance-UOW-777.draft.md'), 'utf8');
  assert.match(md, /AC from file password=\[REDACTED\]/);
  assert.equal(md.includes('WRITTEN BY THE AGENT'), false);
  rec(root, { tool_name: 'Write', tool_use_id: 'tu-ac', tool_input: { file_path: path.join(root, '.kiai', 'ac', 'UOW-777.md'), content: '- [ ] AC from file password=hunter2222\n' } });
  r = await runCli(['accept', '--uow', 'UOW-777'], { cwd: root });
  md = fs.readFileSync(path.join(root, '.kiai', 'acceptance', 'acceptance-UOW-777.draft.md'), 'utf8');
  assert.match(md, /WRITTEN BY THE AGENT/); assert.match(r.stdout, /ac-written-by-agent/);
  r = await runCli(['accept', '--uow', 'UOW-000', '--decision', 'approve'], { cwd: root });
  assert.equal(r.code, 1); assert.match(r.stderr, /no flight records/);
  r = await runCli(['accept', '--uow', 'UOW-777', '--decision', 'maybe'], { cwd: root });
  assert.equal(r.code, 2);
  r = await runCli(['accept', '--uow', 'UOW-777', '--ac', 'nope.md'], { cwd: root });
  assert.equal(r.code, 2); assert.match(r.stderr, /--ac file not found/);
  r = await runCli(['accept', '--uow', 'UOW-777', '--ac', '.'], { cwd: root });
  assert.equal(r.code, 2); assert.match(r.stderr, /not a file/);
  r = await runCli(['accept', '--uow', 'bad uow|x'], { cwd: root });
  assert.equal(r.code, 2);
  const file = path.join(writerDir(root), '2026-09-06.jsonl');
  const tampered = fs.readFileSync(file, 'utf8').replace('"npm test"', '"npm tesT"');
  assert.notEqual(tampered, fs.readFileSync(file, 'utf8'));
  fs.writeFileSync(file, tampered);
  assert.equal(verifyChain(root).ok, false, 'fixture really broke the chain');
  const count = readAll(root).length;
  r = await runCli(['accept', '--uow', 'UOW-777', '--decision', 'approve'], { cwd: root });
  assert.equal(r.code, 1); assert.match(r.stderr, /refusing — flight record BROKEN/);
  assert.equal(readAll(root).length, count, 'no decision record was appended to a broken chain');
});

test('cli accept 0.2.1: default outDir is <root>/.kiai/acceptance only when the repository already has a black box; elsewhere the packet lands in cwd and NO .kiai/ is created (R122 N6)', async () => {
  const root = tmpRoot(); seedUow(root);
  let r = await runCli(['accept', '--uow', 'UOW-777'], { cwd: root });
  assert.equal(r.code, 0, r.stderr);
  assert.ok(fs.existsSync(path.join(root, '.kiai', 'acceptance', 'acceptance-UOW-777.draft.md')), 'draft lands in .kiai/acceptance');
  const bare = fs.mkdtempSync(path.join(os.tmpdir(), 'kiai-nobox-'));
  fs.mkdirSync(path.join(bare, '.git'));
  r = await runCli(['accept', '--uow', 'UOW-1'], { cwd: bare });
  assert.equal(r.code, 0, r.stderr);
  assert.match(r.stderr, /no \.kiai\/ at .* writing the packet into the current directory/);
  assert.ok(fs.existsSync(path.join(bare, 'acceptance-UOW-1.draft.md')), 'packet next to you');
  assert.equal(fs.existsSync(path.join(bare, '.kiai')), false, 'accept never creates a black box');
});
