// kiai flight record — append-only, hash-chained evidence of what an AI coding agent did.
// Zero dependencies. Node >= 18. No shebang anywhere in this package (Windows CRLF + shebang
// breaks `import`; always run through `node <file>`).
//
// Chain:   hash_n = sha256(hash_{n-1} + "\n" + canonical(record_n without `hash`))
//          hash_0 = sha256("kiai-flight-v1")
// Writers: one chain per WRITER = one machine × one working tree (id = <host>-<6 hex of
//          sha256(host + realpath(root))>, override with KIAI_WRITER). Two clones or two git
//          worktrees therefore never append to the same file, so `git pull` never conflicts and
//          never breaks a chain. Concurrent sessions in ONE working tree share a writer and are
//          serialized by the lock.
// Storage: <root>/.kiai/flight/<writer>/YYYY-MM-DD.jsonl   one JSON object per line (UTC date)
//          <root>/.kiai/flight/<writer>/chain.json         local pointer { seq, last } (git-ignored)
//          <root>/.kiai/flight/<writer>/dropped.jsonl      records that could NOT be sealed (lock busy)
//          <root>/.kiai/flight/<writer>/.lock/             mkdir lock (cross-process, cross-platform)
//          <root>/.kiai/flight/errors.log                  hook failures (the hook never fails the agent)
//          <root>/.kiai/anchors.jsonl                      ANCHORS: committed witnesses of chain heads (UOW-123)
// Truth:   the .jsonl files are the chain. chain.json is a local WITNESS of the last head this
//          machine wrote: `verify` compares files against it and reports a truncated or rewritten
//          tail; `append` continues from the files and records the disagreement as an `anomaly`
//          field inside the next record, so the disagreement itself becomes part of the chain.
// Anchors: chain.json only lives on the machine that wrote it, so a clone cannot tell that the TAIL
//          was cut. `kiai anchor` appends a line to .kiai/anchors.jsonl — writer counts plus the head
//          at that count — and that file is COMMITTED. `verify` then checks every chain against every
//          anchor: fewer records than an anchor, or a different hash at that seq, is BROKEN. An anchor
//          is only as strong as the git history it sits in: it proves nothing until it is committed
//          and pushed, and records written AFTER the last anchor are still tail-cuttable elsewhere.

import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const FLIGHT_VERSION = 1;
export const GENESIS = sha256('kiai-flight-v1');
export const FLIGHT_DIR = path.join('.kiai', 'flight');
const DAY_FILE = /^\d{4}-\d{2}-\d{2}\.jsonl$/;

export function sha256(text) {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

/** Deterministic JSON: object keys sorted recursively, no whitespace. Non-enumerable props are ignored. */
export function canonical(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']';
  const keys = Object.keys(value).sort();
  return '{' + keys.map((k) => JSON.stringify(k) + ':' + canonical(value[k])).join(',') + '}';
}

export function recordHash(prev, record) {
  const { hash: _omit, ...rest } = record;
  return sha256(prev + '\n' + canonical(rest));
}

// ---- redaction -------------------------------------------------------------------------
// Best-effort, regex based. It cannot be complete: do not paste secrets into shell commands, and
// review .kiai/flight before pushing. Each pattern either replaces the whole match or keeps a
// captured prefix (group 1) and replaces the rest.

const KEYWORD = '(?:password|passwd|pwd|secret|token|api[_-]?key|access[_-]?key|private[_-]?key|client[_-]?secret|auth[_-]?token|account[_-]?key)';

const REDACT_PATTERNS = [
  // vendor-prefixed credentials (whole match)
  /sk-[A-Za-z0-9_-]{8,}/g,                                   // OpenAI / OpenRouter / Anthropic-style keys
  /sk_(?:live|test)_[A-Za-z0-9]{8,}/g,                       // Stripe
  /AKIA[0-9A-Z]{16}/g,                                       // AWS access key id
  /gh[pousr]_[A-Za-z0-9]{20,}/g,                             // GitHub classic tokens
  /github_pat_[A-Za-z0-9_]{20,}/g,                           // GitHub fine-grained tokens
  /glpat-[A-Za-z0-9_-]{16,}/g,                               // GitLab
  /xox[baprs]-[A-Za-z0-9-]{10,}/g,                           // Slack tokens
  /https:\/\/hooks\.slack\.com\/services\/[A-Za-z0-9/_-]+/g, // Slack webhooks
  /AIza[0-9A-Za-z_-]{30,}/g,                                 // Google API keys
  /hf_[A-Za-z0-9]{20,}/g,                                    // Hugging Face
  /npm_[A-Za-z0-9]{20,}/g,                                   // npm
  /SG\.[A-Za-z0-9_-]{16,}\.[A-Za-z0-9_-]{16,}/g,             // SendGrid
  /\bSK[0-9a-f]{32}\b/g,                                     // Twilio API key
  /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,
  // schemes with a captured prefix
  /(Bearer\s+)[A-Za-z0-9._~+/=-]{6,}/gi,                     // Authorization: Bearer <token>
  /(Basic\s+)[A-Za-z0-9+/=]{12,}/g,                          // Authorization: Basic <base64>
  /([a-z][a-z0-9+.-]*:\/\/[^/\s:@]+:)[^@\s/]+@/gi,            // scheme://user:PASS@host
  /(\s(?:-u|--user|--username)\s+[^\s:]+:)\S+/g,             // curl -u user:PASS
  /(\s(?:-p|--password|--passwd|--pass)\s+)(?!\d{2,5}(?::\d{2,5})?(?:\s|$))[^\s"']+/g, // mysql -p PASS (not ports)
  /(\s(?:-p|--password|--passwd|--pass)\s*=\s*)[^\s"']+/g,
  // KEY=value / "key": "value" for any name containing a credential keyword
  new RegExp(`([A-Za-z0-9_.-]*${KEYWORD}[A-Za-z0-9_.-]*["']?\\s*[=:]\\s*["']?)[^\\s"'&,;]+`, 'gi'),
];

export function redact(text) {
  if (typeof text !== 'string') return text;
  let out = text;
  for (const re of REDACT_PATTERNS) {
    out = out.replace(re, (m, prefix) => (typeof prefix === 'string' && m.startsWith(prefix) ? prefix + '[REDACTED]' : '[REDACTED]'));
  }
  return out;
}

export function redactDeep(value, depth = 0) {
  if (depth > 6) return '[DEPTH]';
  if (typeof value === 'string') return redact(value);
  if (Array.isArray(value)) return value.slice(0, 50).map((v) => redactDeep(v, depth + 1));
  if (value && typeof value === 'object') {
    const out = {};
    for (const k of Object.keys(value).slice(0, 50)) out[k] = redactDeep(value[k], depth + 1);
    return out;
  }
  return value;
}

// ---- tool input summary: references + hashes, never file contents ------------------------

const MAX_CMD = 2000;
const str = (v, max = 1000) => (v == null ? null : redact(String(v)).slice(0, max));

export function summarizeTool(toolName, input) {
  const t = String(toolName || '');
  const inp = input && typeof input === 'object' ? input : {};
  if (/^(Edit|Write|MultiEdit|NotebookEdit)$/.test(t)) {
    const file = inp.file_path ?? inp.notebook_path ?? null;
    const content = inp.content ?? inp.new_string ?? inp.new_source ?? null;
    const summary = { file: str(file) };
    if (typeof content === 'string') {
      summary.content_sha256 = sha256(content);
      summary.content_bytes = Buffer.byteLength(content, 'utf8');
    }
    if (Array.isArray(inp.edits)) summary.edits = inp.edits.length;
    return summary;
  }
  if (t === 'Bash' || t === 'PowerShell') {
    return {
      command: redact(String(inp.command ?? '')).slice(0, MAX_CMD),
      description: str(inp.description, 300),
    };
  }
  if (/^(Read|Glob|Grep|LS)$/.test(t)) {
    return { file: str(inp.file_path), pattern: str(inp.pattern, 300), path: str(inp.path) };
  }
  return { keys: Object.keys(inp).slice(0, 30) };
}

export function summarizeResponse(toolResponse) {
  if (toolResponse == null) return null;
  const text = typeof toolResponse === 'string' ? toolResponse : canonical(redactDeep(toolResponse));
  const out = { bytes: Buffer.byteLength(text, 'utf8') };
  if (toolResponse && typeof toolResponse === 'object') {
    // Observed on Claude Code 2.1.260 (probe 2026-09-04): Bash responses carry {stdout, stderr, interrupted, ...};
    // file tools carry {success} or {error}. Unknown shapes leave `ok` undefined rather than guessing.
    if ('success' in toolResponse) out.ok = Boolean(toolResponse.success);
    else if ('interrupted' in toolResponse) out.ok = !toolResponse.interrupted;
    if ('error' in toolResponse && toolResponse.error) out.ok = false;
    if (toolResponse.interrupted === true) out.ok = false;
  }
  return out;
}

// ---- context: uow id, git delta --------------------------------------------------------

function git(cwd, args) {
  try {
    // '' khi lệnh chạy được nhưng không in gì (vd `check-ignore -q` khớp) — khác hẳn null (lệnh thất bại).
    return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 5000 }).trim();
  } catch {
    return null;
  }
}

export function detectUow(cwd, env = process.env) {
  if (env.KIAI_UOW && /^UOW-\d{3,}$/.test(env.KIAI_UOW)) return env.KIAI_UOW;
  try {
    const cur = fs.readFileSync(path.join(cwd, '.kiai', 'current'), 'utf8').trim();
    if (/^UOW-\d{3,}$/.test(cur)) return cur;
  } catch { /* no current file */ }
  const branch = git(cwd, ['symbolic-ref', '--short', 'HEAD']);
  const m = branch && branch.match(/(UOW-\d{3,})/);
  return m ? m[1] : null;
}

export function gitDelta(cwd) {
  if (git(cwd, ['rev-parse', '--is-inside-work-tree']) !== 'true') return null;
  const head = git(cwd, ['rev-parse', '--short', 'HEAD']); // null on a repo with no commits yet
  const stat = git(cwd, ['diff', '--shortstat']) ?? '';
  const porcelain = git(cwd, ['status', '--porcelain']) ?? '';
  const num = (re) => { const m = stat.match(re); return m ? Number(m[1]) : 0; };
  return {
    head,
    branch: git(cwd, ['symbolic-ref', '--short', 'HEAD']),
    files_changed: num(/(\d+) files? changed/),
    insertions: num(/(\d+) insertions?/),
    deletions: num(/(\d+) deletions?/),
    dirty_paths: porcelain ? porcelain.split(/\r?\n/).filter(Boolean).length : 0,
  };
}

// ---- writers ---------------------------------------------------------------------------

export function flightDir(root) {
  return path.join(root, FLIGHT_DIR);
}

/** Writer id for this machine × working tree. Stable across sessions, different across clones. */
export function writerId(root, env = process.env) {
  if (env.KIAI_WRITER && /^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/.test(env.KIAI_WRITER)) return env.KIAI_WRITER;
  const host = os.hostname() || 'host';
  let real = path.resolve(root);
  try { real = fs.realpathSync.native(real); } catch { /* keep resolved */ }
  const slug = host.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 16) || 'host';
  return `${slug}-${sha256(host + '\n' + real.replace(/\\/g, '/').toLowerCase()).slice(0, 6)}`;
}

export function writerDir(root, env = process.env) {
  return path.join(flightDir(root), writerId(root, env));
}

/** All chains under .kiai/flight: one per writer sub-directory, plus the flat legacy layout if present. */
export function listWriters(root) {
  const dir = flightDir(root);
  if (!fs.existsSync(dir)) return [];
  const out = [];
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  if (entries.some((e) => e.isFile() && DAY_FILE.test(e.name))) out.push({ id: '', dir });
  for (const e of entries) {
    if (e.isDirectory() && !e.name.startsWith('.')) out.push({ id: e.name, dir: path.join(dir, e.name) });
  }
  return out;
}

export function initFlight(root, env = process.env) {
  const dir = writerDir(root, env);
  fs.mkdirSync(dir, { recursive: true });
  const cfg = path.join(root, '.kiai', 'config.json');
  let created = false;
  if (!fs.existsSync(cfg)) {
    fs.writeFileSync(cfg, JSON.stringify({ version: FLIGHT_VERSION, created: new Date().toISOString(), agent: 'claude-code' }, null, 2) + '\n');
    created = true;
  }
  const ignore = path.join(root, '.kiai', '.gitignore');
  // anchors.jsonl is deliberately NOT ignored (UOW-123): the committed anchor is the witness a clone has.
  const wanted = 'flight/errors.log\nflight/chain.json\nflight/.lock/\nflight/*/chain.json\nflight/*/.lock/\n';
  if (!fs.existsSync(ignore) || fs.readFileSync(ignore, 'utf8') !== wanted) fs.writeFileSync(ignore, wanted);
  return { dir, created, writer: path.basename(dir) };
}

// ---- lock ------------------------------------------------------------------------------

const LOCK_WAIT_MS = 20;
const LOCK_STALE_MS = 5_000;
/** Total time to wait for the lock. Hooks time out at 10 s, so stay under it. Tests lower it. */
const LOCK_BUDGET_MS = Number(process.env.KIAI_LOCK_BUDGET_MS) > 0 ? Number(process.env.KIAI_LOCK_BUDGET_MS) : 8_000;

function sleepSync(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

export function withLock(dir, fn, budgetMs = LOCK_BUDGET_MS) {
  const lock = path.join(dir, '.lock');
  const deadline = Date.now() + budgetMs;
  for (;;) {
    try {
      fs.mkdirSync(lock);
      try { return fn(); } finally { try { fs.rmdirSync(lock); } catch { /* already gone */ } }
    } catch (err) {
      if (err.code !== 'EEXIST') throw err;
      try {
        const age = Date.now() - fs.statSync(lock).mtimeMs;
        if (age > LOCK_STALE_MS) { fs.rmdirSync(lock); continue; }
      } catch { /* lock vanished between checks */ }
      if (Date.now() >= deadline) { const e = new Error('flight lock busy: ' + lock); e.code = 'KIAI_LOCK_BUSY'; throw e; }
      sleepSync(LOCK_WAIT_MS);
    }
  }
}

// ---- storage ---------------------------------------------------------------------------

function readPointer(dir) {
  try {
    const c = JSON.parse(fs.readFileSync(path.join(dir, 'chain.json'), 'utf8'));
    if (Number.isInteger(c.seq) && c.seq >= 0 && typeof c.last === 'string') return c;
  } catch { /* missing or corrupt */ }
  return null;
}

function writePointer(dir, chain) {
  const tmp = path.join(dir, `chain.${process.pid}.tmp`);
  fs.writeFileSync(tmp, JSON.stringify(chain));
  fs.renameSync(tmp, path.join(dir, 'chain.json'));
}

function hidden(obj, key, value) {
  Object.defineProperty(obj, key, { value, enumerable: false, writable: true, configurable: true });
  return obj;
}

/** Records of ONE writer directory, ordered by seq. Malformed lines become { seq: null } with hidden _bad/_file. */
export function readWriter(dir, id = path.basename(dir)) {
  if (!fs.existsSync(dir)) return [];
  const files = fs.readdirSync(dir).filter((f) => DAY_FILE.test(f)).sort();
  const out = [];
  for (const f of files) {
    const lines = fs.readFileSync(path.join(dir, f), 'utf8').split(/\r?\n/);
    for (const line of lines) {
      if (!line.trim()) continue;
      let rec;
      try { rec = JSON.parse(line); } catch { rec = hidden({ seq: null }, '_bad', line.slice(0, 200)); }
      if (!rec || typeof rec !== 'object' || Array.isArray(rec)) rec = hidden({ seq: null }, '_bad', line.slice(0, 200));
      hidden(rec, '_file', f); hidden(rec, '_writer', id);
      out.push(rec);
    }
  }
  return out.sort((a, b) => (Number.isInteger(a.seq) ? a.seq : Infinity) - (Number.isInteger(b.seq) ? b.seq : Infinity));
}

/** All records of all writers: each chain in seq order, chains in writer-id order. */
export function readAll(root) {
  const all = [];
  for (const w of listWriters(root).sort((a, b) => a.id.localeCompare(b.id))) all.push(...readWriter(w.dir, w.id));
  return all;
}

export function readDropped(root) {
  const out = [];
  for (const w of listWriters(root)) {
    const f = path.join(w.dir, 'dropped.jsonl');
    if (!fs.existsSync(f)) continue;
    for (const line of fs.readFileSync(f, 'utf8').split(/\r?\n/)) {
      if (!line.trim()) continue;
      try { out.push(hidden(JSON.parse(line), '_writer', w.id)); } catch { out.push(hidden({ ts: null }, '_writer', w.id)); }
    }
  }
  return out;
}

/**
 * Append one record under the writer's lock. Returns the sealed record (with writer/seq/prev/hash).
 * If the lock cannot be taken within budget, the unsealed record is written to dropped.jsonl and the
 * error is rethrown, so the gap is on disk even though the chain does not contain it.
 */
export function appendRecord(root, partial, { env = process.env } = {}) {
  const dir = writerDir(root, env);
  fs.mkdirSync(dir, { recursive: true });
  try {
    return withLock(dir, () => {
      const records = readWriter(dir);
      const tail = records.length ? records[records.length - 1] : null;
      const base = tail && Number.isInteger(tail.seq) && typeof tail.hash === 'string' ? { seq: tail.seq, last: tail.hash } : { seq: 0, last: GENESIS };
      const pointer = readPointer(dir);
      const record = { v: FLIGHT_VERSION, writer: path.basename(dir), ...partial, seq: base.seq + 1, prev: base.last };
      if (pointer && (pointer.seq !== base.seq || pointer.last !== base.last)) {
        // The files and the local witness disagree (tail truncated/rewritten, or files replaced from git).
        // Continue from the files, but seal the disagreement into the chain.
        record.anomaly = { kind: 'pointer_mismatch', pointer_seq: pointer.seq, pointer_last: pointer.last, files_seq: base.seq, files_last: base.last };
      }
      record.hash = recordHash(base.last, record);
      const day = (typeof record.ts === 'string' ? record.ts : new Date().toISOString()).slice(0, 10);
      fs.appendFileSync(path.join(dir, `${day}.jsonl`), JSON.stringify(record) + '\n');
      writePointer(dir, { seq: record.seq, last: record.hash });
      return record;
    });
  } catch (err) {
    if (err && err.code === 'KIAI_LOCK_BUSY') {
      try {
        fs.appendFileSync(path.join(dir, 'dropped.jsonl'), JSON.stringify({ v: FLIGHT_VERSION, writer: path.basename(dir), ...partial, dropped: 'lock busy', dropped_at: new Date().toISOString() }) + '\n');
      } catch { /* nothing else to do */ }
    }
    throw err;
  }
}

/** Verify one writer's chain against its files and (if present) its local pointer. */
export function verifyWriter(dir, id = path.basename(dir)) {
  const records = readWriter(dir, id);
  const res = { writer: id, count: records.length, ok: true, broken: null, reason: null, last: GENESIS, anomalies: 0, pointer: readPointer(dir) };
  let prev = GENESIS;
  let expectSeq = 1;
  const fail = (broken, reason) => Object.assign(res, { ok: false, broken, reason });
  for (const r of records) {
    if (!Number.isInteger(r.seq)) return fail(null, `unparseable or seq-less line in ${r._file}${r._bad ? ' (' + r._bad.slice(0, 60) + '…)' : ''}`);
    if (r.seq !== expectSeq) return fail(r.seq, `expected seq ${expectSeq}, found ${r.seq} (missing or reordered record)`);
    if (r.prev !== prev) return fail(r.seq, 'prev hash does not match previous record');
    if (recordHash(prev, r) !== r.hash) return fail(r.seq, 'record content does not match its hash (tampered)');
    if (r.anomaly) res.anomalies++;
    prev = r.hash;
    expectSeq++;
  }
  res.last = prev;
  if (res.pointer) {
    if (res.pointer.seq > res.count) return fail(res.count, `tail truncated: this machine last wrote seq ${res.pointer.seq} (head ${res.pointer.last.slice(0, 16)}…), files end at seq ${res.count}`);
    if (res.pointer.seq === res.count && res.pointer.last !== prev) return fail(res.count, `tail rewritten: this machine last wrote head ${res.pointer.last.slice(0, 16)}…, files end with ${prev.slice(0, 16)}…`);
    // pointer.seq < count: files are ahead of the local witness (e.g. pulled from git) — not an error.
  }
  return res;
}

/** Verify every chain under .kiai/flight. { ok, count, chains, dropped, anomalies, last, broken, reason } */
export function verifyChain(root) {
  const chains = listWriters(root).map((w) => verifyWriter(w.dir, w.id));
  const bad = chains.find((c) => !c.ok);
  const count = chains.reduce((a, c) => a + c.count, 0);
  const anomalies = chains.reduce((a, c) => a + c.anomalies, 0);
  const dropped = readDropped(root).length;
  const heads = chains.map((c) => c.last);
  const last = heads.length === 1 ? heads[0] : sha256(heads.sort().join('\n'));
  const out = {
    ok: !bad,
    count,
    chains,
    dropped,
    anomalies,
    last,
    broken: bad ? bad.broken : null,
    reason: bad ? (chains.length > 1 || bad.writer ? `${bad.writer || 'legacy'}: ${bad.reason}` : bad.reason) : null,
  };
  // UOW-123: a chain that is internally consistent can still be a TRUNCATED copy — chain.json does not
  // travel. Committed anchors are the witness a clone has, so they are checked last and can turn an
  // otherwise-OK chain into BROKEN. A chain already broken keeps its own (earlier) reason.
  const anchors = checkAnchors(root, chains);
  out.anchors = {
    ok: anchors.ok, used: anchors.used, bad: anchors.bad, total: anchors.total, reason: anchors.reason,
    latest: anchors.latest ? { ts: anchors.latest.ts, by: anchors.latest.by, records: anchors.latest.records, all_last: anchors.latest.all_last, git: anchors.latest.git } : null,
  };
  if (out.ok && !anchors.ok) Object.assign(out, { ok: false, broken: anchors.broken, reason: anchors.reason });
  return out;
}

// ---- building records from Claude Code hook payloads ------------------------------------

const EVENT_MAP = {
  SessionStart: 'session_start',
  PreToolUse: 'tool_call',
  PostToolUse: 'tool_result',
  PostToolUseFailure: 'tool_result',
  Stop: 'stop',
  SubagentStop: 'subagent_stop',
  SessionEnd: 'session_end',
  UserPromptSubmit: 'prompt',
};

/** Make a file path root-relative (posix separators) when it lies inside root; otherwise keep it and flag it. */
export function relativizePath(root, file) {
  if (typeof file !== 'string' || !file || !root) return { file, outside: false };
  if (!path.isAbsolute(file)) return { file: file.replace(/\\/g, '/'), outside: false };
  const rel = path.relative(path.resolve(root), path.resolve(file));
  if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) return { file, outside: true };
  return { file: rel.replace(/\\/g, '/'), outside: false };
}

export function buildRecord(payload, { event, cwd, root = null, now = new Date(), env = process.env, agent = 'claude-code' } = {}) {
  const p = payload && typeof payload === 'object' && !Array.isArray(payload) ? payload : {};
  const hookEvent = p.hook_event_name || event || 'unknown';
  const kind = EVENT_MAP[hookEvent] || String(hookEvent).toLowerCase().slice(0, 40);
  const workdir = cwd || p.cwd || process.cwd();
  const rec = {
    ts: now.toISOString(),
    event: kind,
    agent,
    session: p.session_id == null ? null : String(p.session_id).slice(0, 120),
    cwd: workdir,
    uow: detectUow(workdir, env),
  };
  if (kind === 'tool_call' || kind === 'tool_result') {
    rec.tool = p.tool_name == null ? null : String(p.tool_name).slice(0, 80);
    rec.tool_use_id = p.tool_use_id == null ? null : String(p.tool_use_id).slice(0, 120);
    rec.input = summarizeTool(p.tool_name, p.tool_input);
    // File paths are stored relative to the repo root so the record stays true after a clone or a move
    // (review 120 P1). A write outside the repo keeps its absolute path and is flagged.
    if (rec.input && typeof rec.input.file === 'string') {
      const r = relativizePath(root || workdir, rec.input.file);
      rec.input.file = r.file;
      if (r.outside) rec.input.outside_repo = true;
    }
    if (kind === 'tool_result') {
      rec.result = summarizeResponse(p.tool_response ?? p.error ?? null);
      if (hookEvent === 'PostToolUseFailure') rec.result = { ...(rec.result || {}), ok: false };
    }
  }
  if (kind === 'session_start') rec.source = p.source == null ? null : String(p.source).slice(0, 40);
  if (kind === 'session_end') rec.reason = p.reason == null ? null : String(p.reason).slice(0, 40);
  if (kind === 'prompt') rec.prompt_sha256 = typeof p.prompt === 'string' ? sha256(p.prompt) : null;
  if (kind === 'stop' || kind === 'session_end' || kind === 'subagent_stop') rec.git = gitDelta(workdir);
  return rec;
}

export function noteRecord(text, { cwd, now = new Date(), env = process.env, by = null } = {}) {
  const workdir = cwd || process.cwd();
  return {
    ts: now.toISOString(), event: 'note', agent: redact(String(by || env.KIAI_ACTOR || 'human')).slice(0, 80),
    session: null, cwd: workdir, uow: detectUow(workdir, env), text: redact(String(text)).slice(0, 4000),
  };
}

export function logError(root, err) {
  try {
    const dir = flightDir(root);
    fs.mkdirSync(dir, { recursive: true });
    fs.appendFileSync(path.join(dir, 'errors.log'), `${new Date().toISOString()} ${err && err.stack ? err.stack : String(err)}\n`);
  } catch { /* nothing else to do */ }
}

// ---- report ----------------------------------------------------------------------------

export function filterRecords(records, { uow, session, since } = {}) {
  let sinceTs = null;
  if (since) {
    sinceTs = new Date(since).getTime();
    if (Number.isNaN(sinceTs)) throw new Error(`--since: cannot parse date "${since}" (use YYYY-MM-DD or an ISO timestamp)`);
  }
  return records.filter((r) =>
    Number.isInteger(r.seq) &&
    (!uow || r.uow === uow) &&
    (!session || r.session === session) &&
    (!sinceTs || new Date(r.ts).getTime() >= sinceTs));
}

/**
 * Every file write a record describes, in one shape.
 *   Claude Code hooks  → input.file + input.content_sha256 (one file per record)
 *   Codex import (124) → input.files[] (a patch can touch several); `add` carries the whole new file,
 *                        `update` carries only a unified diff and `delete` carries nothing, so only
 *                        `add` gets kind "write" — the others must never be compared against disk as
 *                        if the recorded hash were the full file.
 */
export function recordFiles(r) {
  const out = [];
  const inp = r && r.input;
  if (!inp || typeof inp !== 'object') return out;
  if (typeof inp.file === 'string' && inp.content_sha256) {
    out.push({ file: inp.file, sha256: inp.content_sha256, bytes: inp.content_bytes ?? null, kind: String(r.tool) === 'Write' ? 'write' : 'edit', outside: inp.outside_repo === true });
  }
  if (Array.isArray(inp.files)) {
    for (const f of inp.files.slice(0, 100)) {
      if (!f || typeof f.file !== 'string') continue;
      // An update or a delete carries no full-file hash — but the file was still touched, and a packet
      // that stayed silent about it would be worse than one that says "edit-only".
      const kind = f.change === 'add' ? 'write' : f.change === 'delete' ? 'delete' : 'edit';
      out.push({ file: f.file, sha256: typeof f.content_sha256 === 'string' ? f.content_sha256 : null, bytes: f.content_bytes ?? null, kind, outside: f.outside_repo === true });
    }
  }
  return out;
}

export function summarize(records) {
  const sessions = new Map();
  for (const r of records) {
    const key = r.session ?? (r.event === 'note' || r.event === 'decision' ? 'notes' : 'unknown');
    if (!sessions.has(key)) sessions.set(key, { session: key, first: r.ts, last: r.ts, uows: new Set(), writers: new Set(), tools: {}, files: new Map(), commands: [], git: null, notes: [], failures: 0, anomalies: 0, records: 0 });
    const s = sessions.get(key);
    s.records++;
    if (typeof r.ts === 'string') {
      if (typeof s.first !== 'string' || r.ts < s.first) s.first = r.ts;
      if (typeof s.last !== 'string' || r.ts > s.last) s.last = r.ts;
    }
    if (r.uow) s.uows.add(r.uow);
    if (r.writer || r._writer) s.writers.add(r.writer || r._writer);
    if (r.anomaly) s.anomalies++;
    if (r.event === 'tool_call' && r.tool) {
      s.tools[r.tool] = (s.tools[r.tool] || 0) + 1;
      if (r.input && r.input.command) s.commands.push(r.input.command);
    }
    // Writes can arrive on a tool_call (Claude hooks) or on a tool_result (Codex import: the runtime
    // reports what it actually changed). A Claude tool_result only echoes its call's input, so it is
    // skipped — otherwise the same write would be counted from both records.
    if (r.event !== 'tool_result' || r.via === 'import') for (const f of recordFiles(r)) s.files.set(f.file, f.sha256);
    if (r.event === 'tool_result' && r.result && r.result.ok === false) s.failures++;
    if ((r.event === 'stop' || r.event === 'session_end') && r.git) s.git = r.git;
    if (r.event === 'note') s.notes.push({ ts: r.ts, by: r.agent, text: r.text });
    if (r.event === 'decision') s.notes.push({ ts: r.ts, by: r.by ?? r.agent, text: `DECISION ${String(r.decision || '').toUpperCase()} on ${r.uow ?? '?'} — packet ${String(r.packet_sha256 || '').slice(0, 16)}…${r.note ? ': ' + r.note : ''}` });
  }
  return [...sessions.values()].map((s) => ({ ...s, uows: [...s.uows], writers: [...s.writers], files: [...s.files.entries()].map(([file, sha256]) => ({ file, sha256 })) }));
}

/** One Markdown table cell / inline value from an untrusted string: no newlines, no pipes, no backticks. */
export function cell(value, max = 200) {
  return String(value ?? '').replace(/[\r\n\t]+/g, ' ').replace(/\|/g, '\\|').replace(/`/g, "'").replace(/\*/g, '∗').slice(0, max);
}
/** Inline code from an untrusted string. */
const code = (value, max = 200) => '`' + cell(value, max) + '`';
/** Multi-line free text (notes): every line indented as a quoted continuation so it cannot open a heading/table. */
function quoted(text, max = 2000) {
  return String(text ?? '').slice(0, max).split(/\r?\n/).map((l) => l.replace(/^\s*([#>|*-]|\d+\.)/, '\\$1')).join('  \n    ');
}

export function renderMarkdown(root, records, verification, filters = {}) {
  const lines = [];
  const scope = [filters.uow && `UoW ${cell(filters.uow, 40)}`, filters.session && `session ${cell(filters.session, 40)}`, filters.since && `since ${cell(filters.since, 40)}`].filter(Boolean).join(' · ') || 'all records';
  lines.push(`# KIAI flight report — ${scope}`);
  lines.push('');
  lines.push(`- Generated: ${new Date().toISOString()}`);
  lines.push(`- Repository: ${code(root)}`);
  if (verification.ok) {
    const chains = verification.chains || [];
    const heads = chains.length > 1 ? ` in ${chains.length} chains (${chains.map((c) => `${cell(c.writer || 'legacy', 40)} ${c.count}`).join(', ')})` : '';
    lines.push(`- Chain: ✅ intact (${verification.count} records${heads}, head ${code(verification.last.slice(0, 16) + '…')})`);
  } else {
    lines.push(`- Chain: ❌ BROKEN at seq ${verification.broken ?? '?'} — ${cell(verification.reason, 300)}`);
  }
  if (verification.dropped) lines.push(`- ⚠ Dropped records: ${verification.dropped} (hook could not take the lock; see dropped.jsonl — the log is incomplete)`);
  if (verification.anomalies) lines.push(`- ⚠ Anomalies sealed in chain: ${verification.anomalies} (files and local pointer disagreed at append time)`);
  lines.push(`- Records in scope: ${records.length}`);
  const agents = [...new Set(records.map((r) => r.agent).filter((a) => typeof a === 'string' && a))].sort();
  if (agents.length) lines.push(`- Agents: ${agents.map((a) => code(a, 40)).join(', ')}`);
  // UOW-124: an imported record was derived from an agent's own log after the fact, not observed by a
  // hook while the agent acted. A reader must never mistake one for the other.
  const imported = records.filter((r) => r.via === 'import').length;
  if (imported) lines.push(`- ⚠ Imported records: ${imported} of ${records.length} — read back from an agent log after the fact (\`kiai import\`), not observed live by a hook; the chain proves only that nobody has changed them since the import`);
  lines.push('');
  const sessions = summarize(records);
  if (sessions.length === 0) { lines.push('_No records match._'); return lines.join('\n') + '\n'; }
  lines.push('| Session | UoW | Start (UTC) | End (UTC) | Tool calls | Failures | Files written |');
  lines.push('|---|---|---|---|---|---|---|');
  for (const s of sessions) {
    const calls = Object.values(s.tools).reduce((a, b) => a + b, 0);
    lines.push(`| ${code(String(s.session).slice(0, 12), 12)} | ${s.uows.map((u) => cell(u, 20)).join(', ') || '—'} | ${cell(s.first, 30)} | ${cell(s.last, 30)} | ${calls} | ${s.failures} | ${s.files.length} |`);
  }
  for (const s of sessions) {
    lines.push('');
    lines.push(`## Session ${code(s.session, 120)}`);
    const tools = Object.entries(s.tools).sort((a, b) => b[1] - a[1]).map(([k, v]) => `${cell(k, 40)} ×${v}`).join(', ');
    lines.push(`- Tools: ${tools || '—'}`);
    if (s.writers.length) lines.push(`- Writer: ${s.writers.map((w) => code(w, 60)).join(', ')}`);
    if (s.git) lines.push(`- Git at stop: ${code(s.git.branch ?? '?', 80)} @ ${code(s.git.head ?? 'no commits')} — ${Number(s.git.files_changed) || 0} files changed, +${Number(s.git.insertions) || 0} −${Number(s.git.deletions) || 0}, ${Number(s.git.dirty_paths) || 0} dirty paths`);
    if (s.anomalies) lines.push(`- ⚠ Anomalies in this session: ${s.anomalies}`);
    if (s.files.length) {
      lines.push('- Files written (path · sha256 of last written content):');
      for (const f of s.files) lines.push(`  - ${code(f.file, 300)} · ${code(String(f.sha256).slice(0, 16) + '…')}`);
    }
    if (s.commands.length) {
      lines.push(`- Shell commands (${s.commands.length}, first 20 shown):`);
      for (const c of s.commands.slice(0, 20)) lines.push('  - ' + code(String(c).split(/\r?\n/)[0], 160));
    }
    if (s.notes.length) {
      lines.push('- Notes:');
      for (const n of s.notes) lines.push(`  - ${cell(n.ts, 30)} **${cell(n.by, 80)}**: ${quoted(n.text)}`);
    }
  }
  return lines.join('\n') + '\n';
}

// ---- anchors (UOW-123) -------------------------------------------------------------------
// An anchor is a committed witness: "at <ts>, writer W had <count> records and the <count>-th record
// hashed to <last>". chain.json says the same but is git-ignored and machine-local, so only an anchor
// survives a clone. Anchors never gate writing; they only make `verify` stricter — and they are worth
// exactly as much as the git history they sit in.

export const ANCHORS_FILE = path.join('.kiai', 'anchors.jsonl');

export function anchorsFile(root) {
  return path.join(root, ANCHORS_FILE);
}

/** sha256 over every field of the anchor except `hash` — detects an edited anchor line. */
export function anchorHash(anchor) {
  const { hash: _omit, ...rest } = anchor;
  return sha256('kiai-anchor-v1\n' + canonical(rest));
}

/** Read anchors.jsonl. Each entry carries hidden _line (1-based) and _ok (hash matches). Never throws. */
export function readAnchors(root) {
  const file = anchorsFile(root);
  if (!fs.existsSync(file)) return [];
  let text = '';
  try { text = fs.readFileSync(file, 'utf8'); } catch { return []; }
  const out = [];
  let i = 0;
  for (const line of text.split(/\r?\n/)) {
    if (!line.trim()) continue;
    i++;
    let a;
    try { a = JSON.parse(line); } catch { out.push(hidden(hidden({ v: null }, '_line', i), '_ok', false)); continue; }
    if (!a || typeof a !== 'object' || Array.isArray(a)) { out.push(hidden(hidden({ v: null }, '_line', i), '_ok', false)); continue; }
    const ok = typeof a.hash === 'string' && Array.isArray(a.writers) && anchorHash(a) === a.hash;
    hidden(a, '_line', i); hidden(a, '_ok', ok);
    out.push(a);
  }
  return out;
}

/** Build (but do not write) an anchor for the current state of every chain. */
export function buildAnchor(root, { by = null, note = null, now = new Date() } = {}) {
  const v = verifyChain(root);
  const inTree = git(root, ['rev-parse', '--is-inside-work-tree']) === 'true';
  const anchor = {
    v: 1,
    ts: now.toISOString(),
    by: by ? String(by).slice(0, 80) : null,
    note: note ? String(note).slice(0, 500) : null,
    writers: v.chains.map((c) => ({ writer: c.writer || '', count: c.count, last: c.last })),
    records: v.count,
    all_last: v.last,
    git: {
      repo: inTree,                                        // false = not a git repository at all
      commit: inTree ? git(root, ['rev-parse', 'HEAD']) : null,   // null inside a repo = no commit yet
      branch: inTree ? git(root, ['symbolic-ref', '--short', 'HEAD']) : null,
      dirty: inTree ? Boolean(git(root, ['status', '--porcelain'])) : null,
    },
  };
  anchor.hash = anchorHash(anchor);
  return anchor;
}

/**
 * Is the anchors file itself in git, and does the committed copy match what is on disk?
 * This — not the commit recorded inside an anchor — is what decides whether an anchor is worth
 * anything to someone else: 'committed' | 'modified' | 'untracked' | 'no-commit' | 'no-git'.
 */
export function anchorsTracked(root) {
  if (git(root, ['rev-parse', '--is-inside-work-tree']) !== 'true') return 'no-git';
  const rel = ANCHORS_FILE.replace(/\\/g, '/');
  // .gitignore của repo (thường từ thời `.kiai/` bị ignore cả cụm) thắng mọi thứ khác: git add sẽ TỪ CHỐI,
  // nên đây phải là trạng thái riêng, không được lẫn vào 'untracked' (ứng viên seal x, đo 07/09).
  if (git(root, ['check-ignore', '-q', '--', rel]) !== null) return 'ignored';
  if (!git(root, ['rev-parse', 'HEAD'])) return 'no-commit';
  if (git(root, ['ls-files', '--error-unmatch', '--', rel]) === null) return 'untracked';
  const diff = git(root, ['diff', 'HEAD', '--name-only', '--', rel]);
  return diff ? 'modified' : 'committed';
}

/**
 * UOW-128. Does the COMMITTED copy of anchors.jsonl still match what is on disk?
 *
 * `anchorsTracked` answers "is this file in git", which is about whether an anchor can travel.
 * This answers a different and sharper question: **has the witness been removed?** Measured 17/09,
 * an agent that can write the working tree can cut the chain's tail, patch `chain.json` (two fields),
 * then `rm .kiai/anchors.jsonl` — and `verify` fell back to `NOT ANCHORED` and exit 0. The committed
 * copy was right there in git; nobody asked it.
 *
 * The file is append-only, so the working copy may have MORE lines than HEAD (anchors written since
 * the last commit) but never FEWER. Fewer, or gone entirely, means lines were removed.
 *
 * 'ok' | 'missing' | 'shortened' | 'rewritten' | 'unknown' — `unknown` (no git, no commit, never tracked) must never
 * be reported as a failure: "never anchored" and "the witness was just deleted" are different facts,
 * and calling the first one tampering is the false alarm that makes people stop reading the output.
 */
export function anchorsEvidence(root) {
  const rel = ANCHORS_FILE.replace(/\\/g, '/');
  const unknown = (reason) => ({ state: 'unknown', head: null, disk: null, reason });
  if (git(root, ['rev-parse', '--is-inside-work-tree']) !== 'true') return unknown('not a git repository');
  if (!git(root, ['rev-parse', 'HEAD'])) return unknown('no commit yet');
  if (git(root, ['ls-files', '--error-unmatch', '--', rel]) === null) return unknown('anchors.jsonl has never been committed');
  const committed = git(root, ['show', 'HEAD:' + rel]);
  // The file is tracked, so `git show` should succeed; when it does not (odd index state, unreadable
  // object) we do not get to assume the disk copy is fine, and we do not get to call it tampering.
  if (committed === null) return unknown('the committed copy of anchors.jsonl could not be read');
  const lines = (text) => text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  const hLines = lines(committed);
  const head = hLines.length;
  if (head === 0) return { state: 'ok', head: 0, disk: null, reason: null };
  let dLines = null;
  try {
    dLines = lines(fs.readFileSync(anchorsFile(root), 'utf8'));
  } catch {
    return { state: 'missing', head, disk: 0, reason: `.kiai/anchors.jsonl is committed in git with ${head} anchor(s) but is NOT in this working tree — the witness was deleted (or this tree is mid-checkout)` };
  }
  const disk = dLines.length;
  if (disk < head) {
    return { state: 'shortened', head, disk, reason: `.kiai/anchors.jsonl has ${disk} anchor(s) on disk but ${head} in the last commit — anchors are append-only, so ${head - disk} line(s) were removed` };
  }
  // Counting lines is not enough, and review round 1 of UOW-128 proved it by doing the obvious thing:
  // REPLACE an anchor line instead of deleting it, keeping the count identical. `anchorHash` is an
  // exported function of this very module, so an attacker who can write the tree can import it and
  // produce a line whose hash is perfectly valid — it just witnesses the SHORTER chain they just cut.
  // Append-only means the first `head` lines on disk must be byte-for-byte the committed ones.
  for (let i = 0; i < head; i++) {
    if (dLines[i] !== hLines[i]) {
      return { state: 'rewritten', head, disk, reason: `.kiai/anchors.jsonl line ${i + 1} is not the line in the last commit — anchors are append-only, so an existing witness was rewritten (a replaced anchor keeps the line count identical, which is why counting lines is not enough)` };
    }
  }
  return { state: 'ok', head, disk, reason: null };
}

/** Append one anchor line (append-only, like the chain itself). */
export function appendAnchor(root, anchor) {
  fs.mkdirSync(path.dirname(anchorsFile(root)), { recursive: true });
  fs.appendFileSync(anchorsFile(root), JSON.stringify(anchor) + '\n');
  return anchor;
}

/**
 * Compare the chains against every well-formed anchor.
 * { ok, broken, reason, used, bad, total, latest } — `bad` counts anchor lines ignored because their
 * hash does not match: an edited anchor must never be able to fake a BROKEN chain (AC-4).
 */
export function checkAnchors(root, chains) {
  const anchors = readAnchors(root);
  const res = { ok: true, broken: null, reason: null, used: 0, bad: 0, total: anchors.length, latest: null };
  const byId = new Map(chains.map((c) => [c.writer || '', c]));
  const writers = listWriters(root);
  const cache = new Map();
  const hashAt = (id, seq) => {
    if (!cache.has(id)) {
      const w = writers.find((x) => (x.id || '') === id);
      cache.set(id, w ? readWriter(w.dir, w.id) : null);
    }
    const records = cache.get(id);
    if (!records) return null;
    const r = records.find((x) => x.seq === seq);
    return r && typeof r.hash === 'string' ? r.hash : null;
  };
  for (const a of anchors) {
    if (!a._ok) { res.bad++; continue; }
    res.used++;
    if (!res.latest || String(a.ts) > String(res.latest.ts)) res.latest = a;
    if (!res.ok) continue; // first failure wins; keep counting anchors for the summary
    for (const w of a.writers) {
      if (!w || typeof w.writer !== 'string' || !Number.isInteger(w.count) || typeof w.last !== 'string') continue;
      if (w.count <= 0) continue; // 0 = chưa có record; âm = dòng hỏng — cả hai không chứng được gì (review N1)
      const id = w.writer;
      const chain = byId.get(id);
      if (!chain) {
        Object.assign(res, { ok: false, broken: null, reason: `writer ${id || 'legacy'} removed since anchor ${a.ts} (it had ${w.count} records)` });
        break;
      }
      if (chain.count < w.count) {
        Object.assign(res, { ok: false, broken: chain.count, reason: `tail truncated since anchor ${a.ts}: writer ${id || 'legacy'} had ${w.count} records (head ${w.last.slice(0, 16)}…), files end at seq ${chain.count} — records were cut, or this working tree is BEHIND the anchor (git checkout/revert/bisect to an older state); \`git log -p -- .kiai/anchors.jsonl\` tells the two apart` });
        break;
      }
      const at = hashAt(id, w.count);
      if (at !== w.last) {
        Object.assign(res, { ok: false, broken: w.count, reason: `rewritten since anchor ${a.ts}: writer ${id || 'legacy'} record seq ${w.count} hashes to ${String(at).slice(0, 16)}…, the anchor says ${w.last.slice(0, 16)}…` });
        break;
      }
    }
  }
  return res;
}
