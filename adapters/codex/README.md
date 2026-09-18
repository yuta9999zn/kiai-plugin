# Codex CLI → KIAI

**Status: `kiai import codex` — MEASURED.** Hooks — **UNCONFIRMED** (three configurations tried on
2026-09-17, none fired; see `kiai hooks --agent codex`).

Codex already writes a full log of every session to `$CODEX_HOME/sessions/**/rollout-*.jsonl`.
KIAI reads those logs after the fact and turns them into records in their **own** chain
(`<writer>-codex`), each stamped `via: import` so nobody mistakes an imported record for one
observed live.

```bash
kiai import codex                 # everything for this repository, idempotent — run it again, imports 0
kiai import codex --dry-run       # show what would be imported
kiai import codex --since 2026-09-01
kiai verify                       # the imported chain is checked like any other
kiai report --json | head         # records carry agent: "codex-cli", via: "import"
```

Only rollouts whose `cwd` is this repository are imported; a session in another project is never
pulled in. Nothing from the rollout's file contents is stored — only structure: which tool, which
command, which paths, and hashes.

## Every session, automatically

Codex has no hook this adapter can rely on, so make the import a habit rather than an event:

```bash
# after each codex run
codex exec "..." && kiai import codex
```

or once a day from cron / a scheduled task:

```
0 18 * * *  cd /path/to/repo && kiai import codex >> .kiai/import.log 2>&1
```

## What this does not give you

- **No refusal.** An import happens after the command already ran. `kiai rules check` can still be run
  on an imported command to see whether a rule *would* have blocked it, but nothing stopped it.
- **Imported evidence is weaker than live evidence**, and `kiai status` says so on every imported chain.

If you need a gate rather than a diary, drive Codex through `kiai wrap` (see `../generic/`) or wait for
a Codex hook to be seen firing — at which point this file changes.
