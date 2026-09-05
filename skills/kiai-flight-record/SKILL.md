---
name: kiai-flight-record
description: Use when the user asks what an AI agent did in this repository, wants evidence for a review or client acceptance, asks to "show the flight record", "verify the audit log", "what changed in that session", or when closing a unit of work (UoW) and a summary of tool calls, files written and shell commands is needed. Reads the KIAI black box under .kiai/flight.
---

# KIAI flight record

This repository keeps a **black box**: every Claude Code session start, tool call, tool result and stop
is appended to `.kiai/flight/<writer>/YYYY-MM-DD.jsonl` by the `kiai` plugin hooks. Records are hash-chained:
`hash_n = sha256(hash_{n-1} + "\n" + canonical(record_n))`. Nothing is ever rewritten. One chain per
*writer* (machine × working tree), so clones and worktrees never collide.

Records hold **references and hashes, not contents**: a file write is stored as path + sha256 of the
written content; a shell command is stored redacted (common API key, token and password shapes replaced).

## Commands (run from the repo root)

```bash
node "${CLAUDE_PLUGIN_ROOT}/bin/kiai.mjs" verify                       # exit 1 if any chain is broken
node "${CLAUDE_PLUGIN_ROOT}/bin/kiai.mjs" report                       # Markdown evidence, all sessions
node "${CLAUDE_PLUGIN_ROOT}/bin/kiai.mjs" report --uow UOW-119         # one unit of work
node "${CLAUDE_PLUGIN_ROOT}/bin/kiai.mjs" report --since 2026-09-01 --json
node "${CLAUDE_PLUGIN_ROOT}/bin/kiai.mjs" note "GATE 3 approved" --by "tech-lead"
node "${CLAUDE_PLUGIN_ROOT}/bin/kiai.mjs" status
node "${CLAUDE_PLUGIN_ROOT}/bin/kiai.mjs" accept --uow UOW-119                     # DRAFT acceptance packet (.md + .json)
node "${CLAUDE_PLUGIN_ROOT}/bin/kiai.mjs" accept --check acceptance-UOW-119.md     # recheck a packet's footer hash
```

Only a human runs `accept --decision …`: it seals a decision into the chain, and the CLI refuses it inside an
agent session (`CLAUDECODE` is set). As the agent, produce the DRAFT packet (`acceptance-<UoW>.draft.md`) when a
unit of work is done and hand it over; never pass `--decision` or `KIAI_ALLOW_AGENT_DECISION` yourself, and never
write `.kiai/ac/<UoW>.md` unless the human asked you to draft criteria (the packet flags agent-written criteria).

## How to use it well

1. **Verify before you cite.** Run `verify` first; quote its head hash in any report you hand to a human.
   If it prints `WARN — … dropped record(s)`, say that the log is incomplete and where the gap is.
2. **Attribute a UoW.** Set `KIAI_UOW=UOW-123` in the environment, write it to `.kiai/current`, or work on a
   branch named `bolt/UOW-123`; records pick it up automatically. Do not invent a UoW id.
3. **Do not edit `.kiai/flight/**/*.jsonl`.** If a record is wrong, add a `note` that corrects it; the chain
   keeps both.
4. When asked "what did the agent do", answer from `report`, and say plainly what the record does *not*
   show (file contents, reasoning, token cost) and what `verify` does *not* prove (completeness on a
   machine that holds no local witness — anchor the head in git / the PR).
