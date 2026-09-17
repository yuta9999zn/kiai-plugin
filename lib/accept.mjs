// kiai accept — an acceptance packet built from the flight record.
// Answers "what am I signing when I accept AI-written code?": what the agent did, whether the files on
// disk are exactly what it wrote, which test commands ran, and who decided what. The packet ends with a
// sha256 footer; a decision is also sealed into the flight record with the packet hash, so the packet
// and the chain vouch for each other.
import fs from 'node:fs';
import path from 'node:path';
import { sha256, cell, recordFiles } from './flight.mjs';

export const DECISIONS = ['approve', 'reject', 'conditional'];

/**
 * Does a shell command run a test suite? Each `&&`/`;`/`||`/`|`/newline segment is checked at its start
 * (after env assignments and launchers such as `npx`), so `git commit -m "fix jest"` or `cat pytest.ini`
 * do not count. Result is "not interrupted", never "passed" — hooks carry no exit code.
 */
const TEST_START = /^(?:(?:npm|pnpm|yarn|bun)\s+(?:run\s+)?test\b|node\s+--test\b|pytest\b|python3?\s+-m\s+pytest\b|go\s+test\b|cargo\s+test\b|(?:bundle\s+exec\s+)?rspec\b|jest\b|vitest\b|mocha\b|mvn\s+(?:-\S+\s+)*test\b|(?:\.\/)?gradlew?\s+test\b|dotnet\s+test\b|phpunit\b|ctest\b|make\s+test\b)/i;
const LAUNCHER = /^(?:[A-Za-z_][A-Za-z0-9_]*=\S*\s+|npx\s+|pnpm\s+dlx\s+|bunx\s+|time\s+|env\s+(?:-u\s+\S+\s+)*|sudo\s+)+/;

/**
 * A shell invoked to run the real command, as an argv joined by spaces.
 *
 * Codex never runs a command directly: all 996 `CommandExecution` records measured on the build
 * machine look like `C:\…\pwsh.exe -Command npm test`, none like `npm test`. Without stripping the
 * wrapper, `isTestCommand` answers "no" for every test a Codex session ever ran, and the acceptance
 * packet then states that no tests ran — a false negative in the row a reader looks at first.
 * The executable can sit behind a path containing spaces, so the prefix is matched up to the exe name.
 */
const SHELL_WRAPPER = new RegExp(
  '^(?:(?:[A-Za-z]:)?[\\\\/][^\\n]*?[\\\\/])?(?:'
  + '(?:pwsh|powershell)(?:\\.exe)?\\s+(?:-(?:NoProfile|NoLogo|NonInteractive)\\s+|-ExecutionPolicy\\s+\\S+\\s+)*(?:-Command|-c)'
  + '|(?:bash|sh|zsh|dash)(?:\\.exe)?\\s+-[a-z]*c'
  + '|cmd(?:\\.exe)?\\s+/[ck]'
  + ')\\s+', 'i');

/** The command a wrapper was asked to run: `C:\…\pwsh.exe -Command npm test` → `npm test`. */
export function unwrapCommand(command) {
  let s = String(command ?? '').trim();
  for (let i = 0; i < 3 && SHELL_WRAPPER.test(s); i++) {
    s = s.replace(SHELL_WRAPPER, '').trim().replace(/^(['"])([\s\S]*)\1$/, '$2').trim();
  }
  return s;
}

export function isTestCommand(command) {
  return unwrapCommand(command).split(/&&|\|\||;|\||\r?\n/).some((seg) => TEST_START.test(seg.trim().replace(LAUNCHER, '')));
}
/** @deprecated kept for callers; prefer isTestCommand */
export const TEST_RE = { test: isTestCommand };

const code = (v, max = 200) => '`' + cell(v, max) + '`';
function quoted(text, max = 8000) {
  // Inside a block quote lists stay lists (checkboxes are useful); only headings and tables are neutralised.
  return String(text ?? '').slice(0, max).replace(/\r\n/g, '\n').replace(/\n+$/, '').split('\n').map((l) => (l.trim() ? '> ' + l.replace(/^\s*([#|])/, '\\$1') : '>')).join('\n');
}

// ---- labels -----------------------------------------------------------------------------

const L = {
  en: {
    title: 'Acceptance packet', generated: 'Generated', repo: 'Repository', uow: 'Unit of work', status: 'Status',
    draft: 'DRAFT — no decision recorded', draftPrior: 'DRAFT — earlier decision(s) exist, latest', chain: 'Flight record chain', intact: 'intact', broken: 'BROKEN',
    anchored: 'Anchored', notAnchored: 'not anchored — only this machine can tell whether the tail was cut',
    anchoredAt: 'covering', anchorRecords: 'records',
    records: 'records', heads: 'heads', warnDropped: 'Dropped records (hook could not take the lock): the log is INCOMPLETE',
    warnAnomaly: 'Anomalies sealed in chain (files and local pointer disagreed)', warnNoRecords: 'No flight records found for this unit of work',
    warnUntagged: 'records in the same sessions carry another or no UoW tag and are NOT covered by this packet', warnUntaggedWrites: 'of them are file writes',
    warnAcAgent: 'The acceptance criteria file was WRITTEN BY THE AGENT during this unit of work (see Files); treat it as a proposal, not as the client\'s criteria',
    warnAgentDecision: 'This decision was recorded from inside an agent session (KIAI_ALLOW_AGENT_DECISION), not by a human outside it',
    warnOutside: 'file write(s) OUTSIDE the repository',
    warnTruncatedFiles: 'further changed path(s) are NOT listed: a patch touched more files than one record keeps',
    warnImported: 'record(s) in this packet were IMPORTED from an agent log after the fact, not observed by a hook while the agent acted; the chain proves only that nobody changed them since the import',
    agents: 'Agents',
    ac: 'Acceptance criteria', acNone: 'No acceptance criteria file was provided (use --ac FILE or .kiai/ac/<UoW>.md).',
    sessions: 'What the agent did', session: 'Session', start: 'Start (UTC)', end: 'End (UTC)', toolCalls: 'Tool calls', failures: 'Failures', writer: 'Writer',
    files: 'Files written', file: 'Path (relative to repo)', kind: 'Last op', recorded: 'sha256 recorded', disk: 'On disk now',
    diskMatches: 'matches', diskMatchesEol: 'matches (line endings differ)', diskChanged: 'CHANGED after the agent wrote it', diskMissing: 'MISSING', diskEditOnly: 'edit-only (partial edit, full-file hash not recorded)', diskOutside: 'outside the repository',
    filesNone: 'No file writes recorded.',
    tests: 'Test commands observed', test: 'Command', result: 'Result', ok: 'completed (not interrupted, no error reported)', failed: 'interrupted / error reported', unknown: 'unknown',
    testsNote: 'Hooks expose no exit code: "completed" means the command was not interrupted and reported no error, not that tests passed. Check the CI or the terminal for pass/fail.',
    testsNone: 'No test command observed in this unit of work.',
    commands: 'Shell commands', commandsMore: 'more not shown', git: 'Git at last stop', gitNone: 'No git state recorded.',
    notes: 'Notes and prior decisions', notesNone: 'None.',
    decision: 'Decision', by: 'Decided by', at: 'At', note: 'Note', via: 'Recorded via', viaHuman: 'human, outside any agent session', viaAgent: 'AGENT SESSION',
    decisionSealed: 'This decision is sealed into the flight record as a `decision` record carrying the sha256 of this file and of the companion .json.',
    howto: 'How to verify', howto1: 'sha256 of everything above the `Hash:` line (CRLF normalised to LF) must equal the footer.',
    howto2: '`kiai accept --check <this file>` recomputes it and, inside the repository, looks up the `decision` record that sealed it; `kiai verify` checks the flight record chain.',
    howto3: 'A decision with a `Signature:` block below the footer is bound to a key listed in `.kiai/allowed_signers` — check it with `kiai accept --check`. A decision WITHOUT one rests only on an environment check, which is worth what an environment variable is worth.',
    approve: 'APPROVED', reject: 'REJECTED', conditional: 'APPROVED WITH CONDITIONS',
  },
  vi: {
    title: 'Hồ sơ nghiệm thu', generated: 'Sinh lúc', repo: 'Kho mã', uow: 'Đơn vị công việc', status: 'Trạng thái',
    draft: 'BẢN NHÁP — chưa có quyết định', draftPrior: 'BẢN NHÁP — đã có quyết định trước, mới nhất', chain: 'Chuỗi flight record', intact: 'nguyên vẹn', broken: 'GÃY',
    anchored: 'Neo', notAnchored: 'chưa neo — chỉ máy này biết được đuôi có bị cắt hay không',
    anchoredAt: 'phủ', anchorRecords: 'bản ghi',
    records: 'bản ghi', heads: 'đầu chuỗi', warnDropped: 'Có bản ghi bị rớt (hook không lấy được khoá): log KHÔNG ĐẦY ĐỦ',
    warnAnomaly: 'Bất thường đã niêm trong chuỗi (tệp và con trỏ cục bộ lệch nhau)', warnNoRecords: 'Không có flight record nào cho đơn vị công việc này',
    warnUntagged: 'bản ghi trong cùng các phiên mang UoW khác hoặc không gắn UoW, KHÔNG nằm trong hồ sơ này', warnUntaggedWrites: 'trong đó là lần ghi tệp',
    warnAcAgent: 'Tệp tiêu chí nghiệm thu do CHÍNH AGENT VIẾT trong đơn vị công việc này (xem Tệp đã ghi); coi là đề xuất, không phải tiêu chí của khách',
    warnAgentDecision: 'Quyết định này được ghi từ BÊN TRONG phiên agent (KIAI_ALLOW_AGENT_DECISION), không phải do người ngoài phiên',
    warnOutside: 'lần ghi tệp NGOÀI kho mã',
    warnTruncatedFiles: 'đường dẫn bị đổi nữa KHÔNG được liệt: một patch chạm nhiều tệp hơn mức một record giữ',
    warnImported: 'bản ghi trong hồ sơ này được NHẬP LẠI từ log của tác tử sau khi việc đã xong, không phải do hook ghi lúc tác tử đang làm; chuỗi chỉ chứng minh không ai sửa chúng kể từ lúc nhập',
    agents: 'Tác tử',
    ac: 'Tiêu chí nghiệm thu', acNone: 'Chưa cung cấp tệp tiêu chí (dùng --ac FILE hoặc .kiai/ac/<UoW>.md).',
    sessions: 'Agent đã làm gì', session: 'Phiên', start: 'Bắt đầu (UTC)', end: 'Kết thúc (UTC)', toolCalls: 'Lượt gọi tool', failures: 'Lỗi', writer: 'Máy ghi',
    files: 'Tệp đã ghi', file: 'Đường dẫn (tương đối kho)', kind: 'Thao tác cuối', recorded: 'sha256 lúc ghi', disk: 'Trên đĩa hiện tại',
    diskMatches: 'khớp', diskMatchesEol: 'khớp (chỉ khác kiểu xuống dòng)', diskChanged: 'ĐÃ ĐỔI sau khi agent ghi', diskMissing: 'THIẾU', diskEditOnly: 'chỉ sửa một phần (không có hash toàn tệp)', diskOutside: 'ngoài kho mã',
    filesNone: 'Không có lần ghi tệp nào.',
    tests: 'Lệnh test quan sát được', test: 'Lệnh', result: 'Kết quả', ok: 'chạy xong (không bị ngắt, không báo lỗi)', failed: 'bị ngắt / có báo lỗi', unknown: 'không rõ',
    testsNote: 'Hook không cho exit code: "chạy xong" nghĩa là lệnh không bị ngắt và không báo lỗi, KHÔNG phải test đậu. Kiểm CI hoặc terminal để biết đậu/rớt.',
    testsNone: 'Không thấy lệnh test nào trong đơn vị công việc này.',
    commands: 'Lệnh shell', commandsMore: 'lệnh nữa không hiển thị', git: 'Git lúc dừng cuối', gitNone: 'Không có trạng thái git.',
    notes: 'Ghi chú và quyết định trước', notesNone: 'Không có.',
    decision: 'Quyết định', by: 'Người quyết định', at: 'Lúc', note: 'Ghi chú', via: 'Ghi qua', viaHuman: 'người, ngoài phiên agent', viaAgent: 'PHIÊN AGENT',
    decisionSealed: 'Quyết định này được niêm vào flight record dưới dạng bản ghi `decision` mang sha256 của tệp này và của tệp .json đi kèm.',
    howto: 'Cách kiểm', howto1: 'sha256 của toàn bộ nội dung PHÍA TRÊN dòng `Hash:` (CRLF chuẩn hoá về LF) phải bằng giá trị chân trang.',
    howto2: '`kiai accept --check <tệp này>` tính lại và, khi chạy trong kho, tìm bản ghi `decision` đã niêm nó; `kiai verify` kiểm chuỗi flight record.',
    howto3: 'Quyết định có khối `Signature:` dưới footer là quyết định được ràng vào một khoá có trong `.kiai/allowed_signers` — kiểm bằng `kiai accept --check`. Quyết định KHÔNG có khối ấy chỉ dựa vào kiểm biến môi trường, và nó đáng giá đúng bằng một biến môi trường.',
    approve: 'CHẤP NHẬN', reject: 'TỪ CHỐI', conditional: 'CHẤP NHẬN CÓ ĐIỀU KIỆN',
  },
};

function labeller(lang) {
  if (lang === 'both') return (k) => `${L.vi[k]} / ${L.en[k]}`;
  const t = L[lang] || L.en;
  return (k) => t[k];
}

// ---- collect ------------------------------------------------------------------------------

export function collectUow(records, uow) {
  const all = records.filter((r) => Number.isInteger(r.seq));
  const scoped = all.filter((r) => r.uow === uow);
  const sessions = new Map();
  const files = new Map();
  const commands = [];
  const tests = [];
  const notes = [];
  const decisions = [];
  const results = new Map();
  let git = null;
  let anomalies = 0;
  let filesTruncated = 0;
  for (const r of scoped) if (r.event === 'tool_result' && r.tool_use_id) results.set(r.tool_use_id, r);
  // An imported Codex session logs one command TWICE: once as the model's request (a code-mode
  // tool_call whose JavaScript calls exec_command) and once as the runtime's effect (a
  // CommandExecution tool_result carrying the real argv). They have ids from different spaces, so
  // matching on tool_use_id cannot pair them. Where the runtime reported the effect, that is the
  // authoritative record and the request is not counted again; older logs that only carry the
  // request keep it. Sealed by the x prediction for UOW-124, which neither the review nor the
  // builder caught.
  //
  // The pairing is per COMMAND TEXT, not per session: dropping every request in a session that had any
  // effect at all loses a real command the runtime never reported separately. The effect carries the
  // shell wrapper (`pwsh.exe -Command npm test`) and the request does not (`npm test`), so both sides
  // are compared unwrapped, and each effect cancels at most one request.
  const effectCommands = new Map();
  for (const r of scoped) {
    if (r.via !== 'import' || r.event !== 'tool_result') continue;
    if (!r.input || typeof r.input.command !== 'string' || !r.input.command) continue;
    const k = `${r.session}\u0000${unwrapCommand(r.input.command)}`;
    effectCommands.set(k, (effectCommands.get(k) || 0) + 1);
  }
  for (const r of scoped) {
    if (r.anomaly) anomalies++;
    const key = r.session ?? (r.event === 'note' || r.event === 'decision' ? null : 'unknown');
    if (key) {
      if (!sessions.has(key)) sessions.set(key, { session: key, first: r.ts, last: r.ts, tools: {}, failures: 0, writers: new Set() });
      const s = sessions.get(key);
      if (typeof r.ts === 'string') { if (r.ts < s.first) s.first = r.ts; if (r.ts > s.last) s.last = r.ts; }
      if (r.writer || r._writer) s.writers.add(r.writer || r._writer);
      if (r.event === 'tool_call' && r.tool) s.tools[r.tool] = (s.tools[r.tool] || 0) + 1;
      if (r.event === 'tool_result' && r.result && r.result.ok === false) s.failures++;
    }
    // Writes arrive on a tool_call (Claude hooks) or on a tool_result (Codex import: the runtime
    // reports what it actually changed). A Claude tool_result merely ECHOES its call's input, so only
    // an imported tool_result is read — otherwise every write and every command would count twice.
    const echoed = r.event === 'tool_result' && r.via !== 'import';
    for (const f of (echoed ? [] : recordFiles(r))) {
      files.set(f.file, { path: f.file, sha256: f.sha256, bytes: f.bytes, kind: f.kind, outside: f.outside, cwd: r.cwd ?? null, ts: r.ts, seq: r.seq });
    }
    // A patch that touched more paths than one record keeps leaves a marker instead of the rest.
    // `recordFiles` drops that marker (it has no path), so the count is taken here and SUMMED across
    // every record: a packet that quietly prints the first hundred is a packet that hides evidence.
    if (!echoed && r.input && Array.isArray(r.input.files)) {
      for (const f of r.input.files) {
        if (f && f.change === 'truncated' && Number.isInteger(f.files_total)) {
          filesTruncated += f.files_total - (Number.isInteger(f.files_kept) ? f.files_kept : 0);
        }
      }
    }
    // Commands: Claude hooks put one on the tool_call and the outcome on a separate tool_result;
    // a Codex import can put the command and its outcome on the SAME tool_result (CommandExecution),
    // or list several inside one code-mode tool_call (`input.commands`).
    if (r.input && !echoed && (r.event === 'tool_call' || r.event === 'tool_result')) {
      const own = r.event === 'tool_result' && r.result && typeof r.result.ok === 'boolean' ? r.result.ok : null;
      const isRequest = r.via === 'import' && r.event === 'tool_call';
      const found = [];
      if (typeof r.input.command === 'string' && r.input.command) found.push(r.input.command);
      if (Array.isArray(r.input.commands)) for (const c of r.input.commands.slice(0, 20)) if (typeof c === 'string' && c) found.push(c);
      for (const command of found) {
        if (isRequest) {
          const k = `${r.session}\u0000${unwrapCommand(command)}`;
          const n = effectCommands.get(k) || 0;
          // the runtime already reported this exact command: its record is the authoritative one
          if (n > 0) { effectCommands.set(k, n - 1); continue; }
        }
        commands.push(command);
        if (!isTestCommand(command)) continue;
        const res = r.tool_use_id ? results.get(r.tool_use_id) : null;
        const linked = res && res.result && typeof res.result.ok === 'boolean' ? res.result.ok : null;
        tests.push({ command, ok: own !== null ? own : linked, ts: r.ts });
      }
    }
    if ((r.event === 'stop' || r.event === 'session_end') && r.git) git = r.git;
    if (r.event === 'note') notes.push({ ts: r.ts, by: r.agent, text: r.text });
    if (r.event === 'decision') decisions.push({ ts: r.ts, by: r.by ?? r.agent, decision: r.decision, note: r.note ?? null, packet_sha256: r.packet_sha256 ?? null, via: r.via ?? null, seq: r.seq });
  }
  // Records in the same sessions that this packet does NOT cover (other UoW or no tag) — review 120 N7.
  const sessionIds = new Set(sessions.keys());
  const untagged = all.filter((r) => r.uow !== uow && r.session && sessionIds.has(r.session));
  // Imported records (UOW-124) are derived from a log the agent wrote, not observed while it acted.
  // A packet must never let them pass for first-hand evidence, so they are counted and the agents named.
  const imported = scoped.filter((r) => r.via === 'import');
  const agents = [...new Set(scoped.map((r) => r.agent).filter((a) => typeof a === 'string' && a))].sort();
  return {
    uow,
    records: scoped.length,
    imported_records: imported.length,
    agents,
    anomalies,
    files_truncated: filesTruncated,
    sessions: [...sessions.values()].map((s) => ({ ...s, writers: [...s.writers], calls: Object.values(s.tools).reduce((a, b) => a + b, 0) })),
    files: [...files.values()],
    commands,
    tests,
    git,
    notes,
    decisions,
    untagged: { records: untagged.length, writes: untagged.filter((r) => r.event === 'tool_call' && r.input && r.input.content_sha256).length },
  };
}

/** Resolve a recorded path against the CURRENT repo root: relative paths as recorded; absolute paths first re-based from the recording cwd (repo may have moved or been cloned), then as-is. */
export function locateFile(root, f) {
  if (!path.isAbsolute(f.path)) return path.resolve(root, f.path);
  if (f.cwd) {
    const rel = path.relative(f.cwd, f.path);
    if (rel && !rel.startsWith('..') && !path.isAbsolute(rel)) {
      const candidate = path.resolve(root, rel);
      if (fs.existsSync(candidate)) return candidate;
    }
  }
  return f.path;
}

/** Compare each recorded write with the file on disk now. */
export function reconcileDisk(root, files) {
  return files.map((f) => {
    if (f.outside) return { ...f, disk: 'outside', disk_sha256: null };
    if (f.kind !== 'write') return { ...f, disk: 'edit-only', disk_sha256: null };
    const abs = locateFile(root, f);
    let text;
    try { text = fs.readFileSync(abs, 'utf8'); } catch { return { ...f, disk: 'missing', disk_sha256: null }; }
    const now = sha256(text);
    if (now === f.sha256) return { ...f, disk: 'matches', disk_sha256: now };
    if (sha256(text.replace(/\r\n/g, '\n')) === f.sha256 || sha256(text.replace(/\r?\n/g, '\r\n')) === f.sha256) return { ...f, disk: 'matches-eol', disk_sha256: now };
    return { ...f, disk: 'changed-after', disk_sha256: now };
  });
}

// ---- packet -------------------------------------------------------------------------------

export function buildPacket({ root, records, verification, uow, decision = null, by = null, note = null, via = 'human', ac = null, acPath = null, now = new Date() }) {
  const c = collectUow(records, uow);
  const files = reconcileDisk(root, c.files);
  const warnings = [];
  if (c.records === 0) warnings.push('no-records');
  if (verification.dropped) warnings.push('dropped');
  if (verification.anomalies) warnings.push('anomalies');
  if (files.some((f) => f.disk === 'changed-after')) warnings.push('changed-after');
  if (files.some((f) => f.disk === 'missing')) warnings.push('missing');
  if (files.some((f) => f.disk === 'outside')) warnings.push('outside-repo');
  if (c.untagged.records) warnings.push('untagged-records');
  let acByAgent = false;
  if (acPath) {
    const target = path.resolve(root, acPath);
    acByAgent = c.files.some((f) => path.resolve(locateFile(root, f)) === target);
    if (acByAgent) warnings.push('ac-written-by-agent');
  }
  if (decision && via === 'agent-session') warnings.push('agent-session-decision');
  if (c.imported_records) warnings.push('imported-records');
  return {
    v: 1,
    uow,
    generated_at: now.toISOString(),
    repository: root,
    repository_name: path.basename(root),
    draft: !decision,
    decision: decision ? { decision, by: by || 'human', note: note || null, at: now.toISOString(), via } : null,
    chain: {
      ok: verification.ok,
      records: verification.count,
      heads: (verification.chains || []).map((ch) => ({ writer: ch.writer || 'legacy', count: ch.count, last: ch.last })),
      dropped: verification.dropped || 0,
      anomalies: verification.anomalies || 0,
      // UOW-123: the committed witness, if any. `latest` is what a reader elsewhere can check.
      anchors: verification.anchors
        ? { ok: verification.anchors.ok, used: verification.anchors.used, bad: verification.anchors.bad, latest: verification.anchors.latest }
        : { ok: true, used: 0, bad: 0, latest: null },
    },
    records_in_scope: c.records,
    files_truncated: c.files_truncated,
    imported_records: c.imported_records,
    agents: c.agents,
    untagged: c.untagged,
    sessions: c.sessions.map(({ tools, ...s }) => ({ ...s, tools })),
    files: files.map(({ cwd: _c, ...f }) => f),
    commands: c.commands,
    tests: c.tests,
    git: c.git,
    notes: c.notes,
    prior_decisions: c.decisions,
    acceptance_criteria: ac,
    acceptance_criteria_path: acPath,
    acceptance_criteria_written_by_agent: acByAgent,
    warnings,
  };
}

export function renderPacket(pkg, lang = 'en') {
  const t = labeller(lang);
  const out = [];
  let statusLine;
  if (pkg.draft) {
    const last = pkg.prior_decisions[pkg.prior_decisions.length - 1];
    statusLine = last
      ? `**${t('draftPrior')}: ${t(last.decision) || cell(last.decision, 20)}** — ${t('by')}: **${cell(last.by, 80)}** · ${t('at')}: ${cell(last.ts, 30)} · ${code(String(last.packet_sha256 || '').slice(0, 16) + '…')}`
      : `**${t('draft')}**`;
  } else {
    statusLine = `**${t(pkg.decision.decision)}** — ${t('by')}: **${cell(pkg.decision.by, 80)}** · ${t('at')}: ${cell(pkg.decision.at, 30)} · ${t('via')}: ${pkg.decision.via === 'agent-session' ? '⚠ ' + t('viaAgent') : t('viaHuman')}`;
  }
  out.push(`# ${t('title')} — ${cell(pkg.uow, 40)}`);
  out.push('');
  out.push(`- **${t('status')}:** ${statusLine}`);
  out.push(`- **${t('generated')}:** ${cell(pkg.generated_at, 30)}`);
  out.push(`- **${t('repo')}:** ${code(pkg.repository_name || path.basename(pkg.repository), 120)}`);
  out.push(`- **${t('uow')}:** ${code(pkg.uow, 40)}`);
  const heads = pkg.chain.heads.map((h) => `${code(h.writer, 60)} ${h.count} → ${code(String(h.last).slice(0, 16) + '…')}`).join(', ');
  out.push(`- **${t('chain')}:** ${pkg.chain.ok ? '✅ ' + t('intact') : '❌ ' + t('broken')} — ${pkg.chain.records} ${t('records')}; ${t('heads')}: ${heads || '—'}`);
  const anc = pkg.chain.anchors;
  if (anc && anc.used && anc.latest) {
    const g = anc.latest.git && anc.latest.git.commit ? ` · git ${code(String(anc.latest.git.commit).slice(0, 8))}` : '';
    out.push(`- **${t('anchored')}:** ${cell(anc.latest.ts, 30)} ${t('anchoredAt')} ${anc.latest.records} ${t('anchorRecords')}${g}`);
  } else {
    out.push(`- **${t('anchored')}:** ⚠ ${t('notAnchored')}`);
  }
  if (pkg.chain.dropped) out.push(`- ⚠ **${t('warnDropped')}**: ${pkg.chain.dropped}`);
  if (pkg.chain.anomalies) out.push(`- ⚠ **${t('warnAnomaly')}**: ${pkg.chain.anomalies}`);
  if (pkg.records_in_scope === 0) out.push(`- ⚠ **${t('warnNoRecords')}**`);
  if (pkg.untagged && pkg.untagged.records) out.push(`- ⚠ **${pkg.untagged.records} ${t('warnUntagged')}** (${pkg.untagged.writes} ${t('warnUntaggedWrites')})`);
  if (pkg.files.some((f) => f.disk === 'outside')) out.push(`- ⚠ **${pkg.files.filter((f) => f.disk === 'outside').length} ${t('warnOutside')}**`);
  if (pkg.agents && pkg.agents.length) out.push(`- **${t('agents')}:** ${pkg.agents.map((a) => code(a, 40)).join(', ')}`);
  if (pkg.imported_records) out.push(`- ⚠ **${pkg.imported_records} ${t('warnImported')}**`);
  if (!pkg.draft && pkg.decision.via === 'agent-session') out.push(`- ⚠ **${t('warnAgentDecision')}**`);
  out.push('');

  out.push(`## ${t('ac')}`);
  out.push('');
  if (pkg.acceptance_criteria_written_by_agent) out.push(`⚠ **${t('warnAcAgent')}**`), out.push('');
  out.push(pkg.acceptance_criteria ? quoted(pkg.acceptance_criteria) : `_${t('acNone')}_`);
  out.push('');

  out.push(`## ${t('sessions')}`);
  out.push('');
  if (pkg.sessions.length === 0) out.push(`_${t('warnNoRecords')}._`);
  else {
    out.push(`| ${t('session')} | ${t('start')} | ${t('end')} | ${t('toolCalls')} | ${t('failures')} | ${t('writer')} |`);
    out.push('|---|---|---|---|---|---|');
    for (const s of pkg.sessions) {
      const tools = Object.entries(s.tools).sort((a, b) => b[1] - a[1]).map(([k, v]) => `${cell(k, 30)} ×${v}`).join(', ');
      out.push(`| ${code(String(s.session).slice(0, 12), 12)} | ${cell(s.first, 30)} | ${cell(s.last, 30)} | ${s.calls} (${tools || '—'}) | ${s.failures} | ${s.writers.map((w) => code(w, 60)).join(', ') || '—'} |`);
    }
  }
  out.push('');

  out.push(`## ${t('files')}`);
  out.push('');
  if (pkg.files.length === 0) out.push(`_${t('filesNone')}_`);
  else {
    const diskLabel = { matches: '✅ ' + t('diskMatches'), 'matches-eol': '✅ ' + t('diskMatchesEol'), 'changed-after': '⚠ ' + t('diskChanged'), missing: '❌ ' + t('diskMissing'), 'edit-only': '· ' + t('diskEditOnly'), outside: '⚠ ' + t('diskOutside') };
    out.push(`| ${t('file')} | ${t('kind')} | ${t('recorded')} | ${t('disk')} |`);
    out.push('|---|---|---|---|');
    // An update or a delete has no full-file hash to show; an empty cell is honest, "null…" is not.
    for (const f of pkg.files) out.push(`| ${code(f.path, 300)} | ${cell(f.kind, 10)} | ${f.sha256 ? code(String(f.sha256).slice(0, 16) + '…') : '—'} | ${diskLabel[f.disk] || cell(f.disk, 30)} |`);
    if (pkg.files_truncated) out.push('', `⚠ **${pkg.files_truncated} ${t('warnTruncatedFiles')}**`);
  }
  out.push('');

  out.push(`## ${t('tests')}`);
  out.push('');
  if (pkg.tests.length === 0) out.push(`_${t('testsNone')}_`);
  else {
    out.push(`| ${t('test')} | ${t('result')} |`);
    out.push('|---|---|');
    for (const x of pkg.tests) out.push(`| ${code(String(x.command).split(/\r?\n/)[0], 160)} | ${x.ok === true ? '✅ ' + t('ok') : x.ok === false ? '❌ ' + t('failed') : '· ' + t('unknown')} |`);
    out.push('');
    out.push(`_${t('testsNote')}_`);
  }
  out.push('');

  out.push(`## ${t('commands')} (${pkg.commands.length})`);
  out.push('');
  for (const cmd of pkg.commands.slice(0, 30)) out.push('- ' + code(String(cmd).split(/\r?\n/)[0], 160));
  if (pkg.commands.length > 30) out.push(`- _${pkg.commands.length - 30} ${t('commandsMore')}_`);
  if (pkg.commands.length === 0) out.push('_—_');
  out.push('');

  out.push(`## ${t('git')}`);
  out.push('');
  if (pkg.git) out.push(`${code(pkg.git.branch ?? '?', 80)} @ ${code(pkg.git.head ?? 'no commits')} — ${Number(pkg.git.files_changed) || 0} files changed, +${Number(pkg.git.insertions) || 0} −${Number(pkg.git.deletions) || 0}, ${Number(pkg.git.dirty_paths) || 0} dirty paths`);
  else out.push(`_${t('gitNone')}_`);
  out.push('');

  out.push(`## ${t('notes')}`);
  out.push('');
  if (pkg.notes.length === 0 && pkg.prior_decisions.length === 0) out.push(`_${t('notesNone')}_`);
  for (const n of pkg.notes) out.push(`- ${cell(n.ts, 30)} **${cell(n.by, 80)}**: ${cell(n.text, 500)}`);
  for (const d of pkg.prior_decisions) out.push(`- ${cell(d.ts, 30)} **${cell(d.by, 80)}** → **${cell(d.decision, 20)}**${d.via === 'agent-session' ? ' ⚠ ' + t('viaAgent') : ''}${d.note ? ': ' + cell(d.note, 300) : ''} (${code(String(d.packet_sha256 || '').slice(0, 16) + '…')})`);
  out.push('');

  out.push(`## ${t('decision')}`);
  out.push('');
  if (pkg.draft) out.push(`_${t('draft')}._`);
  else {
    out.push(`- **${t('decision')}:** ${t(pkg.decision.decision)}`);
    out.push(`- **${t('by')}:** ${cell(pkg.decision.by, 80)}`);
    out.push(`- **${t('at')}:** ${cell(pkg.decision.at, 30)}`);
    out.push(`- **${t('via')}:** ${pkg.decision.via === 'agent-session' ? '⚠ ' + t('viaAgent') : t('viaHuman')}`);
    if (pkg.decision.note) out.push(`- **${t('note')}:** ${cell(pkg.decision.note, 1000)}`);
    out.push('');
    out.push(`_${t('decisionSealed')}_`);
  }
  out.push('');

  out.push(`## ${t('howto')}`);
  out.push('');
  out.push(`1. ${t('howto1')}`);
  out.push(`2. ${t('howto2')}`);
  out.push(`3. ${t('howto3')}`);
  out.push('');
  out.push('---');
  const body = out.join('\n') + '\n';
  return `${body}Hash: ${sha256(body)}\n`;
}

const HASH_LINE_RE = /^Hash: ([0-9a-f]{64})\s*$/m;

/** Recompute the footer hash of a packet. */
export function checkPacket(md) {
  const lf = String(md).replace(/\r\n/g, '\n');
  const m = lf.match(HASH_LINE_RE);
  if (!m) return { ok: false, reason: 'no Hash: footer' };
  const body = lf.slice(0, lf.lastIndexOf(`Hash: ${m[1]}`));
  const actual = sha256(body);
  return { ok: actual === m[1], expected: m[1], actual, body };
}

/**
 * The exact text a signature covers (UOW-127): everything above the `Hash:` footer, CRLF
 * normalised. Signing this rather than the hash string binds the signature to the whole packet,
 * and it is the same text `--check` already recomputes, so the signature and the footer can never
 * disagree about what they cover.
 */
/**
 * The signatures a packet carries in itself (UOW-127, review R P2/3e).
 *
 * `--check` used to find the signature only by looking up a decision RECORD whose hash matches the
 * file. An attacker who edits the body and recomputes the `Hash:` footer breaks that lookup, so the
 * signature was never consulted and the file passed with "NOT SEALED". A signed document has to be
 * checkable on its own: the blocks below the footer are read straight out of the file.
 */
export function parsePacketSignatures(md) {
  const text = String(md ?? '').replace(/\r\n/g, '\n');
  const out = [];
  // Every captured field is UNTRUSTED: this header sits BELOW the `Hash:` footer, so neither the
  // footer nor the signature covers it. `[^,\n]` keeps a field from swallowing newlines and
  // smuggling extra lines into anything that prints it.
  const re = /^Signature \(([^,\n]{1,60}), ([^,\n]{1,120}), key ([^,\n]{1,120}), namespace ([^)\n]{1,40})\):\n(-----BEGIN SSH SIGNATURE-----[\s\S]*?-----END SSH SIGNATURE-----)/gm;
  for (const m of text.matchAll(re)) {
    // `declared: true` marks these as what the FILE says, not what anyone checked.
    out.push({ declared: true, alg: m[1].trim(), identity: m[2].trim(), key_fingerprint: m[3].trim(), namespace: m[4].trim(), blob: m[5] + '\n' });
  }
  return out;
}

export function packetBody(md) {
  const c = checkPacket(md);
  return typeof c.body === 'string' ? c.body : null;
}

/** Find the decision record(s) that sealed this packet text: by file sha256 (exact) or by body hash (survives EOL changes). */
export function findSealing(records, text) {
  const fileSha = sha256(String(text));
  const footer = checkPacket(text);
  return records.filter((r) => Number.isInteger(r.seq) && r.event === 'decision' && (r.packet_sha256 === fileSha || r.json_sha256 === fileSha || (footer.ok && r.packet_body_sha256 === footer.expected)));
}
