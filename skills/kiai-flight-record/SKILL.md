---
name: kiai-flight-record
description: Use when the user asks what an AI agent did in this repository, wants evidence for a review or client acceptance, asks to "show the flight record", "verify the audit log", "what changed in that session", or when closing a unit of work (UoW) and a summary of tool calls, files written and shell commands is needed. Reads the KIAI black box under .kiai/flight.
---

# KIAI flight record

This repository keeps a **black box**: every Claude Code session start, tool call, tool result and stop
is appended to `.kiai/flight/<writer>/YYYY-MM-DD.jsonl` by the `kiai` plugin hooks. Codex CLI sessions can
be brought in afterwards with `import codex`, into a separate chain and marked as imported — weaker
evidence, and it must always be described as such. Records are hash-chained:
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
node "${CLAUDE_PLUGIN_ROOT}/bin/kiai.mjs" anchor --by "tech-lead"           # witness the heads; the human then COMMITS .kiai/anchors.jsonl
node "${CLAUDE_PLUGIN_ROOT}/bin/kiai.mjs" accept --uow UOW-119                     # DRAFT acceptance packet (.md + .json)
node "${CLAUDE_PLUGIN_ROOT}/bin/kiai.mjs" accept --check .kiai/acceptance/acceptance-UOW-119.md   # recheck a packet's footer hash
node "${CLAUDE_PLUGIN_ROOT}/bin/kiai.mjs" import codex --dry-run                    # Codex sessions run in THIS repo, not yet written
node "${CLAUDE_PLUGIN_ROOT}/bin/kiai.mjs" import codex                              # …then append them, in their own chain
node "${CLAUDE_PLUGIN_ROOT}/bin/kiai.mjs" signers --list                            # who may approve here
node "${CLAUDE_PLUGIN_ROOT}/bin/kiai.mjs" verify --require-signature                # gate: every decision must be signed
```

`verify` prints an `ANCHORED` / `NOT ANCHORED` line: anchors (`.kiai/anchors.jsonl`, committed) are what lets
someone on another machine see that the TAIL of a chain was cut. Report that line as it is; do not describe an
un-anchored chain as tamper-proof.

Only a human runs `accept --decision …`: it seals a decision into the chain (and anchors it), and the CLI
refuses it inside an agent session (`CLAUDECODE` is set). That refusal is an environment check, so the
real binding is the **signature**: `--sign` ties a decision to a key listed in the committed
`.kiai/allowed_signers`. As the agent, produce the DRAFT packet (`acceptance-<UoW>.draft.md`) when a
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
5. **Report the signature state exactly as the tool prints it** — `SIGNED by <identity>` /
   `UNSIGNED` / `SIGNATURE INVALID` / `SIGNER NOT ALLOWED`. Never soften `UNSIGNED` into "approved":
   an unsigned decision is a line of text anyone able to set an environment variable could have
   written. And never claim more than a signature gives: it binds a named key to this exact packet
   body — it does **not** show the signer read it, and it does **not** mean the agent was not
   compromised. Never sign on a human's behalf, and never touch their keys.
6. **Never let an imported record pass for a live one.** Records with `via: "import"` (writer
   `<writer>-codex`) were read back from a log Codex wrote, *after* the work — the chain proves nobody
   changed them since the import, not that Codex did what they say. `report` prints the count; repeat it
   when you cite such a record, and say which agent it came from (`agent` field).
