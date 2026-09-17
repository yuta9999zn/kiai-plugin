// `kiai rules` (UOW-129) — rules an agent works under, as DATA a machine can ask and enforce.
//
// Why this exists, measured rather than assumed: across UOW-127 and UOW-128 I wrote a lesson down
// and then broke it anyway, twice, by the same mechanism — the lesson lived in prose, so honouring
// it depended on my remembering it. It did not survive. A rule that only a reader can check is a
// rule that gets broken by whoever is not reading.
//
// Two sources shaped this file, and each contributed something the other lacked:
//
//   83 production system prompts (1.8M chars, audited 2026-09-17). Measured: `example` is the most
//   repeated heading by ~9x, prohibitions outnumber obligations 2:1 — but `if … then` appears only
//   34 times in the whole corpus. Real prompts are EXAMPLES plus unconditional imperatives. The
//   examples are the good part; the missing conditions are the gap this file fills. Nothing is
//   copied from them: they are leaked proprietary text under a licence the uploader cannot grant.
//
//   A rule-driven review tool the same author maintains. Rules as structured JSON; a schema gate
//   that runs on the rule files themselves so "a bad hand-edit fails here and not in production";
//   precedence as data (family + rank); examples carrying their own verdict; and the line that
//   decides the architecture — "the questionnaire decides; this explains". The engine computes the
//   answer. The model never does.
//
// Everything here is offline and deterministic. Same input, same output, no network, no model.

import fs from 'node:fs';
import path from 'node:path';

export const RULES_DIR = path.join('.kiai', 'rules');

/** MUST/SHOULD carry different weight and a gate must not blur them (RFC 2119, minus MAY's vagueness). */
export const MODALITY = ['MUST', 'MUST_NOT', 'SHOULD', 'SHOULD_NOT'];

/**
 * What a match does.
 *   block  — refuse the action. Reserved for harm that was MEASURED, not imagined (see `source`).
 *   warn   — say it, let it through. The honest default for "usually wrong".
 *   advice — never fires as a gate. Findable, citable, and enforced by nothing.
 *
 * The three exist because collapsing them is how a check earns the right to be ignored: a tool that
 * blocks on suspicion gets switched off, and then it protects nothing at all.
 *
 * This level was first called `record`, which promised the match would be written into the flight
 * record. Nothing wrote it. In a project whose core IS a flight record that name was a claim the code
 * did not keep — the fifth time this repository has shipped a word stronger than its behaviour, and
 * inside the very UoW built to stop that. `advice` promises nothing, so there is nothing to break.
 */
export const ENFORCEMENT = ['block', 'warn', 'advice'];

export const VERDICT = ['violates', 'complies'];

export function rulesDir(root) {
  return path.join(root, RULES_DIR);
}

/** Every field a rule must carry, and the one-line reason each is not optional. */
const REQUIRED = {
  id: 'without a stable id nothing can reference this rule or record that it fired',
  family: 'precedence is resolved inside a family, so a rule outside one has no place in the order',
  rank: 'two rules can disagree; rank decides which wins, and guessing is not deciding',
  modality: 'MUST and SHOULD are different promises and a gate must not blur them',
  enforcement: 'block / warn / advice is the difference between a tool people keep and one they switch off',
  title: 'a rule nobody can find is a rule nobody follows',
  statement: 'the normative sentence itself',
  why: 'a rule whose reason is unwritten cannot be argued with, and so it will be worked around',
  source: 'the incident that produced this rule — no rule out of thin air',
  examples: 'measured: `example` is the most repeated heading in 83 production prompts, by ~9x',
};

const ID_RE = /^[a-z0-9]+(?:[-/][a-z0-9]+)*$/;

/** A bilingual field: {vi, en}. English is required so the rule survives a non-Vietnamese reader. */
function badText(v, where) {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return `${where} must be an object {vi, en}`;
  if (typeof v.en !== 'string' || !v.en.trim()) return `${where}.en is required`;
  if (v.vi !== undefined && typeof v.vi !== 'string') return `${where}.vi must be a string`;
  return null;
}

/**
 * One condition the machine can actually evaluate. This is the piece the leaked prompts do not have:
 * 34 `if … then` in 1.8M characters. A rule with no machine-readable condition can only ever be
 * advice.
 *
 *   signal — which field of the action to look at (tool, command, path, event, …)
 *   op     — eq | neq | matches | not_matches | contains | absent
 *   value  — literal, or a regex source for matches/not_matches
 */
function badCondition(c, where) {
  if (!c || typeof c !== 'object' || Array.isArray(c)) return `${where} must be an object`;
  if (typeof c.signal !== 'string' || !c.signal.trim()) return `${where}.signal is required`;
  const OPS = ['eq', 'neq', 'matches', 'not_matches', 'contains', 'absent'];
  if (!OPS.includes(c.op)) return `${where}.op must be one of ${OPS.join(', ')}`;
  if (c.op === 'absent') return c.value === undefined ? null : `${where}.value must be omitted for op 'absent'`;
  if (typeof c.value !== 'string' || !c.value.length) return `${where}.value is required`;
  if (c.op === 'matches' || c.op === 'not_matches') {
    // A regex that does not compile would throw at enforcement time — i.e. on the one path that is
    // supposed to be reliable. It fails here instead.
    try { new RegExp(c.value, c.flags || 'i'); } catch (e) { return `${where}.value is not a valid regex: ${e.message}`; }
  }
  return null;
}

/** Validate one rule document. Returns an array of human-readable problems; empty means it is sound. */
export function validateRule(doc, { file = '?' } = {}) {
  const out = [];
  const at = (s) => `${file}: ${s}`;
  if (!doc || typeof doc !== 'object' || Array.isArray(doc)) return [at('not a JSON object')];

  for (const [k, why] of Object.entries(REQUIRED)) {
    if (doc[k] === undefined || doc[k] === null || (Array.isArray(doc[k]) && !doc[k].length)) {
      out.push(at(`missing \`${k}\` — ${why}`));
    }
  }
  if (typeof doc.id === 'string' && !ID_RE.test(doc.id)) {
    out.push(at(`id "${doc.id}" must be lowercase words joined by - or / (it is used in paths, logs and search)`));
  }
  if (doc.modality !== undefined && !MODALITY.includes(doc.modality)) {
    out.push(at(`modality must be one of ${MODALITY.join(', ')}`));
  }
  if (doc.enforcement !== undefined && !ENFORCEMENT.includes(doc.enforcement)) {
    out.push(at(`enforcement must be one of ${ENFORCEMENT.join(', ')}`));
  }
  if (doc.rank !== undefined && !Number.isInteger(doc.rank)) out.push(at('rank must be an integer'));
  for (const f of ['title', 'statement', 'why']) {
    if (doc[f] !== undefined) { const e = badText(doc[f], f); if (e) out.push(at(e)); }
  }
  if (doc.source !== undefined && (typeof doc.source !== 'string' || !doc.source.trim())) {
    out.push(at('source must be a non-empty string naming the incident this rule came from'));
  }

  const conds = doc.applies_when;
  if (conds !== undefined) {
    if (!Array.isArray(conds)) out.push(at('applies_when must be an array'));
    else conds.forEach((c, i) => { const e = badCondition(c, `applies_when[${i}]`); if (e) out.push(at(e)); });
  }
  // A rule that claims to be a gate must be able to fire. `warn` and `block` both promise the actor
  // will hear about it; with no machine-readable condition that promise cannot be kept, and the rule
  // set would overstate its own reach — the exact failure family that has already cost this project
  // four P1s. An advisory rule is honest: it says `advice`, stays findable, and claims nothing.
  if ((doc.enforcement === 'warn' || doc.enforcement === 'block') && !(Array.isArray(conds) && conds.length)) {
    out.push(at(`enforcement "${doc.enforcement}" needs applies_when — without a condition this rule can never fire, so calling it a gate overstates it; use "advice" for a rule meant to be read`));
  }


  const ex = doc.examples;
  if (ex !== undefined) {
    if (!Array.isArray(ex)) out.push(at('examples must be an array'));
    else {
      if (ex.length < 2) out.push(at('needs at least 2 examples — one that violates and one that does not'));
      ex.forEach((e, i) => {
        if (!e || typeof e !== 'object') { out.push(at(`examples[${i}] must be an object`)); return; }
        if (!VERDICT.includes(e.verdict)) out.push(at(`examples[${i}].verdict must be ${VERDICT.join(' or ')}`));
        const t = badText(e.text, `examples[${i}].text`);
        if (t) out.push(at(t));
        if (e.action !== undefined && (typeof e.action !== 'object' || Array.isArray(e.action))) {
          out.push(at(`examples[${i}].action must be an object of signals, e.g. {"tool":"Bash","command":"…"}`));
        }
      });
      // THE anti-false-alarm gate, and the reason it is not optional: a rule that cannot name one
      // allowed case is a rule that forbids the whole territory around the thing it meant to forbid.
      // Every round of UOW-127 and UOW-128 turned on this distinction.
      if (!ex.some((e) => e && e.verdict === 'complies')) {
        out.push(at('every rule needs at least one `complies` example — a rule that cannot name a case it ALLOWS is a rule that over-blocks'));
      }
      if (!ex.some((e) => e && e.verdict === 'violates')) {
        out.push(at('every rule needs at least one `violates` example, or nothing shows what it is for'));
      }
      // Review round 1 of UOW-129 drove a catch-all `block` rule (condition `.*`) straight through a
      // clean `lint` by writing its one allowed example as PROSE. Both semantic gates skip an example
      // with no `action` — `checkExamples` cannot replay it and `nearMissReport` cannot compare it —
      // while the declaration gate above only counted it. The rule then blocked `git status`.
      //
      // A rule that stops or warns about real actions has to be tested against a real action. Prose
      // examples stay welcome on an `advice` rule, where nothing is being claimed.
      if ((doc.enforcement === 'warn' || doc.enforcement === 'block')
          && !ex.some((e) => e && e.verdict === 'complies' && e.action)) {
        out.push(at(`a "${doc.enforcement}" rule needs a \`complies\` example WITH an \`action\` — a prose-only example is skipped by the replay and the near-miss checks, so it satisfies the count without testing anything`));
      }
    }
  }
  return out;
}

/** Read every rule file under <root>/.kiai/rules. Never throws: unreadable files become problems. */
export function loadRules(root) {
  const dir = rulesDir(root);
  const rules = [];
  const problems = [];
  let names = [];
  try {
    names = fs.readdirSync(dir).filter((f) => f.endsWith('.json')).sort();
  } catch {
    return { rules, problems, dir, present: false };
  }
  for (const name of names) {
    const file = path.join(dir, name);
    let text;
    try { text = fs.readFileSync(file, 'utf8'); } catch (e) { problems.push(`${name}: cannot read (${e.message})`); continue; }
    let doc;
    try { doc = JSON.parse(text.replace(/^\uFEFF/, '')); } catch (e) { problems.push(`${name}: invalid JSON (${e.message})`); continue; }
    const docs = Array.isArray(doc) ? doc : [doc];
    for (const d of docs) {
      const errs = validateRule(d, { file: name });
      if (errs.length) problems.push(...errs);
      else rules.push({ ...d, _file: name });
    }
  }
  return { rules, problems, dir, present: true };
}

/**
 * Problems that only exist BETWEEN rules — the class `data_spec.rb` guards in the reference project,
 * where every cross-reference must point at something that exists. A dangling ref is a rule that
 * looks connected and is not.
 */
export function lintSet(rules) {
  const out = [];
  const byId = new Map();
  for (const r of rules) {
    if (byId.has(r.id)) out.push(`duplicate id "${r.id}" in ${byId.get(r.id)._file} and ${r._file}`);
    else byId.set(r.id, r);
  }
  for (const r of rules) {
    for (const ref of Array.isArray(r.refs) ? r.refs : []) {
      if (!byId.has(ref)) out.push(`${r._file}: "${r.id}" refers to "${ref}", which is not a rule here`);
    }
  }
  // Precedence must be TOTAL inside a family. Two rules at the same rank means the winner depends on
  // file order, and a decision that depends on file order is not a decision.
  const seen = new Map();
  for (const r of rules) {
    const k = `${r.family}#${r.rank}`;
    if (seen.has(k)) out.push(`rank ${r.rank} is used twice in family "${r.family}": "${seen.get(k)}" and "${r.id}" — precedence would depend on file order`);
    else seen.set(k, r.id);
  }
  return out;
}

// ---- evaluation ---------------------------------------------------------------------------

function signalValue(action, signal) {
  if (!action || typeof action !== 'object') return undefined;
  if (Object.prototype.hasOwnProperty.call(action, signal)) return action[signal];
  // dotted access for nested payloads, e.g. "tool_input.file_path"
  return signal.split('.').reduce((o, k) => (o && typeof o === 'object' ? o[k] : undefined), action);
}

function condHolds(c, action) {
  const raw = signalValue(action, c.signal);
  if (c.op === 'absent') return raw === undefined || raw === null || raw === '';
  if (raw === undefined || raw === null) return false;
  const v = String(raw);
  switch (c.op) {
    case 'eq': return v === c.value;
    case 'neq': return v !== c.value;
    case 'contains': return v.toLowerCase().includes(c.value.toLowerCase());
    case 'matches': return new RegExp(c.value, c.flags || 'i').test(v);
    case 'not_matches': return !new RegExp(c.value, c.flags || 'i').test(v);
    default: return false;
  }
}

/**
 * Does this rule apply to this action? ALL conditions must hold — `and`, never `or`.
 *
 * `or` was tempting and is wrong here: a rule whose conditions are alternatives is really two rules,
 * and writing it as one hides the second from `rules show`, from search, and from the reader.
 *
 * A rule with no conditions never matches an action. It is still findable and still readable; it
 * simply is not a gate, and `lint` refuses to let it call itself `warn` or `block`.
 */
export function ruleMatches(rule, action) {
  const cs = Array.isArray(rule.applies_when) ? rule.applies_when : [];
  if (!cs.length) return false;
  return cs.every((c) => condHolds(c, action));
}

/**
 * Evaluate an action against the whole rule set.
 *
 * The engine decides; the caller explains. Returns every rule that fired, most severe first, and the
 * single `decision` a gate should act on: 'block' | 'warn' | 'advice' | 'clear'.
 */
export function evaluate(rules, action) {
  const order = { block: 0, warn: 1, advice: 2 };
  const hits = rules
    .filter((r) => ruleMatches(r, action))
    .sort((a, b) => (order[a.enforcement] - order[b.enforcement]) || (a.family || '').localeCompare(b.family || '') || (a.rank - b.rank));
  const decision = hits.length ? hits[0].enforcement : 'clear';
  return { decision, hits };
}

/**
 * Run every example in every rule back through the engine.
 *
 * This is the piece that makes the rule set self-checking: an example carries the verdict its author
 * claimed, so a rule whose conditions do not actually produce that verdict is caught by the rule's
 * own documentation. An example with no `action` is prose for the reader and is skipped — it still
 * satisfies the "must name an allowed case" gate, it just cannot be executed.
 */
export function checkExamples(rules) {
  const out = [];
  for (const r of rules) {
    for (const [i, e] of (Array.isArray(r.examples) ? r.examples : []).entries()) {
      if (!e || !e.action) continue;
      const got = ruleMatches(r, e.action) ? 'violates' : 'complies';
      if (got !== e.verdict) {
        out.push(`${r._file}: "${r.id}" examples[${i}] claims ${e.verdict} but the rule's own conditions say ${got} — ${JSON.stringify(e.action)}`);
      }
    }
  }
  return out;
}

/**
 * The near-miss gate — the measurement in the audit turned into a requirement.
 *
 * `example` is the most repeated heading across 83 production system prompts by roughly 9x. But in
 * those prompts the examples are decoration: nothing checks them, and nothing requires them to sit
 * anywhere near the boundary. A `complies` example picked from far away proves nothing — it says
 * 'this rule does not forbid the sky', which no reader doubted.
 *
 * So: at least one allowed example must be a NEAR MISS — it must satisfy EVERY condition of the rule
 * except exactly one. That is the pair that draws the line, and authoring it is the cheapest way to
 * discover a rule is wrong, because a rule with no legitimate neighbour usually forbids the whole
 * territory around the thing it meant to forbid.
 *
 * WHAT THIS DOES NOT PROVE, stated plainly because the first version overstated it. The first version
 * asked only that the two examples share ONE signal — and since nearly every rule here starts with
 * `tool eq Bash`, almost anything qualified. Requiring "all conditions but one" is stricter and rules
 * out an example that satisfies nothing. But on a rule with exactly TWO conditions the two are the
 * same test, so `ls -la /tmp` still counts as the near miss of a rule about `DROP TABLE prod`.
 *
 * A machine cannot measure semantic distance. This check rules out the careless cases; a human reading
 * the rule is what makes the example genuinely near. The README says so too — a gate that is described
 * as sharper than it is, is worse than one described honestly.
 *
 * Force decides severity: `block` without a near miss is an ERROR (the more power a rule has, the
 * sharper its edge must be); `warn`/`advice` without one is a WARNING, not a wall.
 */
export function nearMissReport(rules) {
  const errors = [];
  const warnings = [];
  for (const r of rules) {
    const ex = (Array.isArray(r.examples) ? r.examples : []).filter((e) => e && e.action);
    const bad = ex.filter((e) => e.verdict === 'violates');
    const good = ex.filter((e) => e.verdict === 'complies');
    // Nothing executable to compare: the prose-only case, already covered by the examples gate.
    if (!bad.length || !good.length) continue;
    const cs = Array.isArray(r.applies_when) ? r.applies_when : [];
    if (!cs.length) continue;
    // "Almost violates" = fails exactly one condition. Failing none would be a violation; failing
    // several is a different action altogether, not a neighbour.
    const near = good.some((g) => cs.filter((c) => !condHolds(c, g.action)).length === 1);
    const msg = `${r._file}: "${r.id}" has no NEAR MISS — every allowed example fails ${cs.length > 1 ? 'more than one of' : ''} the rule's ${cs.length} condition(s), so none of them sits next to the line`;
    if (near) continue;
    (r.enforcement === 'block' ? errors : warnings).push(msg);
  }
  return { errors, warnings };
}

/**
 * Conditions must not reach past what the examples demonstrate.
 *
 * Measured gap this closes: `if … then` appears 34 times in 1.8M characters of real prompts, so
 * almost every rule out there is an unconditional imperative. Unconditional is easy to write and
 * impossible to check. Here a condition that no forbidden example exercises is a condition nobody
 * has ever seen fire — it will fire for the first time on a real action, which is the worst place
 * to find out it was wrong.
 */
export function unexercisedConditions(rules) {
  const out = [];
  for (const r of rules) {
    const cs = Array.isArray(r.applies_when) ? r.applies_when : [];
    const bad = (Array.isArray(r.examples) ? r.examples : []).filter((e) => e && e.action && e.verdict === 'violates');
    if (!cs.length || !bad.length) continue;
    cs.forEach((c, i) => {
      if (!bad.some((e) => condHolds(c, e.action))) {
        out.push(`${r._file}: "${r.id}" applies_when[${i}] (${c.signal} ${c.op}) is never exercised by any \`violates\` example — an untested condition fires for the first time on a real action`);
      }
    });
  }
  return out;
}

// ---- lookup -------------------------------------------------------------------------------

/**
 * Offline, deterministic search. Word overlap plus character 3-grams, so a Vietnamese query finds a
 * Vietnamese rule and a partial English word still lands. Modelled on the reference project's index
 * (TF-IDF + n-grams, cosine in [0,1]) but kept small: there is no server here and no corpus to speak
 * of, and a search that needs a build step is a search nobody runs.
 */
function terms(s) {
  const t = String(s || '').toLowerCase();
  const words = t.split(/[^\p{L}\p{N}_]+/u).filter((w) => w.length > 1);
  const grams = [];
  for (const w of words) for (let i = 0; i + 3 <= w.length; i++) grams.push('~' + w.slice(i, i + 3));
  return [...words, ...grams];
}

function docText(r) {
  const bits = [r.id, r.family, r.modality, r.source];
  for (const f of ['title', 'statement', 'why']) {
    if (r[f]) bits.push(r[f].vi, r[f].en);
  }
  for (const e of Array.isArray(r.examples) ? r.examples : []) {
    if (e && e.text) bits.push(e.text.vi, e.text.en);
  }
  for (const c of Array.isArray(r.applies_when) ? r.applies_when : []) {
    if (c) bits.push(c.signal, c.value);
  }
  for (const t of Array.isArray(r.tags) ? r.tags : []) bits.push(t);
  return bits.filter(Boolean).join(' ');
}

export function searchRules(rules, query, { limit = 10 } = {}) {
  const q = terms(query);
  if (!q.length) return [];
  const df = new Map();
  const docs = rules.map((r) => {
    const set = new Set(terms(docText(r)));
    for (const t of set) df.set(t, (df.get(t) || 0) + 1);
    return { rule: r, set };
  });
  const n = docs.length || 1;
  const scored = docs.map(({ rule, set }) => {
    let score = 0;
    for (const t of new Set(q)) {
      if (!set.has(t)) continue;
      // rarer term, stronger signal; a whole word counts for more than a fragment of one
      score += Math.log(1 + n / (1 + (df.get(t) || 0))) * (t.startsWith('~') ? 1 : 3);
    }
    return { rule, score };
  });
  return scored
    .filter((s) => s.score > 0)
    // id is the tiebreak so two runs of the same query can never disagree
    .sort((a, b) => b.score - a.score || a.rule.id.localeCompare(b.rule.id))
    .slice(0, limit);
}
