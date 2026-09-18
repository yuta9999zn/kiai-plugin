# kiai — a black box for AI coding agents

**KIAI does not replace Claude Code, Cursor or Codex. It turns any AI coding agent into a team you can
hold accountable.** This plugin is the first piece: a flight recorder. Every session start, tool call,
tool result and stop is appended to an **append-only, hash-chained** log inside your repository. You can
verify it, and you can turn it into an evidence report for a code review or a client acceptance.

- Zero dependencies. Node ≥ 18 (you already have it if you run Claude Code).
- Hooks **never block the agent**: if recording fails, the failure is logged and the agent continues.
- Records hold **references and hashes, not contents**: a file write is stored as path + sha256; shell
  commands are stored with common key/token/password shapes redacted (best effort, see below).
- Works on any repo, with or without the rest of KIAI.
- A human's approval can be **signed** with an SSH key you already have, verified offline
  ([Signing](#signing--who-actually-approved-this)).

### Which agents, and how well

| Agent | How KIAI records it | Strength of the evidence | Measured against |
|---|---|---|---|
| **Claude Code** | hooks, live, while the agent works | first-hand: each record is written before the agent's next step | real sessions, Claude Code 2.1.260 / 2.1.261; marketplace install on a clean machine |
| **Any model with a shell** — Qwen, Llama, GPT, LM Studio, vLLM, OpenAI-compatible | `kiai wrap` around every command the model asks for: record → rules → run → record | first-hand, **and** a `block` rule refuses the command before it runs | `qwen2.5:7b` behind Ollama, 2026-09-18: `git reset --hard` refused, 6 records, verify green |
| **Codex CLI** | `kiai import codex`, after the fact, from the session log Codex writes anyway | **weaker** — read back from a file the agent itself wrote; nothing is blocked; see [What `import` proves](#what-import-proves-and-what-it-does-not) | end to end on live `codex exec` runs of **0.153.4**; 85 real rollouts, idempotent |
| **Cursor** | a hook translator (`adapters/cursor/`) that fails safe | **half measured** — Cursor 3.19.7 loads the hooks and the translator reads the payload shape taken from Cursor's own bundle; not yet seen firing in a live agent turn | Cursor 3.19.7, 2026-09-19: `Loaded 4 project hook(s)` in its hooks log; TS-130-17 on the code-derived payload. Firing needs a signed-in account (§ below) |

Codex has its own hook engine, and it looks close enough to Claude's to reuse: `hooks` is a stable feature
in Codex CLI 0.153.4 and its hook payload carries the same field names (`session_id`, `cwd`,
`hook_event_name`, `tool_name`, `tool_input`, `tool_use_id`, …). But **we have not managed to make a Codex
hook fire**, so this package does not claim hook support for Codex. `kiai hooks --agent codex` prints the
block we believe is correct with that warning attached. Details in [Codex CLI](#codex-cli).

## Pick your agent — what to run, step by step

Whatever the agent, the repository needs the black box **once** (`init` creates `.kiai/` and seeds the
26 starter rules; commit it, it is the repository's data):

```bash
git clone https://github.com/yuta9999zn/kiai-plugin ~/kiai-plugin    # or the marketplace install below; no npm install, zero dependencies
cd your-repo && node ~/kiai-plugin/bin/kiai.mjs init && git add .kiai && git commit -m "kiai: black box + rules"
```

Then one of these. `kiai` below means `node ~/kiai-plugin/bin/kiai.mjs` (alias it, or use the plugin's cache path).

| You use | Do this | Then check |
|---|---|---|
| **Claude Code** | `claude plugin marketplace add yuta9999zn/kiai-plugin` · `claude plugin install kiai@kiai` — hooks are on in every session from then on. Want rules to **block** and not only record? `kiai hooks --rules > .claude/settings.json` | do one small task, then `kiai status` → `records > 0` |
| **Qwen / Llama / any model** (Ollama, LM Studio, vLLM, OpenAI-compatible) | run the model through a harness that executes every command as `kiai wrap --tool Bash --session <id> -- <command>`. Reference harness, ~100 lines, zero deps: `OLLAMA_MODEL=qwen2.5:7b node ~/kiai-plugin/adapters/ollama/harness.mjs "…"`. Other endpoint: copy it, change the `fetch`, keep `runThroughKiai` | ask the model for `git reset --hard` → `BLOCKED BY safety/…`, exit 2, not run; `kiai verify` green |
| **Codex CLI** | after each session (or cron): `kiai import codex` — reads the rollouts Codex already writes; idempotent. Nothing is blocked (it happens after the fact); for a gate, drive Codex through `kiai wrap` like any model | `kiai import codex --dry-run` shows what it sees; `kiai verify` |
| **Cursor** | `kiai hooks --agent cursor > .cursor/hooks.json` (prints a HALF MEASURED warning on purpose: Cursor 3.19.7 loads it, a live fire is still unseen). The translator always answers `allow` except on a `block` rule, and never exits ≠ 0 | run a session, `kiai status`; no records → `KIAI_CURSOR_DEBUG=1` prints the payload on stderr — send one redacted payload back and the mapping gets fixed |

Update: `claude plugin update kiai@kiai` or `git -C ~/kiai-plugin pull`; new rules without overwriting yours: `kiai rules install`
(`--force` to take the plugin's copy); broken rule after a hand edit: `kiai rules lint` names the file. Uninstall: `claude plugin uninstall kiai@kiai`
or delete the clone — `.kiai/` stays, it is yours. Full walkthrough per agent, in Vietnamese: **[docs/HANDOFF.md](docs/HANDOFF.md)**;
each adapter has its own README: [`adapters/generic/`](adapters/generic/README.md), [`adapters/ollama/`](adapters/ollama/README.md),
[`adapters/codex/`](adapters/codex/README.md), [`adapters/cursor/`](adapters/cursor/README.md).
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
node /path/to/kiai-plugin/bin/kiai.mjs anchor --by "Jane Lead"                                # witness today's heads, then COMMIT .kiai/anchors.jsonl
node /path/to/kiai-plugin/bin/kiai.mjs accept --check .kiai/acceptance/acceptance-UOW-123.md   # anyone can recheck the footer hash
node /path/to/kiai-plugin/bin/kiai.mjs accept --check .kiai/acceptance/acceptance-UOW-123.json # the .json (what a dashboard reads) must be sealed too
```

`kiai accept` builds an acceptance packet (`.md` + `.json` with the same fields) from the flight record of one
unit of work: the sessions, every file the agent wrote with its recorded sha256 **and whether the file on disk
still matches it** (`matches` / `matches (line endings differ)` / `CHANGED after` / `MISSING` / `edit-only` /
`outside the repository`), the test commands that ran, the shell commands, the git state at stop, notes, records
in the same sessions that carry no UoW tag, and the acceptance criteria you pass with `--ac` (or keep in
`.kiai/ac/<UoW>.md` — if the agent itself wrote that file, the packet says so). The file ends with
`Hash: sha256(everything above)`. Paths are stored relative to the repository, so a clone or a moved checkout
reconciles the same way. `--lang vi` or `--lang both` labels the packet in Vietnamese / bilingual.

Packets land in `.kiai/acceptance/` by default (`--out DIR` overrides) so they travel with the code and KIAI Monitor can list them (v0.2.0 wrote them into the current directory — move old packets into `.kiai/acceptance/` if you want them listed; a directory without `.kiai/` still gets the packet next to you, `accept` never creates a black box by itself). Without `--decision` you get `acceptance-<UoW>.draft.md`; with it you get `acceptance-<UoW>.md`, and the decision
is sealed into the flight record as a `decision` record carrying the sha256 of the packet file, of its body and of
the `.json`, so the packet and the chain vouch for each other. The decision record is written **before** the packet
lands on disk: if the chain cannot be written, no packet exists. A later draft never overwrites a sealed packet; a
later decision keeps the previous one as `acceptance-<UoW>.prev-<sha8>.md`. `--check` recomputes the footer and,
run inside the repository, prints the `decision` record that sealed the file (or `NOT SEALED`).

Decisions are for humans. Inside an agent session (Claude Code sets `CLAUDECODE`) `accept --decision` is refused;
`KIAI_ALLOW_AGENT_DECISION=1` lets it through, and then the record, the packet and `--check` all say
"recorded via agent session". That is an environment check, and an environment check is worth what an
environment variable is worth. Add `--sign` and the decision is bound to a key instead — see
[Signing](#signing--who-actually-approved-this).

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

## Codex CLI

Codex writes a full log of every session to `$CODEX_HOME/sessions/YYYY/MM/DD/rollout-*.jsonl` whether or
not you ask it to. `kiai import codex` reads those logs and appends KIAI records for the sessions that ran
**in this repository**:

```bash
node /path/to/kiai-plugin/bin/kiai.mjs init                 # once per repo
node /path/to/kiai-plugin/bin/kiai.mjs import codex --dry-run   # see what it would take
node /path/to/kiai-plugin/bin/kiai.mjs import codex
node /path/to/kiai-plugin/bin/kiai.mjs verify
```

- **Only this repository.** A rollout whose session `cwd` is not inside the repo is skipped and counted,
  never read in, so your Codex work on other projects stays out of this repo's black box. Both sides are
  resolved through symlinks and junctions first, so neither a link inside the repo nor a repo reached
  *through* a link changes the answer. Two limits to know: a repository **nested inside** this one counts
  as inside, and `--session FILE` forces one specific file — every record it produces is then flagged
  `cwd_outside_root`.
- **Its own chain.** Imported records go to the writer `<writer>-codex`, never into the chain your hooks
  write. `verify`, `anchor` and `status` treat it as one more writer; `status` says how many of its
  records were imported.
- **Re-runnable.** A second import writes nothing, and new lines in a log import as exactly those lines —
  including when one Codex session is spread over several rollout files, which is common (8 of the 85
  logs on the machine this was built on, one of them 30 files). The key is the source file plus the line
  number in it, derived from the chain itself, so there is no extra state file to lose or fake.
- **It can stop halfway.** If the chain cannot be written (lock busy, disk full) the import stops there,
  says which file and line it stopped at, and exits 1. What was written is sealed and counted; running it
  again continues from there.
- `--home DIR` points at another `CODEX_HOME`, `--json` prints the full result, and `--since DATE` drops
  whole sessions that *started* before that date — a session that began earlier and ran on past it is
  dropped too.

### What `import` proves — and what it does not

A hook record is written **while the agent acts**, before its next step. An imported record is derived
**afterwards** from a file that the agent — and anyone else with access to the machine — could edit first.

So an imported record proves: *this is what the log said at the moment of import, and nobody has changed it
since.* It does **not** prove: *this is what Codex did.* If the log was edited before the import, KIAI
imports the edit, faithfully and verifiably.

Every imported record says so on its face — `via: "import"` plus `src: { file, sha256, ordinal, kind }` —
`kiai report` prints the count, and an acceptance packet carries it as a warning. Do not present an imported
chain as live observation.

One more thing to expect: **one Codex action can become more than one record.** Codex logs the model's
request (`tool_call`), the runtime's effect (`tool_result` from a `FileChange` or `CommandExecution`) and
the tool's output as separate lines, and KIAI records each line it can read, naming the source in
`src.kind`. That is three facts about one action, not one fact counted three times — the record count is
higher than the number of actions, and the report's "tool calls" column counts records.

An acceptance packet does **not** double-count them: where the runtime reported what it actually ran,
that is the row you get, and the model's request **for that same command** is not listed again. The two
carry ids from different spaces (`call_…` and `exec-…`) so they cannot be paired by id — they are paired
by the command text, with the shell wrapper stripped, and each reported command cancels at most one
request. A command the runtime never reported separately is still listed: it is evidence too.

That stripping matters for more than counting. Codex never runs a command directly — every one of the 996
`CommandExecution` records measured on the build machine looks like `C:\…\pwsh.exe -Command npm test`, none
like `npm test`. The packet sees through `pwsh`/`powershell -Command`, `bash|sh|zsh -c`, and `cmd /c` when
deciding whether a command ran a test suite (`bash.exe`/`sh.exe` too, for Git for Windows); a wrapper
KIAI does not know would make the packet say no test ran.

Two limits worth knowing:

- Codex "code mode" sends JavaScript as the tool input, and **an `apply_patch` call carries the whole new
  file inside that JavaScript**. KIAI never stores that source. It records the hash and size of the code,
  which `tools.*` it called, the commands it ran, and the paths its patch touches (taken from the patch
  envelope, never from the `+` lines). A blob we cannot parse is recorded as `shape: "unrecognised"` — a
  hash and nothing else.
- A patch that **updates** a file carries only a unified diff, so there is no full-file hash to compare
  against disk. Those show as `edit-only` in an acceptance packet; only an **added** file reconciles.
- **A shell command is stored as text, and a command can carry file content.** `cat > f <<EOF …` puts
  that content in the record, because a command is evidence this package has always kept (the same is
  true of Claude Code's `Bash`). What is blocked is file content arriving as *file data*; content the
  agent chose to type into a command line is not, and redaction is the only filter on it.
- **An imported `stop` record carries no git state.** The tree as it is at import time is not the tree as
  it was when Codex stopped, and the log does not say what the latter was — so the record says nothing
  rather than something false. Acceptance packets for an imported unit of work therefore show no git.
- **Long lines are trimmed, and the record says so.** At most 100 changed paths per patch, 50 patch paths
  and 10 commands or tool names per code-mode blob, 2000 characters per command. Whenever a cap bites,
  the record also carries the true total (`files_total`, `commands_total`, `patch_files_total`, and a
  `change: "truncated"` entry) — and the acceptance packet prints one line under the file table saying
  how many paths are not shown, summed over every trimmed record.

### The hook path (not working yet — measured 2026-09-17)

Codex CLI 0.153.4 reports `hooks` as a stable feature, and the hook contract in the shipped binary mirrors
Claude Code's: the events `SessionStart`, `UserPromptSubmit`, `PreToolUse`, `PermissionRequest`,
`PostToolUse`, `PreCompact`, `PostCompact`, `SubagentStart`, `SubagentStop`, `Stop`, `Interrupt`,
`SessionEnd`, and the payload fields `session_id`, `transcript_path`, `cwd`, `hook_event_name`, `tool_name`,
`tool_input`, `tool_use_id`, `permission_mode`, `stop_hook_active`. Codex also gates hooks behind a trust
review ("Hooks can run outside the sandbox after you trust them") with a `--dangerously-bypass-hook-trust`
escape.

We could not get a hook to fire in any of three configurations:

1. `codex -c 'hooks.PreToolUse=[{hooks=[{type="command",command="…"}]}]' exec …`
2. a `.codex/hooks/kiai.json` next to the repository
3. an isolated `CODEX_HOME` whose `config.toml` declared `[[hooks.PreToolUse]]` with
   `bypass_hook_trust = true`

In all three the run completed and the recorder was never called. Until that changes, use `import`.
`kiai hooks --agent codex` prints the block, and prints this warning to stderr while it does.

## Signing — who actually approved this

```bash
node /path/to/kiai-plugin/bin/kiai.mjs signers --add you@example.com --key ~/.ssh/id_ed25519.pub
git add .kiai/allowed_signers && git commit -m "who may approve here"
node /path/to/kiai-plugin/bin/kiai.mjs accept --uow UOW-123 --decision approve --by you@example.com \
     --sign --key ~/.ssh/id_ed25519
node /path/to/kiai-plugin/bin/kiai.mjs accept --check .kiai/acceptance/acceptance-UOW-123.md
node /path/to/kiai-plugin/bin/kiai.mjs verify --require-signature      # the gate for CI
```

Without a signature, "the tech lead approved this" is a line of text that anyone who can set an
environment variable could have written — and the hash chain then makes that line **durable**, which is
worse than making it detectable. `--sign` signs the **packet body** (exactly the text the `Hash:` footer
covers) with an SSH key, using `ssh-keygen -Y`: no new dependency, no new key, and nothing leaves your
machine. `.kiai/allowed_signers` says whose keys count; it is **committed**, so it is reviewed like code
and adding a key is a visible change.

The signature is written **into the packet**, below the `Hash:` footer, and into the companion
`.json`. A signed packet therefore checks out on its own — carry it to another machine, put
`allowed_signers` beside it, and `--check` still answers.

`--check` and `verify` report one of these states, and never guess:

| State | Meaning | exit |
|---|---|---|
| `SIGNED by <identity>` | this packet body was signed by a key `allowed_signers` names, and has not changed since | 0 |
| `UNSIGNED` | no signature at all (an older decision) | 0, or 1 with `--require-signature` |
| `SIGNATURE INVALID` | there is a signature and it does not check out — the body changed, or the signature is corrupt | **1** |
| `SIGNER NOT ALLOWED` | the signature is mathematically fine but the key is not in `allowed_signers` | **1** |
| `SIGNATURE UNCHECKABLE` | there is a signature and the packet it covers is not on disk, so there is nothing to check it against | **1** with `--require-signature`, WARN otherwise |
| `SIGNATURE NOT CHECKED` | there is a signature and it could not be checked here — no `ssh-keygen`, no `allowed_signers` to check against, or a `.json` whose `.md` is missing | **1** with `--require-signature`, WARN otherwise |

The last two exist because a gate must never go green for lack of evidence. An earlier version of
this feature printed `SIGNED` when the signed packet was missing — which made `rm` a way to turn a
*rejected* signature into a passing build. They are **warnings** on their own and **failures** under
`--require-signature`: not knowing is neither a pass nor a forgery, and the report says which it is.

One thing the packet does **not** vouch for: the `Signature (…)` header line itself. It sits below the
footer, so nothing covers it — anyone who can edit the file can write anything there. That is why the
identity printed comes from `allowed_signers` (through `ssh-keygen -Y find-principals`) and the
fingerprint from `ssh-keygen`'s own verification, never from the line in the file.

`--require-signature` also refuses a packet that **neither a decision record nor a signature of its own
vouches for**, and a `.json` checked **outside any repository**: a `Hash:` footer that recomputes proves only that a file is consistent with itself, and
whoever wrote a forged packet wrote its footer too. That is why the first line now reads
`OK (footer only)`.

### What a signature proves — and what it does not

It proves: **this exact packet body was signed by a listed key, and not one byte has changed since.**

It does **not** prove, and the docs will not imply otherwise:

- **It does not stop a compromised agent from doing damage.** It stops a *forged approval*, and it makes
  later tampering visible. Those are different things.
- **It does not prove the signer read what they signed.** A signature is a claim of responsibility, not
  evidence of review.
- **It does not help if the signer's private key or machine is taken.** Then the attacker is the signer.
- **`allowed_signers` lives in the repository**, so anyone who can write the working tree can add a key.
  Since UOW-128 the tool asks the copy in your last commit as well, so a key added to the working copy and
  never reviewed reports `SIGNER NOT REVIEWED` and fails `--require-signature` — see *Against someone who
  can write KIAI's own files* below. That still does not make forgery impossible: a key merged into the
  repository is trusted, so review that file like you review code.
- **One key must have one identity.** `ssh-keygen -Y find-principals` returns the *first* matching line,
  so a line placed above an existing one would make that person's signatures report under a different
  name — a rename with no new key and no new signature. `signers --add` refuses a key that is already
  listed, and `signers --list` prints fingerprints and flags any duplicate key it finds.
- **It is not a transparency log.** There is no public record that a signature ever existed, so a signer
  who controls the repository can remove the evidence. Sigstore/Rekor would add that, at the cost of
  sending data off your machine; it is not enabled here.

### Keys and time

Each signature records its own `alg`, and `sig` is a **list** — a second algorithm is added, not swapped.
That matters: NIST deprecates today's 112-bit classical algorithms in **2030** and disallows them in
**2035**, while an acceptance packet is meant to still mean something years later. When ML-DSA (FIPS 204)
or SLH-DSA (FIPS 205) are available in OpenSSH, a decision can carry both signatures and old history does
not have to be re-signed.

A key with a passphrase cannot be used where there is no prompt (an agent session, CI): signing fails
immediately with that reason rather than hanging, and **nothing is sealed** — a decision that claims to be
signed is always actually signed.

## What `verify` proves, and what it does not

`verify` recomputes every chain and names the first broken record. It catches: any changed byte in any record,
a deleted or reordered record in the middle, a duplicated or skipped `seq`. Each machine also keeps a local
witness (`chain.json`, not committed) of the last head it wrote, so on that machine `verify` also catches a
**truncated or rewritten tail**; if a hook finds the files and the witness disagree, it seals that fact into
the next record as an `anomaly`, which then cannot be removed without breaking the chain.

Without an anchor it does **not** catch a tail truncated *on another machine*, nor a chain rewritten from
record *k* onward with this very tool on a machine that holds no witness: an unanchored hash chain proves
internal consistency, not completeness. It does not catch a tail cut **on this machine** either when the
same hand rewrites `chain.json` — that file has two fields and sits in the working tree. There is no local
check that answers this; `verify --require-anchor` lets CI refuse an unanchored chain instead of pretending.

## Against someone who can write KIAI's own files

An agent writes files — that is its job — and `.kiai/` is a directory like any other. On 2026-09-17 these
attacks were run against the shipped tool, in a throwaway repository, and the results written down before
anything was fixed:

| Attack | Before | Now |
|---|---|---|
| Change one record in the middle of a chain | caught (`BROKEN … tampered`) | caught |
| Cut the tail, then rewrite `chain.json` to agree | **`OK`, exit 0** | **still `OK`, exit 0** — nothing local can see it; `--require-anchor` refuses a chain with no **committed** witness |
| …then run `kiai anchor` yourself, so the cut chain has a witness | — | `--require-anchor` **exit 1**: an uncommitted witness is one the writer can still change |
| …and rewrite the committed `anchors.jsonl` to agree as well, same line count | — | `ANCHOR EVIDENCE MISSING`, **exit 1** |
| Cut the tail after `kiai anchor` + commit | caught (`ANCHOR MISMATCH`) | caught |
| Cut the tail, then delete the **committed** `anchors.jsonl` | **back to `NOT ANCHORED`, exit 0** | `ANCHOR EVIDENCE MISSING`, **exit 1** |
| `signers --add <me> --key <my key>`, then sign | **`SIGNED by cto@example.com`, exit 0** | `SIGNER NOT REVIEWED`, **exit 1** under `--require-signature` |

Two ideas do the work, and both are the same idea: **ask a copy the writer did not control.**

- `verify`, `accept --check` **and `status`** ask git about `.kiai/anchors.jsonl`. Deleting a committed witness is not
  the same fact as never having had one, and only one of them is `NOT ANCHORED`. Anchors are append-only, so
  the first *n* lines on disk must be byte-for-byte the *n* lines in the last commit: fewer lines, a missing
  file, or a **rewritten line** are all reported, with the numbers in the message. Counting lines alone is
  not enough — `anchorHash` is an exported function, so an attacker can write a *valid* anchor line that
  witnesses the shorter chain they just cut, and the count never changes.
- A signature is verified **twice**: once against `.kiai/allowed_signers` on disk, once against
  `git show HEAD:.kiai/allowed_signers`. The second is the copy a human had to merge.

| State | Means | Exit |
|---|---|---|
| `ANCHOR EVIDENCE MISSING` | the committed witness is gone, shorter than the commit, or an existing line was rewritten | **1** always, in `verify` and in `accept --check` |
| `NOT ANCHORED` | there is no witness and there never was | 0 · **1** with `--require-anchor`, which also refuses a witness that is not **committed** |
| `SIGNER NOT REVIEWED` | the signature checks out, but no commit here contains that key | 0 · **1** with `--require-signature` |
| `REVIEW UNCHECKED` | there is no git repository, so no reviewed copy can exist | 0 · **1** with `--require-reviewed-signer` |

The split between the last two is deliberate. Inside a git repository, a key that is not in a commit is a
**definite no** — including when `allowed_signers` was never committed at all, which is the state an agent
that wrote its own key leaves behind. Outside git nothing can be reviewed, and that is a **gap**, not a
forgery: it is reported on the same line as the signature and refused only by the flag that asks for it.
Calling a gap an attack is how a check earns the right to be ignored.

### What this still does not stop

- **An agent that edits `.kiai/` and commits the edit.** Everything above compares the working tree against
  git. An attacker who also writes the history defeats all of it. The answer is a copy the agent cannot
  reach — a push to a remote, an anchor witnessed elsewhere — and that is not built yet.
- **Anything outside `.kiai/`.** Hooks in `.claude/settings.json`, plugins, marketplaces, imported Codex
  rollouts and prompt injection through the log itself were **not** measured. They are not claimed here.

## Anchors — the witness that travels

```bash
node /path/to/kiai-plugin/bin/kiai.mjs anchor --by "Jane Lead" --note "end of sprint 12"
git add .kiai/anchors.jsonl && git commit -m "anchor flight record"     # ← the step that gives it value
```

`kiai anchor` appends one line to `.kiai/anchors.jsonl` — for every chain, how many records it had and what
the record at that count hashed to — and, unlike `chain.json`, **that file is committed**. From then on
`verify` checks every chain against every anchor and fails on:

- **tail truncated since anchor** — a chain now has fewer records than an anchor witnessed (the hole this
  closes: before anchors, a copy without `chain.json` reported `OK` after the last records were deleted);
- **rewritten since anchor** — the record at that seq hashes to something else;
- **writer removed since anchor** — a whole chain directory disappeared.

`accept --decision` writes an anchor automatically, so a sealed acceptance packet and the witness for its
chain travel in the same commit; `verify`, `status` and `accept --check` all print `ANCHORED` / `NOT ANCHORED`
and say whether `anchors.jsonl` is actually committed.

**What an anchor is worth, exactly — and what it is not:** an anchor is a line in a file. It is evidence only
because your git history is; until you commit and push it, it proves no more than `chain.json` does, and the
CLI says so in those words.

What it catches: records removed or rewritten **while a committed anchor that covers them stays in place**.
What it does **not** catch, measured, not assumed:

- **One ordinary commit that deletes the records *and* the anchor line together.** No rebase, no force-push:
  `git commit -m "trim old flight log"` is enough, and everyone who clones afterwards gets a clean `OK` /
  `NOT ANCHORED` with no signal that an anchor ever existed. Only the file's history shows it —
  `git log -p -- .kiai/anchors.jsonl`. Anchors move the cost of hiding work from *nothing* to *a commit that
  says, in the record everyone can read, that the witness was deleted*; they do not make it impossible.
- **A forged anchor.** `hash` is a plain sha256 with no secret, so it catches an *accidental* edit, not a
  deliberate one: anyone who can commit can recompute it. The guarantee is the git history, never the hash.
- **Records written after the last anchor** — those still rest on the machine-local `chain.json`.

So: anchor at the moments that matter (a decision, a release, end of day), let `accept --decision` do it for
you, and when the stakes are real read `git log -p -- .kiai/anchors.jsonl` instead of trusting one `verify`.

An edited anchor line is ignored with a warning (its hash no longer matches), so a *careless* edit can never
make an honest chain look broken. `.kiai/anchors.jsonl` is append-only. The `.gitattributes` in this
repository is this repository's own; to get the same behaviour where you record, add the line yourself to the
`.gitattributes` at the **root of that repository**:

```
.kiai/anchors.jsonl merge=union
```

(A rule inside a nested `.gitattributes` only applies to that directory, so putting it under `kiai-plugin/`
would do nothing for the `.kiai/` at your repository root.) If an older setup ignores all of `.kiai/`, the
anchor can never travel: `verify` says so, and you must drop that `.gitignore` rule (or `git add -f`).

If a hook cannot take the lock within 8 s (hooks time out at 10 s), the record is written unsealed to
`dropped.jsonl` and `verify`/`report` say so: the chain is intact but **the log is incomplete**, and you can see
exactly what was dropped.

## Rules — what the agent works under, as data

`CLAUDE.md` is prose. Prose is honoured only by whoever happens to be reading it, and across UOW-127
and UOW-128 I wrote a lesson down and then broke it anyway, twice, by exactly that mechanism. So the
rules live in `.kiai/rules/*.json`, where a machine can look them up and refuse an action that breaks
one.

```bash
kiai rules list                       # everything, grouped by family, force first
kiai rules list --family safety
kiai rules search "xoá mất việc chưa commit"   # offline, deterministic, vi + en
kiai rules show safety/no-hard-reset-over-uncommitted-work
kiai rules check --tool Bash --command 'git reset -q --hard HEAD~1'   # exit 2
kiai rules lint                       # the gate on the rule files themselves
```

### What a rule carries

| Field | Why it is not optional |
|---|---|
| `id`, `family`, `rank` | precedence is resolved by data, never by file order |
| `modality` | `MUST` and `SHOULD` are different promises |
| `enforcement` | `block` refuses · `warn` says it · `advice` is for reading, enforced by nothing |
| `statement`, `title` | the normative sentence, and a name people can find |
| **`why`** | a rule whose reason is unwritten gets worked around |
| **`source`** | the incident it came from — no rule out of thin air |
| **`applies_when[]`** | conditions the engine evaluates. Without them a rule is advice |
| **`examples[]`** | each with `verdict`; a `warn`/`block` rule needs an allowed one carrying a real `action` |

### Three gates on the rules themselves

Measured across 83 production system prompts (1.8M characters) before any of this was designed:
`example` is the most repeated heading by roughly 9x, prohibitions outnumber obligations 2:1, and
`if … then` appears **34 times in the whole corpus**. Real prompts are examples plus unconditional
imperatives. The examples are the good part. The missing conditions are the gap.

1. **Every example is replayed through the engine.** A rule whose conditions do not produce the verdict
   its own example claims fails `rules lint`. The documentation of a rule is the test of that rule.
2. **Every rule must name a case it ALLOWS, and that case must be a near miss** — it has to satisfy
   every condition of the rule except exactly one. A distant counterexample proves "this rule does not
   forbid the sky", which nobody doubted. At `block` this is an error; at `warn` a warning, because
   the more force a rule has the sharper its edge must be.

   **What this check does not prove.** An earlier version asked only that the allowed and forbidden
   examples share one signal, and since nearly every rule here begins with `tool eq Bash`, almost
   anything qualified. "All conditions but one" is stricter, but on a rule with exactly two conditions
   the two tests coincide, so `ls -la /tmp` still counts as the near miss of a rule about
   `DROP TABLE prod`. A machine cannot measure semantic distance. The check rules out the careless
   cases; a person reading the rule is what makes the example genuinely near.
3. **A rule that cannot fire may not call itself a gate.** `warn` and `block` require `applies_when`,
   and they require an allowed example carrying a real `action` — a prose-only example is skipped by
   both checks above, so it satisfies the count without testing anything. (Measured: a catch-all
   `block` rule got through a clean `lint` exactly that way, then blocked `git status`.) A rule meant
   for reading says `advice`, stays findable, and claims nothing.

### Enforcement

```bash
kiai hooks --rules > .claude/settings.json     # PreToolUse runs `rules check` before the recorder
```

`rules check` exits **2** on a `block` — the code Claude Code reads as "do not run this tool call" —
and 0 when nothing applies or a rule only warns, so an ordinary session is untouched. A payload it
cannot parse lets the action through: returning 2 there would block every tool call, which is the
fastest way to get the hook switched off, after which it protects nothing at all.

**No model is asked whether a rule was broken.** The engine decides and the output explains. That is
the whole point: if a model gets to judge compliance, then whoever seizes the session seizes the
verdict with it, and the rules are back to being advice.

### What this does not do

- It does not stop an agent that edits `.kiai/rules/` and commits the edit. Rules are reviewed like
  code, in git, by a person — that is the only thing holding them.
- **23 of the 26 rules are `advice`** — findable and citable, enforced by nothing. Judgement does not
  reduce to a regex, and pretending otherwise would fill the day with false alarms. Measured honestly,
  this is a searchable rulebook with three locks on it, not an enforcement system.
- The taxonomy measured across those 83 prompts also contains `tone_and_formatting`,
  `refusal_handling`, `user_wellbeing`, `harmful_content_safety` and `evenhandedness`. **No rule here
  covers them**, on purpose: every rule must name a real incident in its `source`, and this repository
  has none for those families — KIAI is a development tool, not a product that talks to end users.
  Writing rules to fill out a taxonomy is exactly what `source` exists to prevent.
- There is no UI, by request.

## Other agents, other models — handing it to a developer

Claude Code gets hooks. Everything else gets the one thing every agent has: a shell command.

```bash
kiai wrap --tool Bash --session <conversation-id> -- <the command>   # record, ask the rules, run, record
kiai hooks --agent generic                                          # the 6-field payload contract, to record yourself
kiai import codex                                                   # Codex CLI: read the rollouts it already writes
kiai hooks --agent cursor > .cursor/hooks.json                      # Cursor: translator (HALF MEASURED — loaded by 3.19.7, not yet seen firing)
```

`kiai init` now seeds the 26 starter rules into `.kiai/rules/`, so a fresh install gets the key and not only
the lock (measured 2026-09-18: a marketplace install had the `rules` command and no rule).

| | status | evidence |
|---|---|---|
| Claude Code | **measured** | marketplace install on a clean machine; hooks fire |
| Codex CLI `import` | **measured** | 85 real rollouts, idempotent |
| any model via `wrap` | **measured** | `qwen2.5:7b`: 3 calls, `git reset --hard` refused, model explained why; 6 records, verify green |
| Cursor | **half measured** | Cursor 3.19.7 loads the 4 hooks; payload shape from its bundle; no live fire yet (needs a signed-in account) |

Commands per agent: [Pick your agent](#pick-your-agent--what-to-run-step-by-step) at the top. Full walkthrough, update / fix / uninstall: **[docs/HANDOFF.md](docs/HANDOFF.md)** (Vietnamese).
Every adapter directory carries its own README (a test holds this): `adapters/generic/`, `adapters/ollama/`, `adapters/codex/`, `adapters/cursor/`.

## What it does not record, and redaction limits

Model name and token cost (Claude Code does not expose them to hooks), file contents, the agent's reasoning.
Redaction is regex based and covers common shapes (OpenAI/Anthropic/Stripe/GitHub/GitLab/Slack/Google/npm/
Hugging Face/SendGrid/Twilio keys, AWS ids, `Bearer`/`Basic` headers, `user:pass@` URLs, `-p`/`-u`/`--password`
flags, `*password*=`/`*secret*=`/`*token*=`/`*key*=` assignments and JSON fields, PEM private keys). It cannot be
complete: **do not paste secrets into shell commands, and review `.kiai/flight` before pushing.**

`record` accepts any JSON carrying `hook_event_name`, `tool_name` and `tool_input`, so any hook system can
call it — but the only hook system it has been seen working with is Claude Code's. For Codex, use
[`import`](#codex-cli). For Cursor, [`adapters/cursor/`](adapters/cursor/README.md) translates its hooks — loaded by Cursor 3.19.7, not yet seen firing.

## Development

```bash
cd kiai-plugin && npm test      # node --test, offline, ~35 s, 161 tests (v0.7.1)
```

MIT © 2026 Nguyen Truong An. Part of [KIAI](https://github.com/yuta9999zn/KIAI).
