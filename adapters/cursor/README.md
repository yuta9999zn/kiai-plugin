# Cursor → KIAI

**Status: NOT MEASURED.** No Cursor client existed on the machine that wrote this adapter
(2026-09-18). Everything below is written from Cursor's published hooks documentation, not from a
hook seen firing. Treat it as a starting point that a Cursor user finishes, and read
`kiai-cursor-hook.mjs` before trusting it.

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
