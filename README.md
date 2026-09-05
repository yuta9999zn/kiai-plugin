# kiai — a black box for AI coding agents

**KIAI does not replace Claude Code, Cursor or Codex. It turns any AI coding agent into a team you can
hold accountable.** This plugin is the first piece: a flight recorder. Every session start, tool call,
tool result and stop is appended to an **append-only, hash-chained** log inside your repository. You can
verify it, and you can turn it into an evidence report for a code review or a client acceptance.

- Zero dependencies. Node ≥ 18 (you already have it if you run Claude Code).
- Hooks **never block the agent**: if recording fails, the failure is logged and the agent continues.
- Records hold **references and hashes, not contents**: a file write is stored as path + sha256; shell
  commands are stored with common key/token/password shapes redacted (best effort, see below).
- Works on any repo, with or without the rest of KIAI. Tested against a real Claude Code session.

## Install in 10 minutes

**As a Claude Code plugin (recommended):**

```bash
claude plugin marketplace add yuta9999zn/kiai-plugin     # once per machine
claude plugin install kiai@kiai                          # or: /plugin install kiai@kiai inside Claude Code
```

Hooks are active in every Claude Code session from then on; `.kiai/` is created in a repo the first time a
hook fires there. The CLI lives in the installed plugin folder (`claude plugin list` shows the path).

**From a checkout (no marketplace):**

```bash
git clone https://github.com/yuta9999zn/kiai-plugin.git
cd your-repo
node /path/to/kiai-plugin/bin/kiai.mjs init              # creates .kiai/ (idempotent)
claude --plugin-dir /path/to/kiai-plugin                 # start Claude Code with the black box on
```

Prefer hooks in the repo itself? `node /path/to/kiai-plugin/bin/kiai.mjs hooks` prints a `hooks` block with
absolute paths; paste it into the project's `.claude/settings.json`. All paths run the same `record` command.

## After a session

```bash
node /path/to/kiai-plugin/bin/kiai.mjs verify            # OK — 57 records, head 3f9a…   (exit 1 if broken)
node /path/to/kiai-plugin/bin/kiai.mjs report            # Markdown evidence for all sessions
node /path/to/kiai-plugin/bin/kiai.mjs report --uow UOW-119 --out evidence-UOW-119.md
node /path/to/kiai-plugin/bin/kiai.mjs report --since 2026-09-01 --json
node /path/to/kiai-plugin/bin/kiai.mjs note "GATE 3 approved, 2 follow-ups" --by tech-lead
node /path/to/kiai-plugin/bin/kiai.mjs status
node /path/to/kiai-plugin/bin/kiai.mjs accept --uow UOW-119 --decision approve --by "tech lead"   # acceptance packet, see below
```

A report looks like this (from the real probe run on Claude Code 2.1.261, 2026-09-05):

```
# KIAI flight report — all records
- Chain: ✅ intact (5 records, head `5431e8ee1231d49c…`)
| Session | UoW | Start (UTC) | End (UTC) | Tool calls | Failures | Files written |
| `9f1c…` | UOW-119 | 2026-09-05T… | 2026-09-05T… | 1 | 0 | 0 |
## Session `9f1c…`
- Tools: Bash ×1
- Writer: `hideki-085e4e`
- Git at stop: `bolt/UOW-119` @ `no commits` — 0 files changed, +0 −0, 1 dirty paths
- Shell commands: `echo kiai-probe-ok`
```

## Acceptance packet — what you sign when you accept AI-written code

```bash
node /path/to/kiai-plugin/bin/kiai.mjs accept --uow UOW-123                       # DRAFT: read it before deciding
node /path/to/kiai-plugin/bin/kiai.mjs accept --uow UOW-123 --decision approve --by "Jane Lead" --note "2 follow-ups" --ac criteria.md --lang both
node /path/to/kiai-plugin/bin/kiai.mjs accept --check acceptance-UOW-123.md       # anyone can recheck the footer hash
```

`kiai accept` builds an acceptance packet (`.md` + `.json` with the same fields) from the flight record of one
unit of work: the sessions, every file the agent wrote with its recorded sha256 **and whether the file on disk
still matches it** (`matches` / `matches (line endings differ)` / `CHANGED after` / `MISSING` / `edit-only` /
`outside the repository`), the test commands that ran, the shell commands, the git state at stop, notes, records
in the same sessions that carry no UoW tag, and the acceptance criteria you pass with `--ac` (or keep in
`.kiai/ac/<UoW>.md` — if the agent itself wrote that file, the packet says so). The file ends with
`Hash: sha256(everything above)`. Paths are stored relative to the repository, so a clone or a moved checkout
reconciles the same way. `--lang vi` or `--lang both` labels the packet in Vietnamese / bilingual.

Without `--decision` you get `acceptance-<UoW>.draft.md`; with it you get `acceptance-<UoW>.md`, and the decision
is sealed into the flight record as a `decision` record carrying the sha256 of the packet file, of its body and of
the `.json`, so the packet and the chain vouch for each other. The decision record is written **before** the packet
lands on disk: if the chain cannot be written, no packet exists. A later draft never overwrites a sealed packet; a
later decision keeps the previous one as `acceptance-<UoW>.prev-<sha8>.md`. `--check` recomputes the footer and,
run inside the repository, prints the `decision` record that sealed the file (or `NOT SEALED`).

Decisions are for humans. Inside an agent session (Claude Code sets `CLAUDECODE`) `accept --decision` is refused;
`KIAI_ALLOW_AGENT_DECISION=1` lets it through, and then the record, the packet and `--check` all say
"recorded via agent session". This is an environment check, not a cryptographic signature (planned).

Honesty notes: hooks carry no exit code, so a test command shows **"completed (not interrupted, no error
reported)"**, never "passed"; a command that Claude Code reports as failed shows "interrupted / error reported".
`Edit` and `NotebookEdit` records hash only the edited fragment, so those files show `edit-only` rather than a disk
comparison. `accept` refuses to produce a packet on a broken chain, and refuses a `--decision` when the unit of
work has no records.

## What a record is

One JSON object per line in `.kiai/flight/<writer>/YYYY-MM-DD.jsonl`:

```json
{"v":1,"writer":"hideki-085e4e","ts":"2026-09-05T…Z","event":"tool_call","agent":"claude-code",
 "session":"9f1c…","cwd":"…","uow":"UOW-119","tool":"Bash","tool_use_id":"toolu_…",
 "input":{"command":"echo kiai-probe-ok","description":"…"},
 "seq":2,"prev":"<hash of record 1>","hash":"<sha256>"}
```

`hash = sha256(prev + "\n" + canonical(record without hash))`, `hash_0 = sha256("kiai-flight-v1")`.

**Writers.** A *writer* is one machine × one working tree (`<host>-<6 hex>`, override with `KIAI_WRITER`).
Each writer has its own chain, so two clones or two git worktrees never append to the same file: `git pull`
never conflicts and never breaks a chain. `verify` and `report` check and merge every chain under
`.kiai/flight/`. Concurrent sessions in one working tree share a writer and are serialized by a lock.

**Events:** `session_start` · `tool_call` · `tool_result` · `stop` · `subagent_stop` · `session_end` · `note`
(7 Claude Code hooks: SessionStart, PreToolUse, PostToolUse, PostToolUseFailure, Stop, SubagentStop, SessionEnd).
The UoW id comes from `KIAI_UOW`, then `.kiai/current`, then a branch named `bolt/UOW-123`; otherwise `null`.

Commit `.kiai/flight/**/*.jsonl` with your code: evidence travels with the change. `chain.json`, the lock and
`errors.log` are ignored via `.kiai/.gitignore`.

## What `verify` proves, and what it does not

`verify` recomputes every chain and names the first broken record. It catches: any changed byte in any record,
a deleted or reordered record in the middle, a duplicated or skipped `seq`. Each machine also keeps a local
witness (`chain.json`, not committed) of the last head it wrote, so on that machine `verify` also catches a
**truncated or rewritten tail**; if a hook finds the files and the witness disagree, it seals that fact into
the next record as an `anomaly`, which then cannot be removed without breaking the chain.

It does **not** catch a tail truncated *on another machine* before the files were committed, nor a chain
rewritten from record *k* onward with this very tool on a machine that holds no witness. An unanchored hash
chain proves internal consistency, not completeness. **Anchor the head**: commit the `.jsonl` files (git
history becomes the witness), and paste the head from `verify` into the PR or the acceptance note.

If a hook cannot take the lock within 8 s (hooks time out at 10 s), the record is written unsealed to
`dropped.jsonl` and `verify`/`report` say so: the chain is intact but **the log is incomplete**, and you can see
exactly what was dropped.

## What it does not record, and redaction limits

Model name and token cost (Claude Code does not expose them to hooks), file contents, the agent's reasoning.
Redaction is regex based and covers common shapes (OpenAI/Anthropic/Stripe/GitHub/GitLab/Slack/Google/npm/
Hugging Face/SendGrid/Twilio keys, AWS ids, `Bearer`/`Basic` headers, `user:pass@` URLs, `-p`/`-u`/`--password`
flags, `*password*=`/`*secret*=`/`*token*=`/`*key*=` assignments and JSON fields, PEM private keys). It cannot be
complete: **do not paste secrets into shell commands, and review `.kiai/flight` before pushing.**

Cursor and Codex hooks are not wired in this version: `record` accepts any JSON with `hook_event_name`,
`tool_name`, `tool_input`, so any hook system can call it, but that path has not been tested against a real client.

## Development

```bash
cd kiai-plugin && npm test      # node --test, offline, ~8 s, 42 tests (v0.2.0)
```

MIT © 2026 Nguyen Truong An. Part of [KIAI](https://github.com/yuta9999zn/KIAI).
