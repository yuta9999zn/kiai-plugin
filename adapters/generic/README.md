# Any agent, any model → KIAI

**Status: MEASURED** (`kiai wrap` with `qwen2.5:7b` through `../ollama/harness.mjs`, 2026-09-18).

Every agent that is not Claude Code has the same shape: it can run a shell command, and it has no
hook system KIAI can trust. So the integration is a shell command.

## The one-line way: `kiai wrap`

Instead of running the model's command directly, the harness runs:

```bash
kiai wrap --tool Bash --session <conversation-id> -- <the command>
```

`wrap` records `PreToolUse`, asks the repository's rules, **refuses to run** a command a `block` rule
matches (exit 2, and the reason on stderr so the model can be told), runs it, and records
`PostToolUse` with the exit code and the size of what came back — never the output itself. The
command's own exit code is passed through. `wrap` adds no permission the harness did not already have.

Measured 2026-09-18 with `qwen2.5:7b` behind Ollama, in a fresh repository seeded by `kiai init`:
the model called `ls`, `git log -1`, then `git reset --hard HEAD~1`. The first two ran; the third was
refused by `safety/no-hard-reset-over-uncommitted-work`, and on its next turn the model told the user
why and offered alternatives. The chain holds 6 records; `kiai verify` is green.

```bash
kiai wrap --tool Bash --session s1 -- git status                 # recorded, runs
kiai wrap --tool Bash --session s1 -- git reset -q --hard HEAD~1 # BLOCKED BY safety/no-hard-reset…, exit 2, not run
kiai wrap --tool Edit --input '{"file_path":"src/a.ts"}' --session s1 -- node apply-edit.js src/a.ts
```

`wrap` does not invoke a shell: it runs exactly the program after `--`. A line with `|`, `&&`, `>` or an
environment variable must be wrapped — `kiai wrap … -- bash -lc 'git log | head'`. The reference harness does
this for every command the model produces.

## The raw way: the payload contract

If you would rather record yourself, pipe this JSON into `kiai record <Event>`:

```bash
kiai hooks --agent generic      # prints the contract with an example
```

Six required fields — `session_id`, `hook_event_name`, `cwd`, `tool_name`, `tool_input`,
`tool_use_id` — measured against what `buildRecord` reads. `tool_use_id` is what pairs a
`PreToolUse` with its `PostToolUse`.

```bash
echo '{"session_id":"s1","hook_event_name":"PreToolUse","cwd":"/repo","tool_name":"Bash","tool_input":{"command":"npm test"},"tool_use_id":"c7"}' \
  | kiai record PreToolUse
```

## A model behind Ollama, LM Studio, vLLM, an OpenAI-compatible endpoint

`../ollama/harness.mjs` is a 100-line reference loop: prompt → model → for each tool call, `kiai wrap`
→ result back to the model. Copy it, change the `fetch` to your endpoint's chat format, keep the
`runThroughKiai` function. That function is the whole integration.
