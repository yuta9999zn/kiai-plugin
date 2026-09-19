# Ollama / any local or OpenAI-compatible model → KIAI

**Status: MEASURED** — `qwen2.5:7b` behind Ollama, 2026-09-18: 3 tool calls, `git reset --hard`
refused by `safety/no-hard-reset-over-uncommitted-work`, the model explained why on its next turn;
6 records, `kiai verify` green. Transcript in `docs/HANDOFF.md` §5.

The model never runs anything itself. `harness.mjs` is the smallest agent loop that puts **every**
tool call through `kiai wrap`, so the flight record holds what was actually executed, not what the
model said it did.

## Run it

```bash
cd your-repo
node <plugin>/bin/kiai.mjs init                                   # once: .kiai/ + the 27 starter rules
OLLAMA_HOST=http://127.0.0.1:11434 OLLAMA_MODEL=qwen2.5:7b \
node <plugin>/adapters/ollama/harness.mjs "List the files here, show the last commit, then try git reset --hard HEAD~1"
node <plugin>/bin/kiai.mjs status                                 # records > 0 — it worked
```

`<plugin>` is where the plugin lives: `~/.claude/plugins/cache/kiai/kiai/<version>/` after a marketplace
install, or any `git clone https://github.com/yuta9999zn/kiai-plugin`. Zero dependencies, no `npm install`.

| Variable | Default | Meaning |
|---|---|---|
| `OLLAMA_HOST` | `http://127.0.0.1:11434` | Ollama's HTTP endpoint (`/api/chat`, tool calling required) |
| `OLLAMA_MODEL` | `qwen2.5:7b` | any model that supports tools (`ollama show <model>` lists `tools`) |
| `KIAI_SESSION` | `ollama-<model>-<time>` | session id written into every record |
| `KIAI_MAX_TURNS` | `6` | hard stop on the model loop |

## What each tool call becomes

```
kiai wrap --tool Bash --session <KIAI_SESSION> -- bash -lc '<the command the model asked for>'
```

`wrap` records `PreToolUse` → asks the repository's rules → a `block` rule **refuses to run** the
command (exit 2, reason on stderr — the harness hands that reason back to the model as the tool
result) → runs it → records `PostToolUse` with exit code and output size, never the output. Before the
command, `wrap` snapshots the working tree (`git write-tree`, ~90 ms on a normal repository) so a
destructive command that slipped past the rules can still be undone with `git restore --source=<tree>`
— the rules are a tripwire, the snapshot is the wall; both, with their measured holes, in
`docs/HANDOFF.md` §5.

## Another endpoint (LM Studio, vLLM, OpenAI, …)

Copy `harness.mjs`, change the `fetch` call to that endpoint's chat format, and **keep `runThroughKiai`
unchanged** — that function is the whole integration. If your agent already has its own loop, skip the
harness and call `kiai wrap` yourself; the payload contract for recording without `wrap` is
`kiai hooks --agent generic` (see `../generic/README.md`).

## What this does not do

- It protects only the commands that go through `wrap`. A harness that calls the shell directly records
  nothing and blocks nothing.
- 23 of the 27 starter rules are `advice`: searchable (`kiai rules search …`), not enforced.
- The model can still be told wrong things by its own tools; KIAI records the call, it does not judge
  the answer.
