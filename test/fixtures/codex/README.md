# Codex rollout fixtures

Test input for `kiai import codex`. These are **real Codex session logs**, not invented ones — the
importer exists to read a format we do not control, so a hand-written fixture would only test our
own idea of that format.

| File | Where it came from | What it is for |
|---|---|---|
| `inside-codemode.jsonl` | a real `codex exec` run of Codex CLI **0.153.4**, driven on 2026-09-17 by the session that built UOW-124 (prompt: create `hello.txt`, then `git status --short`) | the current "code mode" shape: `custom_tool_call` / `custom_tool_call_output` plus `item_completed` items (`UserMessage`, `FileChange`, `CommandExecution`) |
| `outside-repo.jsonl` | the same run, with `cwd` changed to another directory | a session that belongs to a different repository must never be imported |
| `no-meta.jsonl` | the same run, with the `session_meta` line removed | a rollout whose first line never landed: skipped, never guessed at |
| `legacy-functioncall.jsonl` | the **shapes** are lines from a real Codex **0.148.0-alpha.9** session | the older shape: `function_call` with a JSON `arguments` string, `function_call_output`, `event_msg.user_message`, and `patch_apply_end` with `add` / `update` / `delete` changes — **and no `ordinal` key**, exactly as 0.148 wrote it |

Two deliberate edits, in every file:

- **`cwd` and file paths are the token `__ROOT__`.** The tests substitute the temporary repository
  they create, so the fixtures carry no path from the machine that recorded them.
- **`base_instructions` is dropped** from `session_meta` (several kilobytes of OpenAI's model
  prompt, irrelevant to a parser).

In `legacy-functioncall.jsonl` the **values** are replaced as well — commands, prompts, file paths and
file contents. That session was the user's own work; its contents are not ours to publish. The shape
is real, the payload is fixture data.

One thing this file must keep exactly as it is: **it has no `ordinal` key on any line.** Codex only
started emitting `ordinal` in 0.151; on the machine this package was built on, 23 919 of 32 118 real
rollout lines (74%, every build up to 0.148.x) have none. The first version of this fixture had an
`ordinal` added by the script that generated it, which hid a bug: the importer was keying its
de-duplication on `session#ordinal` and inventing the number when it was missing. Do not add one back.
