# Fixes: what was broken, and why

Every bug from the review is fixed below, plus six more found while fixing. No new features were added (no `fs_edit`, `fs_grep`, evals, gateway or event log). Each entry says what was wrong, how it showed up, what changed, and the lesson to carry forward.

Read the diff next to this file: `git diff` shows the edits, and the comments starting with "Before," in the code mark each fix.

## Do these yourself

1. **Commit `package.json` and `tsconfig.json`.** They were never tracked (see fix 9): `git add package.json tsconfig.json`.
2. **`shell_exec` now takes `{ command, args }`** instead of one command string (see fix 5). For example, `npm test` becomes `{ "command": "npm", "args": ["test"] }`. The model picks this up from the schema; nothing else to change.
3. **Optional new `.env` keys:** `inputUsdPerMTok` and `outputUsdPerMTok` price tokens for providers that don't report cost (Anthropic). OpenRouter reports real cost, so you don't need them today.
4. **Some old checkpoints in `memory/` are 680–790 KB** because of fix 2. New ones stay small. Delete the old ones if you don't need them.

---

## From the review

### 1. The system prompt was always empty

**Wrong:** `loop.ts` sent `system: ""`. The instructions in `agents/general.toml` and the skill list were loaded, but never reached the model.

**How it showed up:** When you asked it to review `fs.ts` and name the skill it used, the model had to glob `skills/**/SKILL.toml` to find out what skills exist. It was never told.

**Fix:** `buildSystemPrompt()` in `loop.ts` puts the agent instructions, an `[AVAILABLE SKILLS]` section and how to use `open_skill` into `system`.

**Lesson:** Loading data isn't the same as using it. When a feature "doesn't work", check the actual request the provider received, not the object you built.

### 2. `fs_glob` flooded the context and could leave the workspace

**Wrong:** Three problems in one tool:
- It walked `node_modules`.
- Unlike `fs_read`, it never called `truncateOutput`.
- It had no path jail: `../*`, `/Users/*/.ssh/*` and brace patterns like `{..,x}/*` all listed files outside the workspace.

**How it showed up:** Searching for `**/*memory*` returned hundreds of `node_modules` paths. That's why some run logs and checkpoints are 680–790 KB: every later call resent that output.

**Fix:**
- `node_modules` and `.git` are skipped.
- Results are capped at 200 matches, with a note saying how many more exist, and truncated.
- Absolute patterns and `..` are rejected, and every match is also checked with the same `resolveFilePath` jail as `fs_read`. This per-match check is what catches brace tricks.
- An empty result now says "No files matched" instead of returning an empty string.

**Lesson:** Every tool that touches the filesystem needs the same two guards (jail and output limit). Apply them to all fs tools, not just the first one you write. And check the final result, not only the input: patterns can expand in ways a string check won't see.

### 3. The Anthropic adapter sent a Zod object as `input_schema`

**Wrong:** The loop passed `t.schema` (a Zod object) as `inputSchema`. The OpenRouter adapter converted it to JSON Schema; the Anthropic adapter sent it raw. It was hidden only because the CLI uses OpenRouter.

**Fix:** `ToolSet.modelTools()` converts Zod to JSON Schema once. `IModelTool.inputSchema` is now typed as a plain JSON object, so providers never see Zod. Both adapters pass it through.

**Lesson:** When two implementations of one interface each do their own conversion, one of them will get it wrong. Convert once at the boundary, and give the type the real shape (`unknown` let the bug through).

### 4. Resume wasn't safe

**Wrong:** Three separate problems:
- Checkpoints were written directly over the old file. A crash mid-write leaves half a JSON file.
- `load()` returned `null` for *any* error, including corrupt JSON, so `--resume` silently started a fresh conversation and threw the old one away.
- A run that stopped mid-tool-batch saved a `tool_use` without its `tool_result`. Resuming it always sent an invalid conversation, which the API rejects.

**Fix:**
- `save()` writes a temp file, then `rename()`s it over the checkpoint. The rename is atomic.
- `load()` returns `null` only when the file doesn't exist (`ENOENT`). Corrupt JSON throws a clear error.
- The new `runtime/history.ts` (`repairHistory`) fills in missing tool results with an "interrupted, may or may not have run" error before resuming.

**Lesson:** Persistence has three failure points: writing, reading and "the process died in between". Treat "not found" and "broken" as different cases, and never make data loss silent.

### 5. `shell_exec` ran through a shell, lost output, and was approved blind

**Wrong:** Three problems:
- `exec()` runs through `/bin/sh`, so one approval could chain anything (`npm test && curl … | sh`).
- On a non-zero exit, `exec` throws, and the handler returned only `error.message`. stdout was lost, and a failing test run's stdout is exactly what the model needs.
- The permission prompt showed only the tool name, never the command. You were approving `shell_exec` without seeing what it would run.

**Fix:**
- `spawn()` runs with `shell: false` and `{ command, args }`.
- Stdout, stderr and the exit code are always returned. Long output is cut from the middle so the ending (usually the error or summary) survives.
- Timeout is now 60 s, and a timeout or Ctrl-C kills the whole process group (npm → node → …).
- The prompt now shows the exact parsed arguments for every tool.

**Lesson:** "cwd = workspace" is not a sandbox. `cat /etc/hosts` still works. Without a real sandbox, the permission prompt *is* the security boundary, so it has to show exactly what will run.

### 6. Settings that were defined but did nothing

| Setting | Before | Now |
| --- | --- | --- |
| `maxCostUsd` | `usage` events were ignored | Usage is summed and checked before every model call. OpenRouter's reported cost is used; otherwise tokens are priced from config |
| `AbortController` | Created, never aborted, never passed to the providers | Ctrl-C aborts it. It reaches both SDKs, running commands and the permission prompt. A second Ctrl-C force-quits |
| `permissionMode` | CLI hardcoded `"standard"`; any string was cast to the type unchecked | Read from config and validated (a typo is an error) |
| Agent file `model` | Only `MODEL` from `.env` was read | `MODEL` overrides; otherwise the agent file's model is used. Startup prints which one and where it came from |
| `logger.done()` | Never called, so no run log had an end | Called with the outcome, iterations and usage |
| Checkpoint `status` | Always `"running"` | `completed` / `paused` (hit a limit, resumable) / `cancelled` / `failed` |

The CLI now prints a summary line (`[completed] 3 iterations · 12400 tokens · $0.0300`) and uses the exit codes from your build guide: 0 done, 1 failed or hit the iteration limit, 4 over budget, 130 cancelled.

**Lesson:** A config field that nothing reads is worse than no field, because it makes you believe you have a protection you don't. When you add a setting, add the check that uses it in the same change.

### 7. `open_skill`'s parameter had the shell tool's description

**Wrong:** The `name` parameter was described as "The literal shell command to execute… Example: 'npm test'", copied from `shell.ts`.

**Fix:** It now says to pass the skill name exactly as listed under AVAILABLE SKILLS.

**Lesson:** Your own README says it: descriptions are prompts, not documentation. Review them as carefully as code.

### 8. Tool results went back as separate user messages

**Wrong:** Each result was pushed as its own user message. Your build guide says all results for one assistant turn go back in a single user message. OpenRouter tolerated it; Anthropic is the strict one.

**Fix:** `runTools()` builds one user message with every result, in `tool_use` order. The message is added on the first result and filled in as the rest arrive, so the checkpoint saved after each tool is still valid. If the run is cancelled mid-batch, the remaining calls get a "cancelled" result, because every `tool_use` needs one.

**Lesson:** Message shape is a contract with the provider. Write it exactly as the API documents, even when a more lenient provider accepts something else.

### 9. `.gitignore` ignored `package.json` and `tsconfig.json`

**Wrong:** The `*.json` line (meant for checkpoints) matched every JSON file. `git ls-files` confirms neither file was ever committed.

**Fix:** Replaced `*.json` and `*.jsonl` with `logs` and `memory`, the folders that hold run data.

**Lesson:** Ignore folders, not file types. After changing `.gitignore`, run `git status` and check nothing important vanished.

---

## Found while fixing

### 10. Your `.d.ts` type files hid 5 type errors

**Wrong:** `skipLibCheck: true` skips *every* `.d.ts` file, including your own. Three names in `runtime/index.d.ts` were never imported (`TAgentConfig`, `ToolSet`, `IModelMessage`), and neither was `OpenRouter` in `providers/index.d.ts`. That's 5 errors in total. TypeScript reported none of them and quietly treated those types as `any`, so, for example, checkpoint `messages` had no type checking at all.

**Fix:** Renamed the six hand-written type files from `.d.ts` to `.ts`, and added the missing imports. Your imports didn't change, because `"."` and `"../domains/tool"` resolve to `.ts` the same way. `tsc` is now clean even with `--skipLibCheck false`.

**Lesson:** `.d.ts` is for describing JavaScript you don't own. Your own types go in normal `.ts` files that export only types.

### 11. The loop stopped on `end_turn` even when the model asked for tools

**Wrong:** The loop ended when `stopReason == "end_turn" || toolCalls.length == 0`. Some OpenAI-compatible models can finish with "stop" even when they called tools. The run then ended with those calls never executed and never answered, which is another way to get an unresumable checkpoint.

**Fix:** Whether to continue now depends only on whether there are tool calls, as in "Idea 1" of your README.

### 12. Failed tool results dropped their output

**Wrong:** The loop sent `result.ok ? result.content : "Error occured: " + result.error`, so any content returned alongside an error was thrown away.

**Fix:** A failed result now sends `Error: …` followed by the content. Fix 5 depends on this.

### 13. Schema conversion marked defaulted fields as required

**Wrong:** `z.toJSONSchema()` describes the *output* type by default, so `fs_write`'s `overwrite` (which has `.default(false)`) was listed as required. The model had to send it every time, even though the description says it defaults to false.

**Fix:** The conversion uses `{ io: "input" }`, which describes what the model may *send*.

### 14. Anthropic output tokens were counted twice

**Wrong:** `message_start` and `message_delta` both reported output tokens, and `message_delta`'s number is a running total. That didn't matter while usage was ignored, but it would have inflated the budget as soon as fix 6 started summing usage.

**Fix:** Only the increase since the last report is emitted.

### 15. A tool that threw killed the whole run

**Wrong:** Your guide's rule is "never throw from a handler", but the loop didn't enforce it. One unexpected exception ended the run.

**Fix:** `executeTool` catches it and returns an error result. Arguments are also validated *before* the permission prompt now, so you never approve input the tool would reject.

**Also removed:** the `console.log(this.messages, "messages")` debug line, which printed the whole resumed history (hundreds of KB) at every start.

---

## Not changed, on purpose

- New tools and features (`fs_edit`, `fs_grep`, evals, gateway, event log) were left for you to build.
- `fs_read`'s path jail doesn't follow symlinks. A symlink inside the workspace that points outside it will still be read. The fix is to `realpath()` before the jail check.
- Nothing lint or test related: `bun run check` still fails, because there's no `eslint.config.js` and no test files yet.
- The CLI still always uses `OpenRouterProvider`. The Anthropic adapter is now correct, but not selectable.

## How this was verified

- `tsc --noEmit` is clean, with and without `--skipLibCheck`.
- 28 throwaway checks drove the loop with a fake provider, plus fake HTTP responses for both real SDKs. They covered system prompt, schemas, message shape, budget, iteration limit, cancel mid-stream and mid-command, resume repair, corrupt checkpoints, glob escapes, and shell output and exit codes.
- The CLI was run end to end with a fake OpenRouter endpoint, including a real Ctrl-C: it stopped in 0.1 s, exited 130, and saved the checkpoint as `cancelled`.

The checks weren't added to the repo: writing tests is part of your next step.
