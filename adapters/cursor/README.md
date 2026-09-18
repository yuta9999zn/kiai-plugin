# Cursor → KIAI

**Status: MEASURED LIVE (2026-09-19, Cursor 3.21.13 on Windows, three agent sessions — the third with the fix).**

| What | Measured? | Evidence |
|---|---|---|
| Cursor loads `.cursor/hooks.json` written by `kiai hooks --agent cursor` | **yes** | Cursor's hooks log: `Loaded 4 project hook(s) for steps: beforeShellExecution, beforeMCPExecution, afterFileEdit, stop` |
| The hooks **fire** in a live agent turn | **yes** | hooks log: `Executing hook 1/1 from project config … beforeShellExecution … exit code: 0`, once per shell command, in two sessions |
| The translator on the live payload | **it failed, twice** — then fixed | Cursor prefixes the JSON with a UTF-8 BOM (`EF BB BF`); `JSON.parse` refused it, the translator saw `{}`, recorded `command: ""` and answered `allow` — and `git reset --hard HEAD~1` **ran** in the probe repository. Proof: `.kiai/flight/errors.log` → `bad hook payload: Unexpected token '\uFEFF'`. 0.7.2 strips the BOM; TS-130-20 replays the byte-exact payload: status recorded, reset **denied** |
| A live run **with** the fix | **yes** | seen live, 2026-09-19, Cursor 3.21.13: `git status --short` recorded, `git reset --hard HEAD~1` **denied** by `safety/no-hard-reset-over-uncommitted-work`, the agent reported *HEAD was not moved*, the commit survived (records 24–25 of the probe chain; Cursor's hooks log: `"permission": "deny"`, `user_message: KIAI: blocked by …`) |
| Cursor also runs the **Claude Code plugin's** hooks | **yes** | hooks log: `Executing hook 1/1 from claude-plugin config … record PreToolUse`, run with the plugin directory as cwd and `cwd: ""` in the payload. 0.7.1 then said "no .kiai/ above <plugin dir>; nothing recorded"; 0.7.2 takes the repository from `workspace_roots` and accepts `Shell`/`preToolUse` — so an installed plugin records Cursor sessions without this translator |

Payload shape seen live: `{conversation_id, generation_id, model, command, cwd: "", sandbox, session_id, hook_event_name, cursor_version, workspace_roots: ["/d:/tmp/repo"], user_email, transcript_path}` — `workspace_roots` holds URI paths; `user_email` is in every payload and is never written to a record.

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
