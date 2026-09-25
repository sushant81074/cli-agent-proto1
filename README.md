# Prototype Build Guide — "The Pond"

**Goal:** one agent, invoked from the CLI with a task, that uses tools and skills to
finish it and prints the result.
**Time:** 14–16 focused hours. Two days.
**Stack:** bun (install + scripts), TypeScript, Node (runtime). Nothing else.
**Your job:** write all the code. **My job:** answer questions and help you debug.

This is the pond. The full spec (`agent-ecosystem-FINAL-spec.toml`) is the ocean, and
§ references below point there so you can see where each piece will eventually grow.

---

## 0. What you are actually building

```text
$ eco "count the TODO comments in this repo and write a summary to TODOS.toml"

  ▸ reading skills… [code-review]
  ▸ fs.glob **/*.ts                         42 files
  ▸ fs.grep TODO                            17 matches
  ▸ fs.write TODOS.toml                       allow? [y/N] y
  ✓ done · 4 iterations · 12.4k tokens · $0.03

  Found 17 TODOs across 9 files. Summary written to TODOS.toml.
```

That's it. One agent, a handful of tools, a permission prompt, and a loop.

Everything hard about multi-agent systems is **already present in this**: the loop, tool
dispatch, permissions, budgets, streaming. Multi-agent is mostly this same loop with a
scheduler on top. Learn the pond and the tsunami stops looking like a different
substance.

---

## 1. Scope

### In

| Piece       | Prototype version                          | Grows into                 |
| ----------- | ------------------------------------------ | -------------------------- |
| Agent       | One, from a markdown file with frontmatter | §22.1 agent files          |
| Execution   | One task, start to finish, in-process      | §2.3 Execution aggregate   |
| Agent loop  | `while` loop: model → tools → model        | §7 AgentLoop               |
| Provider    | One (Anthropic), streaming                 | §12 ModelRouter + adapters |
| Tools       | 6 of them, one registry                    | §10 ToolRegistry           |
| Permissions | 3 modes, y/n prompt, session memory        | §11 PermissionEngine       |
| Skills      | Folder + SKILL.toml, loaded on demand      | §22.2 skills               |
| Budget      | max iterations, max cost, max time         | §12.5 limits               |
| CLI         | `eco "<task>"`, `--agent`, `--yes`         | §23 CLI surface            |
| Run log     | Append-only JSONL, one line per event      | §13.1 EventStore           |

### Out — deliberately

Multi-agent, coordination strategies, groups, participants, handoff, sub-executions,
the event `fold`, resume/fork/replay, context compaction, long-term memory, MCP,
plugins, hooks, the daemon, the scheduler, sandbox tiers, taint tracking, the read
model, observability.

**Do not build any of these.** Every one is a day or more on its own, and none of them
teaches you anything you can't learn from the loop. If you find yourself reaching for
one, that's the signal the pond is done and it's time to re-read the full spec.

One exception worth honouring now, because it costs nothing: **write the run log from
the start**. It's twenty lines, it makes debugging the loop dramatically easier, and
it's the seed the whole persistence story grows from later.

---

## 2. Mental model — the three ideas

Read this section twice. Everything else is detail.

### Idea 1: the agent loop is a `while` loop

An LLM with tools does exactly one thing: you send it a conversation, it replies with
either **text** (it's done) or **a request to run some tools** (it's not done). You run
the tools, append the results to the conversation, and send it again.

```text
conversation = [system prompt, user task]

loop:
    reply = model(conversation, tools)

    if reply has no tool requests:
        return reply.text                    ← the agent is finished

    results = run each requested tool
    conversation += reply                     ← assistant's turn, verbatim
    conversation += results                   ← one user turn holding all results
```

That is the entire agent. Maybe 60 lines. Everything else in the spec — permissions,
budgets, streaming, compaction — hangs off one of those four steps.

### Idea 2: a tool is a function plus a JSON schema

The model can't call your code. It can only emit JSON that says "I'd like `fs.read`
with `{path: 'src/app.ts'}`". You look that name up in a map, validate the JSON against
the schema you advertised, call the function, and stringify whatever comes back.

The model never sees your code. It sees the **name, description and schema**. Those
three strings are prompt engineering, not documentation — a tool with a vague
description gets used wrongly, and the fix is editing the description, not the code.

### Idea 3: the conversation is the only state

There's no hidden memory. Everything the agent knows on iteration 7 is in the array you
send it. This is why context budgets, compaction and working-set assembly exist in the
full spec — and why, in the prototype, you can just cap iterations and let the array
grow.

---

## 3. Project shape

One package. Folders mirror the layers from the spec, so splitting them out later is
mechanical.

```text
eco/
  package.json          bun workspaces removed — single package
  tsconfig.json
  eslint.config.js      keep the strict rules, drop the boundary rules
  vitest.config.ts
  agents/
    general.toml          the default agent
  skills/
    code-review/SKILL.toml
  src/
    domain/             types only: Turn, ToolCall, ToolResult, errors, ids
    provider/           anthropic.ts — streaming adapter
    tools/              registry.ts, fs.ts, shell.ts, skill.ts
    permissions/        policy.ts, prompt.ts
    runtime/            loop.ts  ← the heart of it
    config/             config.ts, agent-file.ts, skill-loader.ts
    cli/                index.ts, render.ts
    log/                run-log.ts
  test/
```

Keep `src/domain` free of I/O out of habit. It costs nothing now and it's the one piece
that transfers unchanged into the full build.

`package.json` scripts:

```json
{
  "scripts": {
    "dev": "tsx src/cli/index.ts",
    "build": "tsup src/cli/index.ts --format esm --clean --banner:js='#!/usr/bin/env node'",
    "typecheck": "tsc --noEmit",
    "lint": "eslint .",
    "test": "vitest run",
    "check": "bun run typecheck && bun run lint && bun run test"
  }
}
```

Dependencies: `@anthropic-ai/sdk` (or plain `fetch` — see step 2), `zod`,
`zod-to-json-schema`, `smol-toml`, `commander`, `picocolors`. Dev: `tsx`, `tsup`,
`typescript`, `vitest`, `eslint`, `typescript-eslint`.

---

## 4. Build order

Eight steps. Each has a **checkpoint you can run**. Do not move on until the checkpoint
passes — in this kind of system, two half-working layers produce failures that look
like a third, unrelated bug.

---

### Step 1 — Skeleton and config · 45 min

**Goal:** `bun run dev "hello"` parses args, loads config, prints the task back.

Files: `src/cli/index.ts`, `src/config/config.ts`, `src/domain/errors.ts`.

Take these from the M0 scaffold you already have — the error taxonomy and the config
loader carry over unchanged. Strip the config schema down to what the prototype uses:

```ts
{
  model: string; // e.g. "claude-sonnet-4-5"
  maxIterations: number; // default 25
  maxCostUsd: number; // default 1.00
  permissionMode: "strict" | "standard" | "yolo";
}
```

**Checkpoint:** `bun run dev "hello world"` prints the task and the resolved config.

---

### Step 2 — Provider: streaming text · 2.5 h

**Goal:** `bun run dev "write a haiku about pointers"` streams the model's answer to
your terminal, token by token. No tools yet.

File: `src/provider/anthropic.ts`.

Write one function:

```ts
export interface ModelMessage {
  role: 'user' | 'assistant';
  content: string | ContentBlock[];
}

export type ProviderEvent =
  | { type: 'text'; delta: string }
  | { type: 'tool_use'; id: string; name: string; input: unknown }
  | { type: 'usage'; inputTokens: number; outputTokens: number }
  | { type: 'stop'; reason: 'end_turn' | 'tool_use' | 'max_tokens' };

export async function* complete(req: {
  model: string;
  system: string;
  messages: ModelMessage[];
  tools: ToolSchema[];
  signal: AbortSignal;
}): AsyncGenerator<ProviderEvent>;
```

An async generator, so the caller can `for await` and print as it goes.

**The tricky part — read this before you write it.** The Anthropic streaming API sends
a tool call's arguments as _fragments of JSON text_ spread across many events. You get:

```text
content_block_start   { index: 1, content_block: { type: 'tool_use', id, name } }
content_block_delta   { index: 1, delta: { type: 'input_json_delta', partial_json: '{"pa' } }
content_block_delta   { index: 1, delta: { type: 'input_json_delta', partial_json: 'th":"src' } }
content_block_delta   { index: 1, delta: { type: 'input_json_delta', partial_json: '/a.ts"}' } }
content_block_stop    { index: 1 }
```

So you keep a `Map<index, {id, name, json: string}>`, append each `partial_json`
fragment, and `JSON.parse` only at `content_block_stop`. Parsing early gives you
`SyntaxError: Unexpected end of JSON input`, and that is the single most common way
people get stuck here.

Text arrives the same way but as `text_delta`, which you can emit immediately.

Use the official SDK if you want — it handles the SSE framing — but do the block
accumulation yourself so you understand the shape. Plain `fetch` with a
`ReadableStream` reader is about 40 extra lines and worth writing once.

**Checkpoint:** a haiku appears word by word, and you log a usage line at the end.
If you see the whole thing appear at once, you're buffering somewhere.

---

### Step 3 — Tools: registry and three read-only tools · 2 h

**Goal:** the tools exist and are unit-tested. The agent doesn't use them yet.

Files: `src/tools/registry.ts`, `src/tools/fs.ts`, `src/domain/tool.ts`.

```ts
export type ToolEffect = "read" | "write" | "exec" | "meta";

export interface ToolDefinition<I = any> {
  name: string; // 'fs.read'
  description: string; // the model reads this — write it carefully
  schema: z.ZodType<I>; // zod → JSON Schema via zod-to-json-schema
  effect: ToolEffect;
  handler(input: I, ctx: ToolContext): Promise<ToolResult>;
}

export interface ToolResult {
  ok: boolean;
  content: string; // exactly what the model sees
  error?: string;
}
```

Three tools to start: `fs.read` (with optional line range), `fs.glob`, `fs.grep`.

Three rules that will save you hours later:

1. **Jail every path.** Resolve it, then check it's inside the workspace root. One
   helper function, used by every fs tool. Without it the agent will eventually read
   your `~/.ssh` because a task mentioned a config file.
2. **Truncate output.** Cap at ~30 KB, cut from the middle, and say so:
   `...[truncated 12,431 bytes]...`. One `fs.read` of a lockfile otherwise eats your
   whole context window.
3. **Never throw from a handler.** Return `{ok: false, error: '...'}`. The model reads
   the error and tries something else, which is the behaviour you want. A thrown
   exception kills the run instead.

**Checkpoint:** `bun run test` — each tool has a test against a temp directory,
including one that proves a path outside the workspace is rejected.

---

### Step 4 — The loop · 2.5 h

**Goal:** the agent reads files and answers questions about them. This is the moment it
becomes an agent.

File: `src/runtime/loop.ts`.

```ts
export async function* runAgent(opts: {
  agent: Agent;
  task: string;
  tools: ToolDefinition[];
  signal: AbortSignal;
}): AsyncGenerator<LoopEvent, TurnResult>;
```

The algorithm is Idea 1 from §2, plus a guard:

```text
messages = [{ role: 'user', content: task }]

for iteration in 1..maxIterations:
    toolUses = []
    for await (event of provider.complete({ system, messages, tools })):
        'text'     → yield to the renderer
        'tool_use' → toolUses.push(event)
        'usage'    → accumulate; abort if over budget

    if toolUses is empty:
        return { output: accumulatedText, iterations: iteration }

    results = []
    for (const use of toolUses):
        tool = registry.get(use.name)
        if (!tool) results.push(errorResult(`unknown tool ${use.name}`))
        else {
            parsed = tool.schema.safeParse(use.input)
            if (!parsed.success) results.push(errorResult(formatZodError(parsed.error)))
            else results.push(await tool.handler(parsed.data, ctx))
        }

    messages.push({ role: 'assistant', content: assistantBlocksFrom(toolUses, text) })
    messages.push({ role: 'user',      content: results.map(toToolResultBlock) })

return { output: text, stopped: 'max_iterations' }
```

**The tricky part — message shape.** The API is strict about this and the errors are
unhelpful:

- The assistant message must contain the `tool_use` blocks **exactly as received**,
  same `id`s, in the same order, alongside any text block.
- The tool results go back as a **single user message** whose content is an array of
  `tool_result` blocks, one per `tool_use`, each with a matching `tool_use_id`.
- Every `tool_use` needs a result. Miss one and you get a 400. If a tool failed, send
  `{ type: 'tool_result', tool_use_id, content: 'Error: ...', is_error: true }` — the
  error _is_ the result.

**Checkpoint:** `bun run dev "what does src/runtime/loop.ts do?"` — the agent calls
`fs.read` on its own source and explains itself back to you. That moment is the point
of this whole exercise.

---

### Step 5 — Write and exec tools, with permissions · 2.5 h

**Goal:** the agent can change things, and asks you first.

Files: `src/tools/fs.ts` (add `fs.write`, `fs.edit`), `src/tools/shell.ts`,
`src/permissions/policy.ts`, `src/permissions/prompt.ts`.

Permission check — a pure function, easy to test:

```ts
type Decision = "allow" | "ask" | "deny";

function check(
  tool: ToolDefinition,
  mode: PermissionMode,
  grants: Set<string>,
): Decision;
```

| Mode                 | read  | write | exec  |
| -------------------- | ----- | ----- | ----- |
| `strict`             | ask   | ask   | ask   |
| `standard` (default) | allow | ask   | ask   |
| `yolo`               | allow | allow | allow |

A `y` answer grants once; `a` grants that tool for the rest of the run — store the tool
name in a `Set`. That's the whole grant system for now.

The prompt itself: pause rendering, print a one-line summary plus (for `fs.edit`) the
actual diff, read one line from stdin with `node:readline/promises`, resume.

Two rules that matter more than they look:

1. **A denial is not a failure.** Return
   `{ ok: false, content: 'The user denied this action.' }` as the tool result and keep
   looping. The agent will try something else or explain why it can't proceed. If you
   throw on denial, every "no" ends the run and the tool becomes unusable.
2. **`fs.edit` takes an exact old string and a new string**, and fails if the old string
   appears zero times or more than once. Do not build a line-number-based editor. Models
   are bad at line numbers and excellent at quoting text.

For `shell.exec`: `node:child_process` `spawn`, no `shell: true`, cwd jailed to the
workspace, 60-second timeout, capture stdout and stderr, truncate, and return the exit
code in the content.

**Checkpoint:** `bun run dev "add a doc comment to the top of src/tools/fs.ts"` — you
get a diff, approve it, and the file changes.

---

### Step 6 — Skills · 1.5 h

**Goal:** domain knowledge in files, loaded only when needed.

Files: `src/config/skill-loader.ts`, `src/tools/skill.ts`, `skills/*/SKILL.toml`.

A skill is a folder with a `SKILL.toml`:

```markdown
---
name: code-review
description: Conventions and checklist for reviewing TypeScript in this repo.
---

When reviewing code in this repository:

- Flag any `any` type that isn't in a test file.
- ...
```

Two pieces:

1. At startup, read every `SKILL.toml`, and put **only the names and descriptions** into
   the system prompt as a list.
2. Add a `skill.open` tool that takes a name and returns the body.

That's "progressive disclosure", and it's the whole trick: ten skills cost you ~200
tokens of system prompt instead of ~20,000, and the agent pulls in the one it needs.

You already need a frontmatter parser here — write it once, because step 7 uses it too.
Split on the `---` fences and parse the middle with `smol-toml`, or hand-roll the four
lines of key/value parsing. Don't add a YAML dependency for this.

**Checkpoint:** `bun run dev "review src/tools/fs.ts"` — the agent calls `skill.open`
with `code-review` before it starts reviewing.

---

### Step 7 — Agent files and the run log · 2 h

**Goal:** the agent is data, not code. And you can see what happened.

Files: `src/config/agent-file.ts`, `src/log/run-log.ts`, `agents/general.toml`.

Agent file, same frontmatter parser as skills:

```markdown
---
name: general
description: General-purpose assistant for this repository.
model: claude-sonnet-4-5
tools: ["fs.*", "shell.exec", "skill.open"]
maxIterations: 25
---

You are a careful engineer working in this repository.
Prefer reading before writing. Ask rather than guess.
```

The body becomes the system prompt. `tools` filters the registry — glob match, and an
agent with no `tools` key gets read-only tools.

Run log: append one JSON line per event to `.eco/runs/<timestamp>.jsonl`.

```ts
{ t: '2026-01-01T00:00:00Z', type: 'run.started', task, agent, model }
{ t: ..., type: 'iteration', n: 1 }
{ t: ..., type: 'tool.call', tool: 'fs.read', args: {...}, decision: 'allow' }
{ t: ..., type: 'tool.result', tool: 'fs.read', ok: true, bytes: 1203 }
{ t: ..., type: 'run.finished', iterations: 4, usage: {...}, output }
```

Twenty lines of code. When the agent does something baffling — and it will — this file
tells you exactly what it saw and when. It's also the embryo of the event store in
§13.1, so the instinct transfers.

**Checkpoint:** `--agent general` works, a second agent file with different tools
behaves differently, and `.eco/runs/` fills up.

---

### Step 8 — Budgets, cancellation, polish · 1.5 h

**Goal:** it can't run away, and it looks like a real tool.

- **Budget:** accumulate tokens from the `usage` events, multiply by a rate table in
  config, and abort before a model call that would exceed `maxCostUsd`. Same for
  `maxIterations` and a wall-clock deadline.
- **Cancellation:** one `AbortController`. Pass the signal into `fetch` and into
  `spawn`. Handle `SIGINT`: first Ctrl-C aborts, second exits immediately.
- **Rendering:** collapse tool calls to one line each (`▸ fs.read src/app.ts  1.2 kB`),
  stream text as it arrives, print a summary line at the end with iterations, tokens
  and cost.
- **Exit codes:** 0 done, 1 failed, 2 bad usage, 3 denied, 4 over budget, 130
  interrupted.

**Checkpoint:** set `maxCostUsd = 0.01`, run something big, and watch it stop cleanly
with partial output rather than crashing.

---

## 5. The final demo

When all eight checkpoints pass, run this in a repo that isn't this one:

```bash
eco "find every function longer than 50 lines, and write a short report to REPORT.toml ranked by length"
```

It should: glob the files, read several, reason about them, ask permission once to
write, and produce a real report. If that works, you have built a working agent.

---

## 6. What will break, and where to look

| Symptom                                                    | Almost always                                                                                                  |
| ---------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------- |
| `SyntaxError: Unexpected end of JSON input`                | Parsing `input_json_delta` before `content_block_stop` (step 2)                                                |
| API 400 `tool_use ids must have corresponding tool_result` | A tool call without a result, or results split across two user messages (step 4)                               |
| Agent loops calling the same tool forever                  | Your tool result says nothing useful — an empty string, or the same error each time. Make failures descriptive |
| Agent ignores a tool                                       | The `description` is vague. Rewrite it as an instruction: "Use this when you need to…"                         |
| Context length exceeded after a few iterations             | Untruncated tool output (step 3, rule 2)                                                                       |
| Whole response appears at once                             | Something is `await`ing the full stream instead of `for await`                                                 |
| Agent invents file paths                                   | It hasn't listed the directory. Add that hint to the system prompt                                             |
| Permission prompt output gets mangled                      | Streaming still writing while readline reads. Pause the renderer first                                         |
| `fs.edit` fails constantly                                 | The model is quoting text that doesn't match byte for byte — whitespace. Report the near-miss in the error     |

**General debugging method for this kind of system:** when the agent behaves oddly,
don't debug your code first. Open the run log and read what the agent actually saw. In
my experience four out of five "bugs" are a tool returning something unhelpful, not the
loop being wrong.

---

## 7. How to get help from me

I'm most useful when you give me:

1. **What you expected vs what happened** — one line each.
2. **The relevant file** — paste it, don't describe it.
3. **The run log lines** around the failure, if it's behavioural.
4. **The actual error**, complete, including the stack.

Things worth asking me before you spend an hour on them: the exact message shape for a
provider API, why a model is ignoring a tool, whether a design choice will cause
problems at step N+2, and anything in the full spec you want translated into "what does
this mean for the prototype".

I'll answer with explanation and direction, not finished code, unless you ask for code.
You learn this by writing it.

---

## 8. What you'll know afterwards, and the bridge back

After the pond you'll have built, by hand: a streaming provider adapter, a tool
registry with schema validation, a permission gate, progressive disclosure, a budgeted
agent loop, and a CLI around all of it.

At that point the full spec stops being a wall of unfamiliar concepts, because you'll
recognise most of it as things you already built, generalised:

| You built                    | Spec grows it into                                     |
| ---------------------------- | ------------------------------------------------------ |
| `runAgent()`                 | §7 AgentLoop, plus a `Turn` record around it           |
| `messages[]` growing forever | §8 working set assembly + compaction                   |
| `check(tool, mode, grants)`  | §11 layered policy + approval broker                   |
| Run log JSONL                | §13.1 event store + §6.3 fold + resume                 |
| One agent, one task          | §19 engine + §20 strategies + participants             |
| `skill.open`                 | §22.2 skills, unchanged — you'll have already built it |

The natural next step after the pond is **not** multi-agent. It's persistence: turn the
run log into a real event log you can resume from. Multi-agent on top of a system that
can't resume is how you end up with runs you can't debug.

But that's later. Build the pond first.
# cli-agent-proto1
# cli-agent-proto1
