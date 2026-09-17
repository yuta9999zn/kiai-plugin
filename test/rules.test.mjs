// Tests for `kiai rules` (UOW-129): rules as data a machine can look up and enforce.
//
// The gate being tested here guards rule FILES, the way data_spec.rb guards the authored rulebook in
// a rule-driven review tool the same author maintains — "a bad hand-edit fails here and not in
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import {
  validateRule, loadRules, lintSet, checkExamples, nearMissReport, unexercisedConditions,
  ruleMatches, evaluate, searchRules, RULES_DIR, ENFORCEMENT,
} from '../lib/rules.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CLI = path.join(HERE, '..', 'bin', 'kiai.mjs');
const REPO = path.join(HERE, '..', '..');
/**
 * The two cases below read the rule set of the repository this plugin lives in. A standalone
 * checkout of the plugin — the public repo, or anyone's clone — has no `.kiai/rules/`, so they must
 * SKIP with a reason there. Failing would say the plugin is broken when it is not; passing silently
 * would say a rule set was checked when none existed.
 */
const ownRules = loadRules(REPO);
const needOwnRules = {
  skip: ownRules.present && ownRules.rules.length
    ? false
    : 'no .kiai/rules/ here — a standalone plugin checkout has no rule set of its own',
};

function runCli(args, { cwd, input = '', timeout = 30000 } = {}) {
  const clean = { ...process.env };
  delete clean.CLAUDECODE; delete clean.CLAUDE_CODE_ENTRYPOINT;
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [CLI, ...args], { cwd, env: clean, stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = ''; let stderr = '';
    const timer = setTimeout(() => { child.kill('SIGKILL'); reject(new Error('CLI hung: ' + args.join(' '))); }, timeout);
    child.stdout.on('data', (d) => { stdout += d; });
    child.stderr.on('data', (d) => { stderr += d; });
    child.on('close', (code) => { clearTimeout(timer); resolve({ code, stdout, stderr }); });
    child.stdin.end(input);
  });
}

/** A minimal rule that passes every gate — the baseline each test then breaks in exactly one way. */
const sound = (over = {}) => ({
  id: 'demo/never-rm-rf-slash',
  family: 'demo',
  rank: 10,
  modality: 'MUST_NOT',
  enforcement: 'block',
  title: { vi: 'Không xoá gốc', en: 'Do not delete the root' },
  statement: { vi: 'Không chạy rm -rf /', en: 'Do not run rm -rf /' },
  why: { vi: 'Không hoàn tác được', en: 'It cannot be undone' },
  source: 'a made-up incident, for the tests',
  applies_when: [
    { signal: 'tool', op: 'eq', value: 'Bash' },
    { signal: 'command', op: 'matches', value: 'rm\\s+-rf\\s+/(\\s|$)' },
  ],
  examples: [
    { verdict: 'violates', text: { en: 'rm -rf /' }, action: { tool: 'Bash', command: 'rm -rf /' } },
    { verdict: 'complies', text: { en: 'rm -rf ./build' }, action: { tool: 'Bash', command: 'rm -rf ./build' } },
  ],
  ...over,
});

function tmpRules(docs) {
  const root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'kiai-rules-')));
  fs.mkdirSync(path.join(root, RULES_DIR), { recursive: true });
  fs.writeFileSync(path.join(root, RULES_DIR, 'demo.json'), JSON.stringify(docs, null, 2));
  return root;
}

// ---- the schema gate -----------------------------------------------------------------------

test('TS-129-01 a sound rule passes, and each required field is required for a stated reason', () => {
  assert.deepEqual(validateRule(sound()), []);
  for (const field of ['id', 'family', 'rank', 'modality', 'enforcement', 'title', 'statement', 'why', 'source', 'examples']) {
    const broken = sound();
    delete broken[field];
    const errs = validateRule(broken, { file: 'demo.json' });
    assert.ok(errs.some((e) => e.includes(`missing \`${field}\``)), `dropping ${field} must be caught`);
    // the message has to say WHY, or the next author removes the field again
    assert.ok(errs.some((e) => e.includes(`missing \`${field}\``) && e.length > `demo.json: missing \`${field}\` — `.length + 20),
      `the error for ${field} must carry its reason`);
  }
});

test('TS-129-02 a rule with no allowed example is refused — that is the over-blocking gate', () => {
  // The measurement behind this: across 83 production system prompts `example` is the most repeated
  // heading by ~9x, but nothing there requires an example of what is ALLOWED. A rule that cannot name
  // a case it permits is forbidding the whole territory around the thing it meant to forbid.
  const r = sound({ examples: [
    { verdict: 'violates', text: { en: 'rm -rf /' }, action: { tool: 'Bash', command: 'rm -rf /' } },
    { verdict: 'violates', text: { en: 'rm -rf / --no-preserve-root' }, action: { tool: 'Bash', command: 'rm -rf / --no-preserve-root' } },
  ] });
  const errs = validateRule(r, { file: 'demo.json' });
  assert.ok(errs.some((e) => /at least one `complies` example/.test(e)));
  assert.ok(errs.some((e) => /over-block/.test(e)), 'and it must say why, not just that');
});

test('TS-129-03 a rule that cannot fire may not call itself a gate', () => {
  // A `warn` with no condition promises the actor will hear about it and cannot keep that promise.
  // Overstating reach is the failure family that has cost this project four P1s.
  const noCond = sound({ enforcement: 'warn' });
  delete noCond.applies_when;
  assert.ok(validateRule(noCond, { file: 'demo.json' }).some((e) => /needs applies_when/.test(e)));

  const blocked = sound();
  delete blocked.applies_when;
  const bErrs = validateRule(blocked, { file: 'demo.json' });
  assert.ok(bErrs.some((e) => /enforcement "block" needs applies_when/.test(e)));
  // One defect, one line. Before R1-N3 this produced TWO ERROR lines for the same thing, which makes
  // the count of errors lie about how many things are wrong.
  assert.equal(bErrs.filter((e) => /needs applies_when/.test(e)).length, 1);

  // ...and the honest form of the same rule passes
  const advisory = sound({ enforcement: 'advice' });
  delete advisory.applies_when;
  advisory.examples = advisory.examples.map(({ action, ...e }) => e);
  assert.deepEqual(validateRule(advisory), []);
});

test('TS-129-04 a regex that does not compile fails here, not at enforcement time', () => {
  const r = sound({ applies_when: [{ signal: 'command', op: 'matches', value: 'rm\\s+-rf\\s+(' }] });
  assert.ok(validateRule(r, { file: 'demo.json' }).some((e) => /not a valid regex/.test(e)));
});

// ---- the set-level gate --------------------------------------------------------------------

test('TS-129-05 duplicate ids, dangling refs and a tied rank are all caught', () => {
  const a = { ...sound(), _file: 'a.json' };
  const b = { ...sound(), _file: 'b.json' };
  assert.ok(lintSet([a, b]).some((e) => /duplicate id/.test(e)));

  const c = { ...sound({ id: 'demo/other', rank: 20, refs: ['demo/does-not-exist'] }), _file: 'c.json' };
  assert.ok(lintSet([a, c]).some((e) => /is not a rule here/.test(e)));

  // Same family, same rank: which one wins would depend on file order, and that is not a decision.
  const d = { ...sound({ id: 'demo/tie' }), _file: 'd.json' };
  assert.ok(lintSet([a, d]).some((e) => /precedence would depend on file order/.test(e)));
});

test('TS-129-06 an example whose claimed verdict disagrees with the rule is caught', () => {
  // This is what makes a rule self-checking: its documentation is replayed as its test.
  const r = { ...sound(), _file: 'demo.json' };
  r.examples = [
    { verdict: 'violates', text: { en: 'a safe command mislabelled' }, action: { tool: 'Bash', command: 'ls -la' } },
    { verdict: 'complies', text: { en: 'rm -rf ./build' }, action: { tool: 'Bash', command: 'rm -rf ./build' } },
  ];
  const errs = checkExamples([r]);
  assert.equal(errs.length, 1);
  assert.match(errs[0], /claims violates but the rule's own conditions say complies/);
});

test('TS-129-07 a block rule needs a NEAR MISS; a distant counterexample is not enough', () => {
  const far = { ...sound(), _file: 'demo.json' };
  far.examples = [
    { verdict: 'violates', text: { en: 'rm -rf /' }, action: { tool: 'Bash', command: 'rm -rf /' } },
    { verdict: 'complies', text: { en: 'read a file' }, action: { tool: 'Read', path: 'README.md' } },
  ];
  const far1 = nearMissReport([far]);
  assert.equal(far1.errors.length, 1, 'a block rule without a near miss is an error');
  assert.match(far1.errors[0], /no NEAR MISS/);

  // the same rule with an allowed example that shares the primary signal passes
  const near = { ...sound(), _file: 'demo.json' };
  assert.deepEqual(nearMissReport([near]), { errors: [], warnings: [] });

  // and at warn level the same gap is a warning, not a wall — force decides severity
  const soft = { ...far, enforcement: 'warn' };
  const soft1 = nearMissReport([soft]);
  assert.equal(soft1.errors.length, 0);
  assert.equal(soft1.warnings.length, 1);
});

test('TS-129-08 a condition no violating example exercises is reported', () => {
  // Measured gap this closes: `if … then` appears 34 times in 1.8M chars of real prompts. An untested
  // condition fires for the first time on a real action.
  const r = { ...sound(), _file: 'demo.json' };
  r.applies_when = [...r.applies_when, { signal: 'agent', op: 'eq', value: 'never-set' }];
  const out = unexercisedConditions([r]);
  assert.equal(out.length, 1);
  assert.match(out[0], /is never exercised by any `violates` example/);
});

// ---- the engine ----------------------------------------------------------------------------

test('TS-129-09 conditions are AND, and a rule with none never matches', () => {
  const r = sound();
  assert.equal(ruleMatches(r, { tool: 'Bash', command: 'rm -rf /' }), true);
  assert.equal(ruleMatches(r, { tool: 'Write', command: 'rm -rf /' }), false, 'every condition must hold');
  const noCond = sound({ enforcement: 'record' });
  delete noCond.applies_when;
  assert.equal(ruleMatches(noCond, { tool: 'Bash', command: 'rm -rf /' }), false);
});

test('TS-129-10 evaluate returns the most severe decision, and block outranks warn', () => {
  const block = sound();
  const warn = sound({ id: 'demo/warn', rank: 20, enforcement: 'warn' });
  const { decision, hits } = evaluate([warn, block], { tool: 'Bash', command: 'rm -rf /' });
  assert.equal(decision, 'block');
  assert.equal(hits[0].id, block.id, 'the blocking rule is reported first, whatever order the files load in');
  assert.equal(evaluate([warn, block], { tool: 'Bash', command: 'ls' }).decision, 'clear');
});

test('TS-129-11 search is deterministic and finds a rule in either language', () => {
  const rs = [sound(), sound({ id: 'demo/other', rank: 20, title: { vi: 'Neo phải được commit', en: 'The anchor must be committed' },
    statement: { vi: 'Neo chưa commit không chứng được gì', en: 'An uncommitted anchor proves nothing' },
    why: { vi: 'Kẻ ghi sửa được nó', en: 'Its writer can still change it' } })];
  const vi = searchRules(rs, 'neo commit');
  assert.ok(vi.length && vi[0].rule.id === 'demo/other', 'a Vietnamese query finds the Vietnamese rule');
  const en = searchRules(rs, 'delete the root');
  assert.ok(en.length && en[0].rule.id === 'demo/never-rm-rf-slash');
  // Two runs of one query must never disagree, or a lookup cannot be cited.
  assert.deepEqual(searchRules(rs, 'commit').map((h) => h.rule.id), searchRules(rs, 'commit').map((h) => h.rule.id));
  assert.deepEqual(searchRules(rs, ''), []);
});

// ---- the command surface -------------------------------------------------------------------

test('TS-129-12 `rules check` exits 2 on a block, 0 on a near miss', async () => {
  const root = tmpRules([sound()]);
  const bad = await runCli(['rules', 'check', '--tool', 'Bash', '--command', 'rm -rf /'], { cwd: root });
  assert.equal(bad.code, 2, 'exit 2, not 1: a hook must tell "forbidden" apart from "the tool failed"');
  assert.match(bad.stdout, /BLOCKED BY demo\/never-rm-rf-slash/);
  assert.match(bad.stdout, /why:/, 'the reason travels with the refusal, or it gets worked around');

  const ok = await runCli(['rules', 'check', '--tool', 'Bash', '--command', 'rm -rf ./build'], { cwd: root });
  assert.equal(ok.code, 0);
  assert.match(ok.stdout, /CLEAR/);
});

test('TS-129-13 as a hook: a real payload blocks, and an unreadable one lets the action through', async () => {
  // Returning 2 on an unparseable payload would block EVERY tool call — the fastest way to get the
  // hook switched off, after which it protects nothing. A gate that cannot see the action does not
  // get to refuse it.
  const root = tmpRules([sound()]);
  const payload = JSON.stringify({ hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command: 'rm -rf /' } });
  const hit = await runCli(['rules', 'check', '--stdin', '--quiet'], { cwd: root, input: payload });
  assert.equal(hit.code, 2);

  for (const junk of ['', 'not json at all', '{}']) {
    const r = await runCli(['rules', 'check', '--stdin', '--quiet'], { cwd: root, input: junk });
    assert.equal(r.code, 0, `an unusable payload (${JSON.stringify(junk)}) must not block the session`);
  }
});

test('TS-129-14 `rules lint` fails on a broken file and says which file', async () => {
  const broken = sound();
  delete broken.why;
  const root = tmpRules([broken]);
  const r = await runCli(['rules', 'lint'], { cwd: root });
  assert.equal(r.code, 1);
  assert.match(r.stdout, /ERROR\s+demo\.json: missing `why`/);

  const good = tmpRules([sound()]);
  const ok = await runCli(['rules', 'lint'], { cwd: good });
  assert.equal(ok.code, 0, ok.stdout + ok.stderr);
  assert.match(ok.stdout, /every example replayed through the engine agrees/);
});

test('TS-129-15 `rules show` puts the examples and the reason in front of the reader', async () => {
  const root = tmpRules([sound()]);
  const r = await runCli(['rules', 'show', 'demo/never-rm-rf-slash'], { cwd: root });
  assert.equal(r.code, 0);
  assert.match(r.stdout, /WHY: It cannot be undone/);
  assert.match(r.stdout, /FROM: a made-up incident/, 'no rule out of thin air: the source is printed');
  assert.match(r.stdout, /EXAMPLES/);
  assert.ok(r.stdout.includes('rm\\s+-rf\\s+/(\\s|$)'),
    'the regex prints as a regex — copyable, not markdown-escaped (cell() turns | into \| and * into a lookalike)');
  assert.equal((await runCli(['rules', 'show', 'demo/nope'], { cwd: root })).code, 2);
});

test('TS-129-18 no enforcement level promises something the code does not do', () => {
  // This level was first called `record`, which reads as "written into the flight record". Nothing
  // wrote it, and in a project whose core IS a flight record that was a word stronger than the
  // behaviour — the fifth time this repository has done that, inside the UoW built to stop it.
  assert.deepEqual(ENFORCEMENT, ['block', 'warn', 'advice']);
  assert.ok(!ENFORCEMENT.includes('record'), 'no level may imply a write that does not happen');
  const { rules } = loadRules(REPO);
  for (const r of rules) assert.ok(ENFORCEMENT.includes(r.enforcement), `${r.id} has an unknown level`);
});

test('TS-129-19 --action carries the payload and --json prints JSON — one flag, one meaning', async () => {
  // The first version read `--json` as BOTH the payload and the output format. A flag that means two
  // things is how a tool teaches people to stop trusting its output.
  const root = tmpRules([sound()]);
  const hit = await runCli(['rules', 'check', '--action', JSON.stringify({ tool: 'Bash', command: 'rm -rf /' }), '--json'], { cwd: root });
  assert.equal(hit.code, 2);
  const out = JSON.parse(hit.stdout);
  assert.equal(out.decision, 'block');
  assert.equal(out.hits[0].id, 'demo/never-rm-rf-slash');
  assert.ok(out.hits[0].why, 'the reason travels in the JSON too');

  const clear = await runCli(['rules', 'check', '--action', JSON.stringify({ tool: 'Bash', command: 'ls' }), '--json'], { cwd: root });
  assert.equal(clear.code, 0);
  assert.equal(JSON.parse(clear.stdout).decision, 'clear');

  const bad = await runCli(['rules', 'check', '--action', 'not json'], { cwd: root });
  assert.equal(bad.code, 2);
  assert.match(bad.stderr, /not valid JSON/);
});
test('TS-129-20 a gate rule needs an allowed example with a real action, not prose (R1-P1)', () => {
  // Review round 1 drove a catch-all `block` rule (condition `.*`) through a clean `lint` by writing
  // its one allowed example as prose. Both semantic gates skip an example with no `action`, while the
  // declaration gate only counted it. The rule then blocked `git status`.
  const prose = sound({ applies_when: [
    { signal: 'tool', op: 'eq', value: 'Bash' },
    { signal: 'command', op: 'matches', value: '.*' },
  ] });
  prose.examples = [
    { verdict: 'violates', text: { en: 'anything' }, action: { tool: 'Bash', command: 'rm -rf /' } },
    { verdict: 'complies', text: { en: 'reading a file is fine' } },
  ];
  const errs = validateRule(prose, { file: 'demo.json' });
  assert.ok(errs.some((e) => /needs a `complies` example WITH an `action`/.test(e)));
  assert.ok(errs.some((e) => /satisfies the count without testing anything/.test(e)), 'and it must say why prose is not enough');

  // the same rule at `advice` is fine: nothing is being claimed, so prose is honest
  const advisory = { ...prose, enforcement: 'advice' };
  assert.deepEqual(validateRule(advisory).filter((e) => /complies/.test(e)), []);
});

test('TS-129-21 a near miss must fail exactly ONE condition, not all of them (R1-P2)', () => {
  const r = { ...sound({ applies_when: [
    { signal: 'tool', op: 'eq', value: 'Bash' },
    { signal: 'command', op: 'contains', value: 'DROP TABLE prod' },
  ] }), _file: 'demo.json' };

  // fails both conditions — a different action altogether, not a neighbour
  r.examples = [
    { verdict: 'violates', text: { en: 'drops it' }, action: { tool: 'Bash', command: "psql -c 'DROP TABLE prod'" } },
    { verdict: 'complies', text: { en: 'reads a file' }, action: { tool: 'Read', path: 'README.md' } },
  ];
  const far = nearMissReport([r]);
  assert.equal(far.errors.length, 1);
  assert.match(far.errors[0], /fails more than one of the rule's 2 condition/);

  // fails exactly one — the pair that draws the line
  r.examples[1] = { verdict: 'complies', text: { en: 'a harmless psql call' }, action: { tool: 'Bash', command: "psql -c 'SELECT 1'" } };
  assert.deepEqual(nearMissReport([r]), { errors: [], warnings: [] });
});

test('TS-129-22 terminal output is never markdown-escaped, anywhere (R1-P3b)', async () => {
  // `cell` turns | into \|, * into a lookalike and a backtick into a quote. Correct for a markdown
  // table and wrong on a terminal: review round 1 found `con-thuyen/**` printed as `con-thuyen/∗∗`
  // and a shell example's backticks turned into quotes, which changes what the command means.
  const r = sound();
  r.title = { en: 'keep **con-thuyen/**` and `a|b` intact' };
  r.statement = { en: 'a statement with ** and ` and |' };
  r.examples = [
    { verdict: 'violates', text: { en: "run `git commit -am 'wip'` with **stars**" }, action: { tool: 'Bash', command: 'rm -rf /' } },
    { verdict: 'complies', text: { en: 'a note with `backticks` and **stars**' }, action: { tool: 'Bash', command: 'rm -rf ./build' } },
  ];
  const root = tmpRules([r]);
  const banned = (out, where) => {
    assert.ok(!out.includes('\u2217'), `${where}: * became a lookalike`);
    assert.ok(!out.includes('\\|'), `${where}: | was escaped for a markdown table`);
  };
  const show = await runCli(['rules', 'show', r.id], { cwd: root });
  banned(show.stdout, 'show');
  assert.ok(show.stdout.includes("`git commit -am 'wip'`"), 'show: backticks in an example survive');
  assert.ok(show.stdout.includes('**stars**'), 'show: stars in an example survive');

  const check = await runCli(['rules', 'check', '--tool', 'Bash', '--command', 'rm -rf /'], { cwd: root });
  banned(check.stdout, 'check');
  const list = await runCli(['rules', 'list'], { cwd: root });
  banned(list.stdout, 'list');
  const search = await runCli(['rules', 'search', 'con-thuyen'], { cwd: root });
  banned(search.stdout, 'search');
});

test('TS-129-23 --json carries the statement, and an unloadable rule is never silent (R1-P3c)', async () => {
  const root = tmpRules([sound()]);
  const r = await runCli(['rules', 'check', '--tool', 'Bash', '--command', 'rm -rf /', '--json'], { cwd: root });
  const out = JSON.parse(r.stdout);
  assert.ok(out.hits[0].statement, 'a machine reading --json must get the normative sentence, not only the title');
  assert.ok(out.hits[0].why);

  // A rule file that does not load is a rule that does not protect. Answering CLEAR without saying so
  // is a gate going green for lack of evidence.
  const broken = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'kiai-rules-')));
  fs.mkdirSync(path.join(broken, RULES_DIR), { recursive: true });
  fs.writeFileSync(path.join(broken, RULES_DIR, 'bad.json'), JSON.stringify([{ id: 'x/broken' }]));
  const q = await runCli(['rules', 'check', '--tool', 'Bash', '--command', 'git status'], { cwd: broken });
  assert.match(q.stderr, /rule file problem\(s\) — those rules are NOT enforced/);
  assert.equal(q.code, 0, 'but it must not refuse every action because one file has a typo');
});

// ---- this repository's own rules ------------------------------------------------------------

test("TS-129-16 this repo's own rule set passes its own gate", needOwnRules, () => {
  // The rules KIAI works under are data in this repository, so they are linted like any other input.
  // A rule set that cannot pass the gate it defines is not a rule set.
  const { rules, problems } = loadRules(REPO);
  assert.equal(problems.length, 0, problems.join('\n'));
  assert.ok(rules.length >= 20, `expected a real rule set, found ${rules.length}`);
  assert.deepEqual(lintSet(rules), []);
  assert.deepEqual(checkExamples(rules), []);
  assert.deepEqual(nearMissReport(rules).errors, []);
});

test('TS-129-17 the command that actually destroyed work is blocked by the rule it produced', needOwnRules, async () => {
  // On 2026-09-17 `git reset -q --hard <merge>` destroyed two uncommitted files. The FIRST version of
  // the rule written from that incident did not match it, because the regex wanted `reset` directly
  // followed by `--hard` and the real command had `-q` in between. A rule has to be replayed against
  // the real command, not the one its author imagines.
  const { rules } = loadRules(REPO);
  const real = { tool: 'Bash', command: 'git reset -q --hard e6ba318' };
  assert.equal(evaluate(rules, real).decision, 'block');
  for (const near of ['git reset --soft HEAD~1', 'git revert --abort', 'git stash', 'git status']) {
    assert.equal(evaluate(rules, { tool: 'Bash', command: near }).decision, 'clear', `${near} must stay allowed`);
  }
});
