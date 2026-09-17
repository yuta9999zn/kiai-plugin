// kiai import codex — build KIAI flight records from the session logs Codex CLI already writes.
//
// WHY AN IMPORTER AND NOT A HOOK
//   Codex CLI does have a hook engine (0.153.4 reports feature `hooks` = stable; the payload field
//   names mirror Claude Code's: session_id, cwd, hook_event_name, tool_name, tool_input, tool_use_id,
//   stop_hook_active, …). We could NOT get a hook to fire in three different configurations
//   (`-c hooks.<Event>=[…]`, `.codex/hooks/kiai.json`, an isolated CODEX_HOME with
//   `[[hooks.PreToolUse]]` and `bypass_hook_trust = true`), so this package does not claim hook
//   support for Codex. See README, "Codex".
//
// WHAT AN IMPORTED RECORD IS WORTH — read this before trusting one
//   A hook record is written WHILE the agent acts. An imported record is derived AFTERWARDS from
//   a file that the agent, and anyone else on the machine, can edit first. The hash chain proves
//   "nothing changed since the import"; it does NOT prove "this is what Codex did". Every imported
//   record says so on its face: `via: "import"` plus `src: { file, sha256, line, ordinal, kind }`.
//
// SOURCE FORMAT (measured 2026-09-17 on 82 real rollouts, 7 distinct Codex builds 0.120 → 0.153.4)
//   $CODEX_HOME/sessions/YYYY/MM/DD/rollout-<ts>-<uuid>.jsonl, one JSON object per line:
//     { timestamp, type, payload }  — plus `ordinal` from 0.151 onward, absent before that
//   type = session_meta            → payload { session_id, cwd, originator, cli_version, source, … }
//        = event_msg               → payload.type user_message | task_complete | patch_apply_end |
//                                                 item_completed | token_count | …
//        = response_item           → payload.type function_call | custom_tool_call | *_output | …
//   Older builds carry the action in response_item + event_msg.patch_apply_end; newer ones also emit
//   event_msg.item_completed with a normalised item (CommandExecution, FileChange, UserMessage, …).
//   Both are read. One Codex action can therefore produce more than one record — the model's REQUEST
//   (tool_call), the runtime's EFFECT (tool_result from item_completed) and the tool OUTPUT. They are
//   different lines in the log and each one names its source kind in `src.kind`.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { sha256, redact, relativizePath, detectUow, gitDelta, writerId, flightDir, readWriter, appendRecord } from './flight.mjs';

export const CODEX_AGENT = 'codex-cli';
const MAX_CMD = 2000;
// Caps on how much of one line we keep. Whenever a cap bites, the record also carries the TOTAL —
// evidence that has been silently trimmed is evidence a reader cannot judge.
const MAX_LIST = 10;
const MAX_PATCH = 50;
const MAX_FILES = 100;

/** Item kinds we deliberately do not turn into records (they carry no action). */
export const SKIPPED_ITEMS = new Set([
  'Reasoning', 'AgentMessage', 'Extension', 'SubAgentActivity', 'ContextCompaction', 'FunctionCallOutput',
]);

// ---- locating the logs ------------------------------------------------------------------

/** $CODEX_HOME (or --home, or ~/.codex) and the sessions directory under it. */
export function codexHome({ home = null, env = process.env } = {}) {
  const base = home || env.CODEX_HOME || path.join(os.homedir(), '.codex');
  return { home: base, sessionsDir: path.join(base, 'sessions') };
}

/** Every rollout-*.jsonl under sessionsDir, sorted by name (rollout names start with a timestamp). */
export function listRollouts(sessionsDir) {
  const out = [];
  const walk = (dir, depth) => {
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      const full = path.join(dir, e.name);
      if (e.isDirectory() && depth < 6) walk(full, depth + 1);
      else if (e.isFile() && /^rollout-.*\.jsonl$/.test(e.name)) out.push(full);
    }
  };
  walk(sessionsDir, 0);
  return out.sort((a, b) => path.basename(a).localeCompare(path.basename(b)));
}

/** Parse a rollout file. Malformed lines are counted, never thrown: a half-written tail is normal. */
export function readRollout(file) {
  const lines = [];
  let bad = 0;
  let text;
  try { text = fs.readFileSync(file, 'utf8'); } catch (err) { return { lines, bad, error: err.message }; }
  let index = 0;
  for (const raw of text.split(/\r?\n/)) {
    index++;
    if (!raw.trim()) continue;
    try {
      const value = JSON.parse(raw);
      // The line number is the only position that is ALWAYS real. Codex only began emitting its own
      // `ordinal` in 0.151: 23919 of the 32118 rollout lines on the machine this was built on (74%,
      // every build up to 0.148.x) have no such field, so it cannot carry provenance on its own.
      if (value && typeof value === 'object') Object.defineProperty(value, '_line', { value: index, enumerable: false });
      lines.push(value);
    } catch { bad++; }
  }
  return { lines, bad, error: null };
}

/** The first session_meta line's payload, or null when the file has none (we never guess a cwd). */
export function sessionMeta(lines) {
  for (const l of lines) {
    if (l && l.type === 'session_meta' && l.payload && typeof l.payload === 'object') return l.payload;
  }
  return null;
}

/** Is `dir` inside `root` (or equal to it)? Used to keep other repos' sessions out of this black box. */
export function insideRoot(root, dir) {
  if (typeof dir !== 'string' || !dir) return false;
  // Resolve links on BOTH sides first. A junction or symlink inside the repo pointing at another
  // project would otherwise pass a purely textual check and pull that project's sessions in here;
  // and a repo reached THROUGH a junction (this project uses them for worktrees) would have its own
  // sessions rejected as "outside". realpath can fail on a path that no longer exists: fall back to
  // the textual form rather than throwing.
  const real = (p) => { try { return fs.realpathSync.native(path.resolve(p)); } catch { return path.resolve(p); } };
  const rel = path.relative(real(root), real(dir));
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

// ---- summarising one line ---------------------------------------------------------------

const clip = (v, max = 1000) => (v == null ? null : redact(String(v)).slice(0, max));

/**
 * Make a path Codex recorded root-relative, the way every other record stores one.
 *
 * A log written on Windows separates with `\`, and a POSIX host reads `\` as an ordinary character —
 * so `<root>\src\a.js` looks like ONE filename sitting outside the repository. CI caught exactly that.
 *
 * The path is tried as written, then with `\` read as a separator. `relativizePath` calls anything
 * that is not absolute "inside" WITHOUT checking — and a Windows path is not absolute on POSIX — so a
 * candidate only counts when it comes back as a genuinely relative path under the root. A real POSIX
 * filename containing a backslash still matches on the first candidate, so it is never rewritten.
 */
export function toRepoPath(root, file) {
  if (typeof file !== 'string' || !file) return relativizePath(root, file);
  for (const candidate of file.includes('\\') ? [file, file.split('\\').join('/')] : [file]) {
    const rel = relativizePath(root, candidate);
    if (rel.outside) continue;
    if (path.isAbsolute(rel.file) || rel.file.startsWith('/') || /^[A-Za-z]:/.test(rel.file)) continue;
    // relativizePath calls a RELATIVE path inside without resolving it, so `../../etc/passwd` comes
    // back "inside" and an acceptance packet would then read and vouch for a file outside the tree.
    // The log is untrusted by this package's own threat model; a path that climbs out is outside.
    if (escapesRoot(root, rel.file)) continue;
    return rel;
  }
  const raw = relativizePath(root, file);
  return raw.outside || !escapesRoot(root, raw.file) ? raw : { file: raw.file, outside: true };
}

/** Does this repo-relative path resolve to somewhere outside the repo? */
function escapesRoot(root, rel) {
  if (typeof rel !== 'string' || !rel) return false;
  const back = path.relative(path.resolve(root), path.resolve(root, rel));
  return back.startsWith('..') || path.isAbsolute(back);
}

/** Codex reports some directories as file:// URLs. Make them look like every other path we store. */
function normalizeDir(value, root) {
  if (typeof value !== 'string' || !value) return null;
  let p = value;
  if (/^file:\/\//i.test(p)) {
    try { p = fileURLToPath(p); } catch { return clip(value, 300); }
  }
  // relativizePath reports the root itself as `outside` (the relative form is empty), so the root has
  // to be recognised before asking it. Without this the record carries the machine's absolute path.
  try { if (path.resolve(p) === path.resolve(root)) return '.'; } catch { /* unresolvable: fall through */ }
  return clip(toRepoPath(root, p).file, 300);
}

function outputText(output) {
  if (typeof output === 'string') return output;
  if (Array.isArray(output)) return output.map((o) => (o && typeof o.text === 'string' ? o.text : '')).join('\n');
  if (output && typeof output === 'object' && typeof output.text === 'string') return output.text;
  return output == null ? '' : JSON.stringify(output);
}

/**
 * Codex "code mode" sends JavaScript as the tool input, and that JavaScript can CARRY FILE CONTENT:
 * an apply_patch call embeds the whole new file in the source string. A raw preview therefore copies
 * file contents into the flight record, which this package has refused to do since UOW-119 — the
 * first run of this importer leaked a fixture's contents exactly that way, and the test now locks it.
 *
 * So: never the source. Record its hash and size, which `tools.*` it calls, the commands it runs
 * (a command is evidence we already keep for Bash) and the paths its patch touches, taken from the
 * patch ENVELOPE (`*** Add File: x`), never from the `+` lines.
 */
function summarizeCode(input) {
  const code = typeof input === 'string' ? input : JSON.stringify(input ?? null);
  const out = { code_sha256: sha256(code), code_bytes: Buffer.byteLength(code, 'utf8') };

  const tools = [];
  for (const m of code.matchAll(/tools\.([A-Za-z0-9_]{1,40})\s*\(/g)) if (!tools.includes(m[1])) tools.push(m[1]);
  if (tools.length) { out.tools = tools.slice(0, MAX_LIST); if (tools.length > MAX_LIST) out.tools_total = tools.length; }

  const commands = [];
  for (const m of code.matchAll(/exec_command\s*\(\s*(\{[\s\S]{0,4000}?\})\s*\)/g)) {
    let parsed = null;
    try { parsed = JSON.parse(m[1]); } catch { /* the object is not literal JSON: skip it */ }
    if (!parsed || typeof parsed !== 'object') continue;
    const cmd = Array.isArray(parsed.cmd) ? parsed.cmd.join(' ') : parsed.cmd ?? parsed.command;
    if (typeof cmd === 'string' && cmd) commands.push(redact(cmd).slice(0, MAX_CMD));
  }
  if (commands.length) { out.commands = commands.slice(0, MAX_LIST); if (commands.length > MAX_LIST) out.commands_total = commands.length; }

  const patch = [];
  // The patch lives inside a JS string literal, so its newlines are the two characters \ and n.
  for (const m of code.matchAll(/\*\*\* (Add|Update|Delete) File: ([^\\"'\n\r]{1,300})/g)) {
    patch.push({ change: m[1].toLowerCase(), file: m[2].trim() });
  }
  if (patch.length) { out.patch_files = patch.slice(0, MAX_PATCH); if (patch.length > MAX_PATCH) out.patch_files_total = patch.length; }

  if (!tools.length && !commands.length && !patch.length) {
    // Nothing recognised. Say so rather than copying the source in: an unrecognised blob is exactly
    // where an unknown amount of file content could hide.
    out.shape = 'unrecognised';
  }
  return out;
}

/** Classic function_call: `arguments` is a JSON string. Fall back to a hash when it is not parseable. */
function summarizeArguments(args) {
  if (typeof args !== 'string') return summarizeCode(args);
  let parsed = null;
  try { parsed = JSON.parse(args); } catch { /* not JSON: keep the raw preview below */ }
  if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
    const out = { keys: Object.keys(parsed).slice(0, 30) };
    if (typeof parsed.cmd === 'string') out.command = redact(parsed.cmd).slice(0, MAX_CMD);
    if (Array.isArray(parsed.cmd)) out.command = redact(parsed.cmd.join(' ')).slice(0, MAX_CMD);
    if (typeof parsed.command === 'string') out.command = redact(parsed.command).slice(0, MAX_CMD);
    if (typeof parsed.workdir === 'string') out.workdir = clip(parsed.workdir, 300);
    return out;
  }
  return summarizeCode(args);
}

/** FileChange / patch_apply_end: one entry per path — never the content, only its hash and size. */
function summarizeChanges(changes, root) {
  const files = [];
  if (!changes || typeof changes !== 'object') return files;
  const all = Object.entries(changes);
  for (const [file, change] of all.slice(0, MAX_FILES)) {
    const rel = toRepoPath(root, file);
    const entry = { file: rel.file, change: clip(change && change.type, 20) };
    if (rel.outside) entry.outside_repo = true;
    const content = change && typeof change.content === 'string' ? change.content
      : change && typeof change.new_content === 'string' ? change.new_content : null;
    if (content != null) {
      entry.content_sha256 = sha256(content);
      entry.content_bytes = Buffer.byteLength(content, 'utf8');
    }
    files.push(entry);
  }
  // A patch that touched more paths than we keep must say so, not quietly show the first hundred.
  if (all.length > MAX_FILES) files.push({ file: null, change: 'truncated', files_total: all.length, files_kept: MAX_FILES });
  return files;
}

function resultOf(ok, text) {
  const out = { bytes: Buffer.byteLength(String(text ?? ''), 'utf8') };
  if (typeof ok === 'boolean') out.ok = ok;
  return out;
}

// ---- one rollout file → records ---------------------------------------------------------

/**
 * Turn the lines of one rollout into KIAI record bodies (no seq/prev/hash yet — appendRecord seals).
 * `ctx` = { root, file (relative to sessionsDir), sha256, env }.
 */
export function toRecords(lines, meta, ctx) {
  const { root, file, sha256: fileSha, env = process.env } = ctx;
  const cwd = typeof meta.cwd === 'string' ? meta.cwd : root;
  const session = meta.session_id == null ? null : String(meta.session_id).slice(0, 120);
  const uow = detectUow(root, env);
  const seenIds = new Set();      // FileChange item id ↔ patch_apply_end call_id share an id space
  const skippedKinds = new Map();
  const out = [];

  const base = (line, kind) => ({
    ts: typeof line.timestamp === 'string' ? line.timestamp : new Date().toISOString(),
    agent: CODEX_AGENT,
    via: 'import',
    session,
    cwd,
    uow,
    // `line` is the 1-based line number in the rollout: always real, so a reader can open the file and
    // find exactly this line. `ordinal` is the source's OWN field, and it is null when the build that
    // wrote the log had none — a fabricated position would be a lie in a provenance record.
    src: { file, sha256: fileSha, line: Number.isInteger(line._line) ? line._line : null, ordinal: Number.isInteger(line.ordinal) ? line.ordinal : null, kind },
  });
  const skip = (k) => skippedKinds.set(k, (skippedKinds.get(k) || 0) + 1);

  // session_start comes from the meta line itself
  const metaLine = lines.find((l) => l && l.type === 'session_meta') || { timestamp: meta.timestamp };
  out.push({
    ...base(metaLine, 'session_meta'),
    event: 'session_start',
    source: clip(meta.originator, 40),
    client: {
      cli_version: clip(meta.cli_version, 40),
      source: clip(meta.source, 40),
      model_provider: clip(meta.model_provider, 40),
    },
  });

  for (const line of lines) {
    if (!line || typeof line !== 'object') continue;
    const p = line.payload && typeof line.payload === 'object' ? line.payload : {};
    const kind = p.type;

    if (line.type === 'session_meta') continue;

    if (kind === 'user_message') {
      const text = typeof p.message === 'string' ? p.message : outputText(p.content);
      out.push({ ...base(line, 'user_message'), event: 'prompt', prompt_sha256: text ? sha256(text) : null });
      continue;
    }

    if (kind === 'function_call' || kind === 'custom_tool_call') {
      out.push({
        ...base(line, kind),
        event: 'tool_call',
        tool: clip(p.name, 80),
        tool_use_id: clip(p.call_id, 120),
        input: kind === 'function_call' ? summarizeArguments(p.arguments) : summarizeCode(p.input),
      });
      continue;
    }

    if (kind === 'function_call_output' || kind === 'custom_tool_call_output') {
      const text = outputText(p.output);
      out.push({
        ...base(line, kind),
        event: 'tool_result',
        tool: null,
        tool_use_id: clip(p.call_id, 120),
        result: resultOf(undefined, text),
      });
      continue;
    }

    if (kind === 'patch_apply_end') {
      const id = clip(p.call_id, 120);
      if (id && seenIds.has(id)) { skip('patch_apply_end(duplicate id)'); continue; }
      if (id) seenIds.add(id);
      out.push({
        ...base(line, 'patch_apply_end'),
        event: 'tool_result',
        tool: 'apply_patch',
        tool_use_id: id,
        input: { files: summarizeChanges(p.changes, root) },
        result: resultOf(p.success === true ? true : p.success === false ? false : undefined, p.stdout),
      });
      continue;
    }

    if (kind === 'task_complete') {
      // No `git` here. gitDelta() would read the tree AS IT IS NOW, while this record is stamped with
      // the time Codex stopped — a report would then show a HEAD that did not exist yet at that time.
      // What the tree looked like when Codex ran is simply not in the log, so we say nothing about it.
      out.push({ ...base(line, 'task_complete'), event: 'stop' });
      continue;
    }

    if (kind === 'item_completed') {
      const item = p.item && typeof p.item === 'object' ? p.item : {};
      const itemType = String(item.type || 'unknown');
      if (SKIPPED_ITEMS.has(itemType)) { skip('item:' + itemType); continue; }
      const id = clip(item.id, 120);

      if (itemType === 'UserMessage') {
        const text = outputText(item.content);
        out.push({ ...base(line, 'item:UserMessage'), event: 'prompt', prompt_sha256: text ? sha256(text) : null });
        continue;
      }
      if (itemType === 'FileChange') {
        if (id && seenIds.has(id)) { skip('item:FileChange(duplicate id)'); continue; }
        if (id) seenIds.add(id);
        out.push({
          ...base(line, 'item:FileChange'),
          event: 'tool_result',
          tool: 'FileChange',
          tool_use_id: id,
          input: { files: summarizeChanges(item.changes, root) },
          result: resultOf(item.status === 'completed' ? true : item.status ? false : undefined, item.stdout),
        });
        continue;
      }
      if (itemType === 'CommandExecution') {
        const argv = Array.isArray(item.command) ? item.command.join(' ') : String(item.command ?? '');
        out.push({
          ...base(line, 'item:CommandExecution'),
          event: 'tool_result',
          tool: 'CommandExecution',
          tool_use_id: id,
          input: { command: redact(argv).slice(0, MAX_CMD), workdir: normalizeDir(item.cwd, root) },
          result: resultOf(item.status === 'completed' ? true : item.status ? false : undefined, item.stdout),
        });
        continue;
      }
      if (itemType === 'McpToolCall') {
        out.push({
          ...base(line, 'item:McpToolCall'),
          event: 'tool_result',
          tool: clip(item.server ? `${item.server}/${item.tool}` : item.tool, 80),
          tool_use_id: id,
          result: resultOf(item.status === 'completed' ? true : item.status ? false : undefined, outputText(item.result)),
        });
        continue;
      }
      skip('item:' + itemType);
      continue;
    }

    if (kind) skip(kind);
  }

  return { records: out, skippedKinds };
}

// ---- the whole import -------------------------------------------------------------------

/**
 * Key identifying one already-imported rollout line inside the chain.
 *
 * FILE + LINE, never session + ordinal. One Codex session can span many rollout files — 8 of the 85
 * logs on the machine this was built on belong to a session with more than one file, and one session
 * has 30 — and every file numbers its lines from the start again. Keying on the session therefore made
 * the second file's lines collide with the first file's and be dropped as "already imported": real
 * evidence lost, silently, and reported as a duplicate. The file path (relative to the sessions
 * directory) plus the line number is unique and stable across imports.
 */
export function importKey(record) {
  const src = record && record.src;
  if (!src || typeof src.file !== 'string') return null;
  if (Number.isInteger(src.line)) return `${src.file}#${src.line}`;
  // A chain written before this rule: keep honouring its key so a re-import is still a no-op.
  return Number.isInteger(src.ordinal) ? `${record.session == null ? '' : record.session}#${src.ordinal}` : null;
}

/** Everything already imported into this chain, so a second run writes nothing. */
export function importedKeys(records) {
  const keys = new Set();
  for (const r of records) {
    if (!r || r.via !== 'import') continue;
    for (const k of importKeys(r)) keys.add(k);
  }
  return keys;
}

/**
 * Every key a record can be known by. A chain written before the file+line rule only has
 * `session#ordinal`, and a record built now only produces `file#line` — two families that never meet,
 * so re-importing after an upgrade would append the whole chain a second time. A candidate is therefore
 * CHECKED against both, while only the file+line key is remembered — remembering the legacy one would
 * make two different lines of two files collide again. Trade-off, stated plainly: on a chain written by
 * the old rule, a line of a second file that happens to share an `ordinal` can be skipped as already
 * imported. Delete the writer directory and re-import to be rid of it.
 */
export function importKeys(record) {
  const out = [];
  const src = record && record.src;
  if (!src) return out;
  if (typeof src.file === 'string' && Number.isInteger(src.line)) out.push(`${src.file}#${src.line}`);
  if (Number.isInteger(src.ordinal)) out.push(`${record.session == null ? '' : record.session}#${src.ordinal}`);
  return out;
}

export function codexWriter(root, env = process.env) {
  return `${writerId(root, { ...env, KIAI_WRITER: '' })}-codex`;
}

/**
 * Import Codex rollouts into `<root>/.kiai/flight/<writer>-codex/`.
 *
 * Options: { home, since, sessionFile, dryRun, env, now }
 *  - sessionFile forces ONE file even when its cwd is outside this repo; the records are then
 *    flagged `cwd_outside_root: true` rather than silently blended in.
 *  - Without it, a rollout whose session cwd is not inside `root` is never read into this repo.
 */
export function importCodex(root, { home = null, since = null, sessionFile = null, dryRun = false, env = process.env } = {}) {
  const { home: base, sessionsDir } = codexHome({ home, env });
  const writer = codexWriter(root, env);
  const writerEnv = { ...env, KIAI_WRITER: writer };
  const dir = path.join(flightDir(root), writer);
  const already = importedKeys(readWriter(dir, writer));

  let files;
  if (sessionFile) {
    if (!fs.existsSync(sessionFile)) {
      const err = new Error(`no such rollout file: ${sessionFile}`);
      err.code = 'KIAI_NO_SESSIONS';
      throw err;
    }
    files = [sessionFile];
  } else {
    if (!fs.existsSync(sessionsDir)) {
      const err = new Error(`no Codex sessions directory at ${sessionsDir} (looked under CODEX_HOME=${base}; pass --home DIR)`);
      err.code = 'KIAI_NO_SESSIONS';
      throw err;
    }
    files = listRollouts(sessionsDir);
  }

  let sinceTs = null;
  if (since) {
    sinceTs = new Date(since).getTime();
    if (Number.isNaN(sinceTs)) throw new Error(`--since: cannot parse date "${since}" (use YYYY-MM-DD or an ISO timestamp)`);
  }

  const result = {
    writer, home: base, sessionsDir, dry_run: Boolean(dryRun),
    files_seen: files.length, files_read: 0, imported: 0, duplicates: 0, bad_lines: 0,
    skipped: [], skipped_kinds: {}, records: [], sessions: [],
  };

  for (const full of files) {
    const rel = path.relative(sessionsDir, full).split(path.sep).join('/') || path.basename(full);
    const { lines, bad, error } = readRollout(full);
    if (error) { result.skipped.push({ file: rel, reason: `unreadable: ${error}` }); continue; }
    result.bad_lines += bad;
    const meta = sessionMeta(lines);
    if (!meta) { result.skipped.push({ file: rel, reason: 'no session_meta line' }); continue; }
    const outside = !insideRoot(root, meta.cwd);
    if (outside && !sessionFile) { result.skipped.push({ file: rel, reason: 'session cwd is outside this repo' }); continue; }
    if (sinceTs != null) {
      const ts = Date.parse(meta.timestamp || '') || 0;
      if (ts && ts < sinceTs) { result.skipped.push({ file: rel, reason: 'older than --since' }); continue; }
    }

    result.files_read++;
    let fileSha;
    try { fileSha = sha256(fs.readFileSync(full, 'utf8')); } catch (err) {
      // The log can vanish between listing and hashing (Codex rotates its own files).
      result.skipped.push({ file: rel, reason: `unreadable while hashing: ${err.message}` });
      result.files_read--;
      continue;
    }
    const { records, skippedKinds } = toRecords(lines, meta, { root, file: rel, sha256: fileSha, env });
    for (const [k, n] of skippedKinds) result.skipped_kinds[k] = (result.skipped_kinds[k] || 0) + n;

    let wrote = 0;
    for (const rec of records) {
      // Checked against BOTH key families (a chain written before the file+line rule only has the old
      // one), but only the file+line key is REMEMBERED: adding the legacy key back would make two
      // different lines of two files collide again — the very bug the new key exists to fix.
      const keys = importKeys(rec);
      if (keys.some((k) => already.has(k))) { result.duplicates++; continue; }
      if (keys.length) already.add(keys[0]);
      if (outside) rec.cwd_outside_root = true;
      if (dryRun) { result.records.push(rec); wrote++; result.imported++; continue; }
      try {
        appendRecord(root, rec, { env: writerEnv });
      } catch (err) {
        // A busy lock or a full disk stops the import — but what is already sealed stays sealed and
        // stays counted, so the next run continues from there instead of starting over blindly.
        result.failed = { file: rel, line: rec.src && rec.src.line, reason: err && err.message ? err.message : String(err) };
        return result;
      }
      wrote++;
      result.imported++;
    }
    result.sessions.push({ file: rel, session: records.length ? records[0].session : null, records: wrote });
  }

  return result;
}
