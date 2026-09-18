// Tests for UOW-130: handing KIAI to a developer who is not on Claude Code.
//
// `kiai wrap` is the one integration every agent can meet (a shell command); the starter rules ship
// with the plugin so a fresh install gets the key and not only the lock; the Cursor translator must
// fail SAFE. Offline, temp dirs only.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { readAll, verifyChain } from '../lib/flight.mjs';
import { loadRules, RULES_DIR } from '../lib/rules.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PLUGIN = path.join(HERE, '..');
const CLI = path.join(PLUGIN, 'bin', 'kiai.mjs');
const CURSOR = path.join(PLUGIN, 'adapters', 'cursor', 'kiai-cursor-hook.mjs');
const HAVE_GIT = spawnSync('git', ['--version'], { stdio: 'ignore' }).status === 0;
const needGit = { skip: HAVE_GIT ? false : 'git not available on this machine' };

function run(file, args, { cwd, input = '', env = {}, timeout = 30000 } = {}) {
  const clean = { ...process.env, ...env };
  delete clean.CLAUDECODE; delete clean.CLAUDE_CODE_ENTRYPOINT;
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [file, ...args], { cwd, env: clean, stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = ''; let stderr = '';
    const timer = setTimeout(() => { child.kill('SIGKILL'); reject(new Error('hung: ' + args.join(' '))); }, timeout);
    child.stdout.on('data', (d) => { stdout += d; });
    child.stderr.on('data', (d) => { stderr += d; });
    child.on('close', (code) => { clearTimeout(timer); resolve({ code, stdout, stderr }); });
    child.stdin.end(input);
  });
}
const cli = (args, o) => run(CLI, args, o);

/** A fresh repository with the black box and the starter rules — what a developer gets from `kiai init`. */
async function freshRepo() {
  const root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'kiai-handoff-')));
  spawnSync('git', ['init', '-q', '.'], { cwd: root, stdio: 'ignore' });
  spawnSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-q', '--allow-empty', '-m', 'init'], { cwd: root, stdio: 'ignore' });
  const r = await cli(['init'], { cwd: root });
  assert.equal(r.code, 0, r.stderr);
  return root;
}

// The chain stores KIAI's own vocabulary, not the hook names: PreToolUse -> tool_call, PostToolUse and
// PostToolUseFailure -> tool_result (the failure carries result.ok === false).
const events = (root, session) => readAll(root).filter((r) => r.session === session).map((r) => r.event + (r.event === 'tool_result' && r.result && r.result.ok === false ? '!' : ''));

// ---- the starter rules travel with the plugin --------------------------------------------------

test('TS-130-01 kiai init seeds the starter rules, so a fresh install gets the key and not only the lock', needGit, async () => {
  // Measured 2026-09-18 on a marketplace install: the `rules` command was there and no rule was.
  const root = await freshRepo();
  const shipped = fs.readdirSync(path.join(PLUGIN, 'rules')).filter((f) => f.endsWith('.json')).sort();
  assert.ok(shipped.length >= 5, 'the plugin ships a real starter set');
  assert.deepEqual(fs.readdirSync(path.join(root, RULES_DIR)).filter((f) => f.endsWith('.json')).sort(), shipped);
  const { rules, problems } = loadRules(root);
  assert.deepEqual(problems, []);
  assert.ok(rules.length >= 20);
  const lint = await cli(['rules', 'lint'], { cwd: root });
  assert.equal(lint.code, 0, lint.stdout);
});

test('TS-130-02 rules install keeps what is there unless --force — a repository\'s rules are reviewed like code', needGit, async () => {
  const root = await freshRepo();
  const mine = path.join(root, RULES_DIR, 'safety.json');
  fs.writeFileSync(mine, '[]\n'); // the developer edited their copy
  const keep = await cli(['rules', 'install'], { cwd: root });
  assert.equal(keep.code, 0);
  assert.match(keep.stdout, /kept\s+\.kiai\/rules\/safety\.json/);
  assert.equal(fs.readFileSync(mine, 'utf8'), '[]\n', 'not overwritten');
  const force = await cli(['rules', 'install', '--force'], { cwd: root });
  assert.match(force.stdout, /installed \.kiai\/rules\/safety\.json/);
  assert.notEqual(fs.readFileSync(mine, 'utf8'), '[]\n', 'overwritten only when asked');
});

test('TS-130-03 the copy in this repository must equal the set the plugin ships (drift guard)', () => {
  // Two files that claim the same thing and are compared by nobody drift — plugin.json sat four
  // releases behind package.json before anyone looked (2026-09-18). Same shape, same guard.
  const repoRules = path.join(PLUGIN, '..', RULES_DIR);
  if (!fs.existsSync(repoRules)) return; // a standalone plugin checkout has no copy to drift
  const shipped = path.join(PLUGIN, 'rules');
  const a = fs.readdirSync(repoRules).filter((f) => f.endsWith('.json')).sort();
  const b = fs.readdirSync(shipped).filter((f) => f.endsWith('.json')).sort();
  assert.deepEqual(a, b, 'same files');
  for (const f of a) {
    assert.equal(fs.readFileSync(path.join(repoRules, f), 'utf8'), fs.readFileSync(path.join(shipped, f), 'utf8'),
      `${f}: .kiai/rules/ and kiai-plugin/rules/ differ — edit kiai-plugin/rules/ and copy, they must not drift`);
  }
});

// ---- the payload contract ------------------------------------------------------------------------

test('TS-130-04 hooks --agent generic prints the contract, and a payload that meets it becomes one record', needGit, async () => {
  const root = await freshRepo();
  const c = await cli(['hooks', '--agent', 'generic'], { cwd: root });
  assert.equal(c.code, 0);
  const contract = JSON.parse(c.stdout.split('\n#')[0]);
  assert.deepEqual(Object.keys(contract.required), ['session_id', 'hook_event_name', 'cwd', 'tool_name', 'tool_input', 'tool_use_id']);
  const payload = { ...contract.example, cwd: root, session_id: 'gen-1' };
  const r = await cli(['record', 'PreToolUse'], { cwd: root, input: JSON.stringify(payload) });
  assert.equal(r.code, 0);
  assert.deepEqual(events(root, 'gen-1'), ['tool_call']);
});

// ---- kiai wrap -----------------------------------------------------------------------------------

test('TS-130-05 wrap records a Pre/Post pair around a command and passes its exit code through', needGit, async () => {
  const root = await freshRepo();
  const ok = await cli(['wrap', '--tool', 'Bash', '--session', 'w1', '--', process.execPath, '-e', 'console.log("hi")'], { cwd: root });
  assert.equal(ok.code, 0, ok.stderr);
  assert.match(ok.stdout, /hi/, "the command's output still reaches the caller");
  assert.deepEqual(events(root, 'w1'), ['tool_call', 'tool_result']);

  const bad = await cli(['wrap', '--tool', 'Bash', '--session', 'w1', '--', process.execPath, '-e', 'process.exit(3)'], { cwd: root });
  assert.equal(bad.code, 3, 'the exit code is the command\'s, not wrap\'s');
  assert.deepEqual(events(root, 'w1'), ['tool_call', 'tool_result', 'tool_call', 'tool_result!']);
  assert.equal(verifyChain(root).ok, true);

  const recs = readAll(root).filter((r) => r.session === 'w1' && r.event === 'tool_result');
  const res = recs[0].result || {};
  assert.equal(typeof res.bytes, 'number', 'the record keeps the size of what came back');
  assert.ok(!('stdout' in res) && !JSON.stringify(res).includes('hi'), 'never the output itself');
});

test('TS-130-06 wrap refuses a command a block rule matches: not run, exit 2, and the chain says why', needGit, async () => {
  // The rule is the real one, and the command is the real one that destroyed work on 2026-09-17.
  const root = await freshRepo();
  fs.writeFileSync(path.join(root, 'canary.txt'), 'still here\n');
  const r = await cli(['wrap', '--tool', 'Bash', '--session', 'w2', '--', 'git', 'clean', '-fdx'], { cwd: root });
  assert.equal(r.code, 2, 'exit 2 = refused by a rule, distinct from the command failing');
  assert.match(r.stderr, /BLOCKED BY safety\/no-hard-reset-over-uncommitted-work/);
  assert.match(r.stderr, /ollama\.rb/, 'the reason travels with the refusal');
  assert.ok(fs.existsSync(path.join(root, 'canary.txt')), 'the command did NOT run');
  assert.deepEqual(events(root, 'w2'), ['tool_call', 'tool_result!'], 'the refusal is on the record as a failed result');

  const near = await cli(['wrap', '--tool', 'Bash', '--session', 'w2', '--', 'git', 'status', '--short'], { cwd: root });
  assert.equal(near.code, 0, 'the near miss still runs');
});

test('TS-130-07 wrap without a command, or with a bad --input, says so and runs nothing', needGit, async () => {
  const root = await freshRepo();
  assert.equal((await cli(['wrap', '--tool', 'Bash'], { cwd: root })).code, 2);
  const bad = await cli(['wrap', '--tool', 'Edit', '--input', 'nope', '--', process.execPath, '-e', '0'], { cwd: root });
  assert.equal(bad.code, 2);
  assert.match(bad.stderr, /--input: not valid JSON/);
  assert.deepEqual(readAll(root).filter((r) => r.event !== 'SessionStart'), [], 'nothing recorded for a call that never happened');
});

// ---- the Cursor translator — written blind, so it must fail SAFE ----------------------------------

test('TS-130-11 a rephrased `reset --hard` walks through the rules — and the snapshot brings the file back (R1-N2)', needGit, async () => {
  // Review round 1 of UOW-130. The rules match the command STRING, so a command that spells
  // `git reset --hard` out of variables and `eval`, or hides it behind `git -c alias.X=…`, is not
  // matched. Both destroyed uncommitted work in a test repo. This test keeps that fact measured
  // (the bypass is REAL and documented as N2) and pins the one defence that does not depend on
  // how the command is phrased: the tree as it was, written before the command ran.
  const root = await freshRepo();
  const tracked = path.join(root, 'tracked.txt');
  fs.writeFileSync(tracked, 'committed\n');
  spawnSync('git', ['add', 'tracked.txt'], { cwd: root, stdio: 'ignore' });
  spawnSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-q', '-m', 't'], { cwd: root, stdio: 'ignore' });
  fs.writeFileSync(tracked, 'UNCOMMITTED WORK\n');
  fs.writeFileSync(path.join(root, 'never-added.txt'), 'the ollama.rb case\n');

  for (const [label, argv] of [
    ['variables + eval', ['bash', '-lc', 'A="git res"; B="et --har"; C="d"; eval "${A}${B}${C}"']],
    ['git alias', ['git', '-c', 'alias.nuke=reset --hard', 'nuke']],
  ]) {
    fs.writeFileSync(tracked, 'UNCOMMITTED WORK\n');
    const r = await cli(['wrap', '--tool', 'Bash', '--session', 'bypass', '--', ...argv], { cwd: root });
    assert.equal(r.code, 0, `${label}: NOT blocked — this is the measured bypass, kept on purpose so nobody claims otherwise`);
    // git on Windows may rewrite the file with CRLF; the point is the CONTENT went back to `committed`
    assert.equal(fs.readFileSync(tracked, 'utf8').replace(/\r\n/g, '\n'), 'committed\n', `${label}: the work really was destroyed`);
    assert.match(r.stderr, /working tree changed by Bash .* tree before: [0-9a-f]{40}; recover a file with: git restore --source=/, `${label}: the snapshot is reported`);
    const tree = /tree before: ([0-9a-f]{40})/.exec(r.stderr)[1];
    // the file comes back from the snapshot, without any help from the command that destroyed it
    const back = spawnSync('git', ['restore', `--source=${tree}`, '--', 'tracked.txt'], { cwd: root, encoding: 'utf8' });
    assert.equal(back.status, 0, back.stderr);
    assert.equal(fs.readFileSync(tracked, 'utf8').replace(/\r\n/g, '\n'), 'UNCOMMITTED WORK\n', `${label}: recovered`);
    const shown = spawnSync('git', ['show', `${tree}:never-added.txt`], { cwd: root, encoding: 'utf8' });
    assert.equal(shown.stdout.replace(/\r\n/g, '\n'), 'the ollama.rb case\n', `${label}: a file that was never added is in the snapshot too`);
  }
  // and the chain says the tree changed, with the tree id, as a note
  const notes = readAll(root).filter((r) => r.event === 'note' && /working tree changed/.test(r.text || ''));
  assert.equal(notes.length, 2);
  assert.match(notes[0].text, /tree before: [0-9a-f]{40}/);
});

test('TS-130-12 a command that changes nothing leaves no snapshot note; --no-snapshot leaves none either', needGit, async () => {
  const root = await freshRepo();
  await cli(['wrap', '--tool', 'Bash', '--session', 'quiet', '--', 'git', 'status', '--short'], { cwd: root });
  assert.equal(readAll(root).filter((r) => r.event === 'note').length, 0, 'the chain must not fill with noise');
  fs.writeFileSync(path.join(root, 'x.txt'), 'x\n');
  const off = await cli(['wrap', '--tool', 'Bash', '--session', 'quiet', '--no-snapshot', '--', process.execPath, '-e', "require('fs').writeFileSync('x.txt','y')"], { cwd: root });
  assert.equal(off.code, 0);
  assert.doesNotMatch(off.stderr, /working tree changed/);
  assert.equal(readAll(root).filter((r) => r.event === 'note').length, 0);
});

test('TS-130-14 a command that removes .git does not get a silent all-clear (R2)', needGit, async () => {
  // Review round 2: `rm -rf .git` made the after-snapshot null and wrap said nothing — the same
  // silence as a directory that was never a repository. Silence there is an invented all-clear.
  const root = await freshRepo();
  fs.writeFileSync(path.join(root, 'work.txt'), 'uncommitted\n');
  const r = await cli(['wrap', '--tool', 'Bash', '--session', 'nogit', '--', process.execPath, '-e', "require('fs').rmSync('.git',{recursive:true,force:true})"], { cwd: root });
  assert.equal(r.code, 0, 'the command itself succeeded, and wrap passes that through');
  assert.match(r.stderr, /cannot tell whether the working tree changed — git no longer recognises a repository here/);
  assert.match(r.stderr, /the snapshot taken before was [0-9a-f]{40}/, 'the id that was already taken is still reported');
});

test('TS-130-15 a slow snapshot names the cause instead of letting the developer find --no-snapshot first (R2)', needGit, async () => {
  // Measured 2026-09-18: 10–15 s per wrap on 8 000 un-ignored files, 556 ms once the directory is
  // ignored. This test does not build 8 000 files in CI; it checks the hint exists on the slow path by
  // making the snapshot slow through a tree that is small but deliberately un-ignored and deep.
  const root = await freshRepo();
  // 3 000 small files: ~1.5 ms/file on the slowest machine measured (8 000 → 10–15 s) and ~0.8 ms/file on
  // the fastest (round-3 reviewer: 1 500 → 2.4–3.4 s per wrap), so both snapshots together cross 2 s
  // on every machine this suite has seen. The threshold is on the TOTAL of both snapshots.
  for (let d = 0; d < 60; d++) {
    fs.mkdirSync(path.join(root, 'stray', 'd' + d), { recursive: true });
    for (let f = 0; f < 50; f++) fs.writeFileSync(path.join(root, 'stray', 'd' + d, 'f' + f + '.js'), 'module.exports = ' + f + ';\n');
  }
  const r = await cli(['wrap', '--tool', 'Bash', '--session', 'slow', '--', process.execPath, '-e', '0'], { cwd: root, timeout: 120000 });
  assert.equal(r.code, 0);
  if (/snapshots took/.test(r.stderr)) {
    assert.match(r.stderr, /missing from \.gitignore/, 'the hint names the cause');
    assert.match(r.stderr, /--no-snapshot turns the snapshot off, and with it the only recovery/, 'and the cost of the escape hatch');
  } else {
    // A fast machine may stay under the 2 s threshold with 1 500 files; then the hint must be ABSENT,
    // which is also correct. Either way the command ran and was recorded.
    assert.doesNotMatch(r.stderr, /snapshots took/);
  }
  fs.writeFileSync(path.join(root, '.gitignore'), 'stray/\n');
  const fast = await cli(['wrap', '--tool', 'Bash', '--session', 'slow', '--', process.execPath, '-e', '0'], { cwd: root, timeout: 120000 });
  assert.doesNotMatch(fast.stderr, /snapshots took/, 'ignored, the tree is small again and the hint goes away');
});

test('TS-130-16 the public page says, per agent, what to run — and every adapter it names has a README (0.7.0 shipped without adapters/ollama/README.md)', () => {
  const readme = fs.readFileSync(path.join(PLUGIN, 'README.md'), 'utf8');
  const pick = readme.slice(readme.indexOf('## Pick your agent'), readme.indexOf('## Install in 10 minutes'));
  assert.ok(pick.length > 0, 'the per-agent section sits before the install section');
  for (const [agent, cmd] of [
    ['Claude Code', 'claude plugin install kiai@kiai'],
    ['Qwen / Llama / any model', 'kiai wrap --tool Bash --session <id> -- <command>'],
    ['Codex CLI', 'kiai import codex'],
    ['Cursor', 'kiai hooks --agent cursor > .cursor/hooks.json'],
  ]) {
    const row = pick.split('\n').find((l) => l.startsWith('| **' + agent));
    assert.ok(row, agent + ' has a row');
    assert.ok(row.includes(cmd), agent + ' row carries its command: ' + cmd);
    assert.ok(row.split('|').length >= 5, agent + ' row has a check column');
  }
  const adapters = fs.readdirSync(path.join(PLUGIN, 'adapters'), { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name);
  assert.deepEqual(adapters.sort(), ['codex', 'cursor', 'generic', 'ollama']);
  for (const a of adapters) {
    assert.ok(fs.existsSync(path.join(PLUGIN, 'adapters', a, 'README.md')), 'adapters/' + a + '/README.md exists');
    assert.ok(readme.includes('adapters/' + a + '/README.md'), 'README links adapters/' + a + '/README.md');
  }
});

test('TS-130-13 the generic contract lists the same events the plugin hooks do (R1-N)', async () => {
  // Two lists nobody compared: HOOK_EVENTS had 7 entries, the contract retyped 6.
  const c = await cli(['hooks', '--agent', 'generic'], { cwd: PLUGIN });
  const contract = JSON.parse(c.stdout.split('\n#')[0]);
  const h = await cli(['hooks'], { cwd: PLUGIN });
  assert.deepEqual(contract.events, Object.keys(JSON.parse(h.stdout).hooks), 'derived from the same list, so they cannot drift');
});

test('TS-130-08 cursor hook: a recognised payload is recorded and allowed; a blocked command is denied with the reason', needGit, async () => {
  const root = await freshRepo();
  const payload = (command, generation_id) => JSON.stringify({ conversation_id: 'cur-1', generation_id, command, cwd: root, hook_event_name: 'beforeShellExecution' });
  const ok = await run(CURSOR, ['beforeShellExecution'], { cwd: root, input: payload('git status', 'g1') });
  assert.equal(ok.code, 0);
  assert.deepEqual(JSON.parse(ok.stdout), { permission: 'allow' });
  assert.deepEqual(events(root, 'cur-1'), ['tool_call']);

  const deny = await run(CURSOR, ['beforeShellExecution'], { cwd: root, input: payload('git reset -q --hard HEAD~1', 'g2') });
  assert.equal(deny.code, 0, 'a refusal is an answer, never a crash');
  const j = JSON.parse(deny.stdout);
  assert.equal(j.permission, 'deny');
  assert.match(j.agent_message, /safety\/no-hard-reset-over-uncommitted-work/);
  assert.deepEqual(events(root, 'cur-1'), ['tool_call', 'tool_call'], 'the refused attempt is on the record too');
});

test('TS-130-17 cursor hook on the payload shape Cursor 3.19.7 really sends: root from workspace_roots alone, deny, and no user_email in any record', needGit, async () => {
  // Shape read from Cursor 3.19.7's workbench bundle (Hooks Service), 2026-09-19:
  //   { ...eventFields, session_id, hook_event_name, cursor_version, workspace_roots: folders.map(f => f.uri.path), user_email, transcript_path }
  // and folder.uri.path on Windows is "/d:/tmp/repo" — a URI path. The hook is run from OUTSIDE the
  // repository with no `cwd` field, so only a correctly normalised workspace_roots can find .kiai/.
  const root = await freshRepo();
  const uriPath = process.platform === 'win32' ? '/' + root.replace(/\\/g, '/') : root;
  const outside = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'kiai-cursor-outside-')));
  const wrap = (fields) => JSON.stringify({ session_id: 'conv-real-1', cursor_version: '3.19.7', workspace_roots: [uriPath], user_email: 'someone@example.com', transcript_path: path.join(outside, 't.jsonl'), ...fields });
  const a = await run(CURSOR, ['beforeShellExecution'], { cwd: outside, input: wrap({ hook_event_name: 'beforeShellExecution', conversation_id: 'conv-real-1', generation_id: 'gen-1', command: 'git status --short' }) });
  assert.deepEqual(JSON.parse(a.stdout), { permission: 'allow' });
  const b = await run(CURSOR, ['beforeShellExecution'], { cwd: outside, input: wrap({ hook_event_name: 'beforeShellExecution', conversation_id: 'conv-real-1', generation_id: 'gen-2', command: 'git reset --hard HEAD~1', cwd: root }) });
  assert.equal(JSON.parse(b.stdout).permission, 'deny', 'the real shape still reaches the rules');
  const c = await run(CURSOR, ['afterFileEdit'], { cwd: outside, input: wrap({ hook_event_name: 'afterFileEdit', conversation_id: 'conv-real-1', file_path: path.join(root, 'notes.txt'), edits: [{ old_string: 'a', new_string: 'b' }] }) });
  assert.deepEqual(JSON.parse(c.stdout), { permission: 'allow' });
  const d = await run(CURSOR, ['stop'], { cwd: outside, input: wrap({ hook_event_name: 'stop', conversation_id: 'conv-real-1', status: 'completed' }) });
  assert.deepEqual(JSON.parse(d.stdout), { permission: 'allow' });
  assert.deepEqual(events(root, 'conv-real-1'), ['tool_call', 'tool_call', 'tool_result', 'stop'], 'all four landed in the repository named only by workspace_roots');
  const raw = fs.readdirSync(path.join(root, '.kiai', 'flight')).flatMap((w) => fs.readdirSync(path.join(root, '.kiai', 'flight', w)).map((f) => fs.readFileSync(path.join(root, '.kiai', 'flight', w, f), 'utf8'))).join('');
  assert.doesNotMatch(raw, /someone@example\.com/, 'user_email is in every Cursor payload and must never be in a record');
  assert.doesNotMatch(raw, /t\.jsonl/, 'nor the transcript path');
});

test('TS-130-18 kiai record and rules check --stdin on the payload Cursor 3.21.13 really sends its Claude-style hooks: cwd "", plugin dir as process cwd, tool "Shell", event "preToolUse"', needGit, async () => {
  // Measured 2026-09-19 in Cursor's hooks log: "Running script in directory: <plugin cache dir>",
  // payload {cwd: "", tool_name: "Shell", hook_event_name: "preToolUse", workspace_roots: ["/d:/tmp/repo"]}.
  // The recorder then said "no .kiai/ above <plugin dir>; nothing recorded" — for every call.
  const root = await freshRepo();
  const uriPath = process.platform === 'win32' ? '/' + root.replace(/\\/g, '/') : root;
  const elsewhere = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'kiai-plugin-dir-')));
  const payload = (command, id) => JSON.stringify({ conversation_id: 'conv-live', generation_id: id, model: 'grok-4.6', tool_name: 'Shell', tool_input: { command, cwd: '', timeout: 30000 }, tool_use_id: id, cwd: '', session_id: 'conv-live', hook_event_name: 'preToolUse', cursor_version: '3.21.13', workspace_roots: [uriPath], user_email: 'someone@example.com', transcript_path: null });
  // Cursor 3.21.13 on Windows prefixes the payload with a UTF-8 BOM (bytes EF BB BF) — measured in the probe's
  // errors.log: `bad hook payload: Unexpected token '\uFEFF'`. Every payload below carries it.
  const BOM = '\uFEFF';
  const r = await cli(['record', 'PreToolUse'], { cwd: elsewhere, input: BOM + payload('git status --short', 'u1') });
  assert.equal(r.code, 0);
  assert.doesNotMatch(r.stderr, /nothing recorded/, 'the payload names the repository; the process cwd does not matter');
  const recs = readAll(root).filter((x) => x.session === 'conv-live');
  assert.equal(recs.length, 1);
  assert.equal(recs[0].event, 'tool_call', 'preToolUse is PreToolUse');
  assert.equal(recs[0].tool, 'Bash', 'Cursor\'s "Shell" is the shell');
  assert.equal(recs[0].input.command, 'git status --short');
  const c = await cli(['rules', 'check', '--stdin'], { cwd: elsewhere, input: BOM + payload('git reset --hard HEAD~1', 'u2') });
  assert.equal(c.code, 2, 'the rules of the repository in the payload apply, not those of the process cwd: ' + c.stderr);
  assert.match(c.stderr, /safety\/no-hard-reset-over-uncommitted-work/);
  const ok = await cli(['rules', 'check', '--stdin'], { cwd: elsewhere, input: BOM + payload('git status', 'u3') });
  assert.equal(ok.code, 0);
});

test('TS-130-20 cursor hook on the byte-exact live payload of 2026-09-19 (BOM + cwd "" + URI workspace root): git status recorded, git reset --hard DENIED', needGit, async () => {
  // Replay of what Cursor 3.21.13 sent to `kiai-cursor-hook.mjs beforeShellExecution` in the probe repository —
  // copied from its hooks log (INPUT block), plus the UTF-8 BOM the log does not show but errors.log proved.
  // Before the BOM fix this exact input produced {"permission":"allow"} for the reset, and the reset ran.
  const root = await freshRepo();
  const uriPath = process.platform === 'win32' ? '/' + root.replace(/\\/g, '/') : root;
  const live = (command, gen) => '\uFEFF' + JSON.stringify({
    conversation_id: 'd0d5174b-39ed-490e-b271-3960bdc0686c', generation_id: gen, model: 'grok-4.6', command, cwd: '', sandbox: false,
    session_id: 'd0d5174b-39ed-490e-b271-3960bdc0686c', hook_event_name: 'beforeShellExecution', cursor_version: '3.21.13',
    workspace_roots: [uriPath], user_email: 'someone@example.com', transcript_path: null,
  }, null, 2);
  const a = await run(CURSOR, ['beforeShellExecution'], { cwd: root, input: live('git status --short', 'cf882022-1') });
  assert.deepEqual(JSON.parse(a.stdout), { permission: 'allow' });
  const b = await run(CURSOR, ['beforeShellExecution'], { cwd: root, input: live('git reset --hard HEAD~1', 'cf882022-2') });
  const j = JSON.parse(b.stdout);
  assert.equal(j.permission, 'deny', 'this is the call that was allowed on 2026-09-19');
  assert.match(j.agent_message, /safety\/no-hard-reset-over-uncommitted-work/);
  const recs = readAll(root).filter((x) => x.session === 'd0d5174b-39ed-490e-b271-3960bdc0686c');
  assert.deepEqual(recs.map((x) => x.input.command), ['git status --short', 'git reset --hard HEAD~1'], 'both commands recorded with their real text, not ""');
  assert.ok(!fs.existsSync(path.join(root, '.kiai', 'flight', 'errors.log')) || !/empty or unparseable/.test(fs.readFileSync(path.join(root, '.kiai', 'flight', 'errors.log'), 'utf8')), 'no "unparseable stdin" entry');
});

test('TS-130-21 kiai record and rules check --stdin accept Cursor\'s NATIVE hook payload (beforeShellExecution, command at top level, BOM) — no translator needed', needGit, async () => {
  const root = await freshRepo();
  const uriPath = process.platform === 'win32' ? '/' + root.replace(/\\/g, '/') : root;
  const elsewhere = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'kiai-plugin-dir-')));
  const native = (command) => '\uFEFF' + JSON.stringify({ conversation_id: 'nat-1', generation_id: 'g', model: 'grok-4.6', command, cwd: '', sandbox: false, session_id: 'nat-1', hook_event_name: 'beforeShellExecution', cursor_version: '3.21.13', workspace_roots: [uriPath], user_email: 'someone@example.com', transcript_path: null });
  const r = await cli(['record', 'PreToolUse'], { cwd: elsewhere, input: native('git status --short') });
  assert.equal(r.code, 0);
  const recs = readAll(root).filter((x) => x.session === 'nat-1');
  assert.equal(recs.length, 1);
  assert.equal(recs[0].event, 'tool_call');
  assert.equal(recs[0].tool, 'Bash');
  assert.equal(recs[0].input.command, 'git status --short');
  const c = await cli(['rules', 'check', '--stdin'], { cwd: elsewhere, input: native('git reset --hard HEAD~1') });
  assert.equal(c.code, 2, c.stderr);
});

test('TS-130-19 cursor hook with an EMPTY stdin records nothing, allows, and leaves a line in the error log (the 2026-09-19 failure, made visible)', needGit, async () => {
  const root = await freshRepo();
  const before = readAll(root).length;
  const r = await run(CURSOR, ['beforeShellExecution'], { cwd: root, input: '' });
  assert.equal(r.code, 0);
  assert.deepEqual(JSON.parse(r.stdout), { permission: 'allow' }, 'fail-safe: the editor keeps working');
  assert.equal(readAll(root).length, before, 'no record with command "" — a record that says nothing is worse than none');
  const log = fs.readFileSync(path.join(root, '.kiai', 'flight', 'errors.log'), 'utf8');
  assert.match(log, /cursor hook beforeShellExecution: empty or unparseable stdin \(0 bytes\)/);
});

test('TS-130-09 cursor hook never breaks the editor: junk, unknown events and no repository all answer allow, exit 0', needGit, async () => {
  const root = await freshRepo();
  for (const [ev, input] of [['beforeShellExecution', 'not json'], ['beforeShellExecution', '[1,2]'], ['somethingNew', JSON.stringify({ cwd: root })], ['stop', JSON.stringify({ conversation_id: 'cur-2', cwd: root })]]) {
    const r = await run(CURSOR, [ev], { cwd: root, input });
    assert.equal(r.code, 0, `${ev}: exit 0`);
    assert.equal(JSON.parse(r.stdout).permission, 'allow', `${ev}: allow`);
  }
  // an unknown event still leaves a trace, so a Cursor user can see the hook fired even when unmapped
  assert.ok(readAll(root).some((r) => r.tool === 'unknown'), 'unmapped event recorded as `unknown`');
  const outside = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'kiai-nowhere-')));
  const r = await run(CURSOR, ['beforeShellExecution'], { cwd: outside, input: JSON.stringify({ command: 'ls', cwd: outside }) });
  assert.equal(r.code, 0);
  assert.equal(JSON.parse(r.stdout).permission, 'allow');
});

test('TS-130-10 hooks --agent cursor prints a hooks.json pointing every event at the translator, and says what is still unmeasured', async () => {
  const r = await cli(['hooks', '--agent', 'cursor'], { cwd: PLUGIN });
  assert.equal(r.code, 0);
  assert.match(r.stderr, /A live run WITH the fix is still owed/, 'what is still unmeasured says so, on every run');
  const j = JSON.parse(r.stdout);
  assert.deepEqual(Object.keys(j.hooks).sort(), ['afterFileEdit', 'beforeMCPExecution', 'beforeShellExecution', 'stop']);
  for (const [ev, list] of Object.entries(j.hooks)) {
    assert.match(list[0].command, /kiai-cursor-hook\.mjs" /);
    assert.ok(list[0].command.endsWith(' ' + ev), `${ev}: the translator is told which event it is`);
  }
});
