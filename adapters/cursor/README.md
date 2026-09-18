# Cursor → KIAI

**Status: HALF MEASURED (2026-09-19, Cursor 3.19.7 installed for this).**

| What | Measured? | Evidence |
|---|---|---|
| Cursor loads `.cursor/hooks.json` written by `kiai hooks --agent cursor` | **yes** | Cursor's hooks log: `Loaded 4 project hook(s) for steps: beforeShellExecution, beforeMCPExecution, afterFileEdit, stop` |
| The payload shape the translator reads | **yes, from Cursor's own code** | `workbench.desktop.main.js` builds `{...event, session_id, hook_event_name, cursor_version, workspace_roots, user_email, transcript_path}`; `workspace_roots` holds URI paths (`/d:/tmp/repo` on Windows); shell events carry `command`, `cwd`, `conversation_id`, `generation_id` |
| The translator on that shape | **yes** (TS-130-17) | records written, `git reset --hard` answered `deny`, `user_email` never reaches a record, root found from `workspace_roots` alone |
| A hook **firing** in a live agent turn | **no** | the agent needs a signed-in Cursor account; the machine that measured the rest had none |

Also seen in the same bundle, not yet used: Cursor 3.19.7 reads **`.claude/settings.json`** hooks too
(`PreToolUse` → `preToolUse`, on by default), so `kiai hooks --rules > .claude/settings.json` may work
in Cursor without this translator. Unverified — the payload it hands those hooks was not checked.

## Install

```bash
kiai hooks --agent cursor > .cursor/hooks.json      # project-level; or ~/.cursor/hooks.json for all projects
```

The generated file points four Cursor events at `kiai-cursor-hook.mjs`:

| Cursor event | KIAI record | Can be refused? |
|---|---|---|
| `beforeShellExecution` | `PreToolUse`, tool `Bash`, `{command}` | **yes** — a `block` rule answers `{"permission":"deny"}` with the reason |
| `beforeMCPExecution` | `PreToolUse`, tool = the MCP tool name | yes |
| `afterFileEdit` | `PostToolUse`, tool `Edit`, `{file_path}` | no (already happened) |
| `stop` | `Stop` | no |

## Verify it fired — this is the step that turns NOT MEASURED into MEASURED

```bash
kiai status          # records > 0 after one Cursor session means the hook ran
kiai report          # the session, the tools, the commands
```

If `kiai status` shows nothing after a session, the payload shape differs from the documentation the
translator was written against. The translator records `tool_name: "unknown"` for shapes it does not
recognise, so a session that fired but was not understood still leaves a trace — look for `unknown`
in `kiai report --json`, then open an issue with one redacted payload.

## Safety of the translator itself

- Always answers `{"permission":"allow"}` unless a `block` rule matches.
- Never exits non-zero. A broken rule file, a missing `.kiai/`, an unparseable payload — none of them
  may be the reason the editor stops working. `kiai rules lint` is where a broken rule gets reported.
