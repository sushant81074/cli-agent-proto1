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

So the conversation array (`messages`) is the agent's _entire_ memory. That's why this project saves `messages` to disk (checkpoints) and why it gets expensive as runs get longer: every call resends everything that came before.

## 1.2 Messages, roles and the system prompt

A conversation is an ordered list of messages. Each has a **role**:

| Role        | Who writes it                                         | Example                                   |
| ----------- | ----------------------------------------------------- | ----------------------------------------- |
| `system`    | You (the developer)                                   | "You are a senior engineer. Never guess…" |
| `user`      | The human, **or your program** returning tool results | "count the TODOs in this repo"            |
| `assistant` | The model                                             | "I'll search for TODO comments first."    |

The **system prompt** is a set of standing instructions that sits above the conversation. In this project it's built from `agents/general.toml` plus the list of skills ([loop.ts:177](src/runtime/loop.ts#L177)).

A message's `content` is either a plain string or an array of **content blocks**. Blocks let one message carry several things at once, for example some text _and_ two tool calls. In this codebase, blocks are defined in [providers/index.ts:3](src/providers/index.ts#L3):

```ts
type IContentBlock =
  | { type: "text"; text: string }
  | { type: "tool_use"; id: string; name: string; input: unknown } // model → you
  | {
      type: "tool_result";
      toolUseId: string;
      content: string;
      isError?: boolean;
    }; // you → model
```

## 1.3 Tokens, context window and cost

Models don't read characters, they read **tokens** (roughly ¾ of a word each). Three consequences:

1. **Cost is per token.** You pay for input tokens (everything you send, _including the resent history_) and output tokens (what the model writes). Output is usually several times more expensive per token.
2. **The context window is a hard limit** on input + output tokens per call (for example 200k). Exceed it and the call fails.
3. **Big tool outputs are dangerous.** If a tool returns 700 KB, that text is resent on every later call. That's why every tool here truncates its output (`MAX_OUTPUT_BYTES`, 30 KB by default).

`max_tokens: 4096` in the providers caps how much the model may write in one reply.

## 1.4 Tool calling (a.k.a. function calling)

The model cannot run code. What it _can_ do is reply with a structured request: "please call `shell_exec` with `{command: "git", args: ["status"]}`".

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

| Reason       | Meaning                           |
| ------------ | --------------------------------- |
| `end_turn`   | The model thinks it's finished    |
| `tool_use`   | The model wants tools run         |
| `max_tokens` | It hit the output limit mid-reply |

This codebase normalizes these into `TStopReason` ([providers/index.ts:8](src/providers/index.ts#L8)). Note: the loop deliberately **does not** trust the stop reason to decide whether to continue. It looks at whether there were tool calls ([loop.ts:135-137](src/runtime/loop.ts#L135-L137)), because some models return "stop" together with tool calls.

## 1.8 Skills and progressive disclosure

A **skill** is a chunk of expert instructions (for example "how to do a code review in this repo") stored in a file. Putting every skill's full text in the system prompt would waste tokens on every call. So:

1. The system prompt contains only each skill's **name + one-line description** (cheap).
2. A tool, `open_skill`, returns the full instructions when the model decides it needs them.

This is called **progressive disclosure**. Backend analogy: lazy loading, or an index page with links instead of inlining every document.

## 1.9 Providers and why there are adapters

Different vendors have different wire formats for the same concepts:

| Concept       | Anthropic format                                   | OpenAI / OpenRouter format              |
| ------------- | -------------------------------------------------- | --------------------------------------- |
| System prompt | top-level `system` field                           | a message with `role: "system"`         |
| Tool call     | `tool_use` content block inside assistant message  | `tool_calls` array on assistant message |
| Tool result   | `tool_result` block inside a **user** message      | separate message with `role: "tool"`    |
| Tool schema   | `input_schema`                                     | `function.parameters`                   |
| Stream events | `content_block_start/delta/stop`, `message_delta`… | `choices[0].delta` chunks               |

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
- **`runtime`** depends on _interfaces_ (`Provider`, `IPermissionPolicy`, `IExecutionMemory`, `IRunLogger`), not concrete classes. It never imports `OpenRouterProvider` or `Logger` directly.
- **`cli`** is the only place that knows every concrete class. It creates them and injects them. This is the **composition root**.

## 2.3 Design patterns mapped to backend concepts

| Pattern here                  | Where                                                             | Backend equivalent you already know                              |
| ----------------------------- | ----------------------------------------------------------------- | ---------------------------------------------------------------- |
| Ports & Adapters              | `Provider` interface + `OpenRouterProvider` / `AnthropicProvider` | A payment interface with Stripe and PayPal implementations       |
| Dependency injection (manual) | `AgentLoop` constructor takes 7 dependencies                      | Constructor injection in NestJS/Spring, without the container    |
| Composition root              | `CliAgent.run()`                                                  | `main()` / `app.module.ts` where everything is wired             |
| Registry                      | `ToolCatalog`, `SkillLoader.skills`                               | A handler/route registry keyed by name                           |
| Strategy                      | `PermissionPolicy` modes                                          | Pluggable auth strategies                                        |
| Command dispatch              | `executeTool(name, input)`                                        | A message bus dispatching commands to handlers                   |
| Request validation            | Zod `schema.safeParse`                                            | Joi/Zod/class-validator on an HTTP body                          |
| Middleware chain              | lookup → validate → permission → handler → catch                  | Express middleware: 404 → 400 → 403 → controller → error handler |
| Append-only log               | `Logger` → `logs/<id>.jsonl`                                      | An audit log / event stream                                      |
| Snapshot persistence          | `ExecutionMemory` → `memory/<id>.json`                            | A job-state snapshot written after each step                     |
| Atomic write                  | temp file + `rename()`                                            | Write-then-swap; same idea as a DB committing a page             |
| Streaming pipeline            | async generators across 3 layers                                  | A Node stream / RxJS pipe / Kafka consumer chain                 |
| Cooperative cancellation      | one `AbortSignal` passed everywhere                               | Go's `context.Context`, or a request-scoped cancellation token   |

## 2.4 Folder and file map

| Path                                                             | Kind           | Responsibility                                                            |
| ---------------------------------------------------------------- | -------------- | ------------------------------------------------------------------------- |
| [src/cli/index.ts](src/cli/index.ts)                             | entry point    | Parse args, wire all objects, handle Ctrl-C, render events, set exit code |
| [src/configs/loadConfig.ts](src/configs/loadConfig.ts)           | config         | Build `TAgentConfig` from env vars + agent file                           |
| [src/configs/skill.ts](src/configs/skill.ts)                     | types          | Skill types and `ISkillLoader` interface                                  |
| [src/configs/formatter.ts](src/configs/formatter.ts)             | parser         | Parse and validate one `SKILL.toml`                                       |
| [src/configs/skillLoader.ts](src/configs/skillLoader.ts)         | loader         | Discover all skills in `skills/`, look them up by name                    |
| [src/domains/tool.ts](src/domains/tool.ts)                       | types          | The tool contract: definition, context, call, result, effect              |
| [src/domains/error.ts](src/domains/error.ts)                     | errors         | `EcoError` with a `code`, and subclasses                                  |
| [src/runtime/index.ts](src/runtime/index.ts)                     | types          | Agent, execution, event, checkpoint and memory types                      |
| [src/runtime/agent.ts](src/runtime/agent.ts)                     | loader         | Load `agents/general.toml`                                                |
| [src/runtime/execution.ts](src/runtime/execution.ts)             | data           | One "job": id + task + config + tools + skills + agent                    |
| [src/runtime/loop.ts](src/runtime/loop.ts)                       | **core**       | The agent loop                                                            |
| [src/runtime/history.ts](src/runtime/history.ts)                 | pure function  | Repair a saved conversation before resuming                               |
| [src/runtime/executionMemory.ts](src/runtime/executionMemory.ts) | persistence    | Save/load checkpoints atomically                                          |
| [src/providers/index.ts](src/providers/index.ts)                 | types          | The internal, vendor-neutral model API                                    |
| [src/providers/openrouter.ts](src/providers/openrouter.ts)       | adapter        | Internal format ⇄ OpenRouter (OpenAI-style)                               |
| [src/providers/anthropic.ts](src/providers/anthropic.ts)         | adapter        | Internal format ⇄ Anthropic Messages API (not wired into the CLI)         |
| [src/tools/catalog.ts](src/tools/catalog.ts)                     | registry       | All registered tools; builds a `ToolSet`                                  |
| [src/tools/toolSet.ts](src/tools/toolSet.ts)                     | collection     | The tools one execution may use; Zod → JSON Schema                        |
| [src/tools/fs.ts](src/tools/fs.ts)                               | tools          | `fs_read`, `fs_glob`, `fs_write`, `fs_mkdir` + `FileResolver`             |
| [src/tools/shell.ts](src/tools/shell.ts)                         | tool           | `shell_exec`                                                              |
| [src/tools/skill.ts](src/tools/skill.ts)                         | tool           | `open_skill`                                                              |
| [src/permissions/index.ts](src/permissions/index.ts)             | types          | Modes, decisions, policy and prompter interfaces                          |
| [src/permissions/policy.ts](src/permissions/policy.ts)           | logic          | Decide allow / ask / deny                                                 |
| [src/permissions/cliPrompter.ts](src/permissions/cliPrompter.ts) | UI             | Ask `Allow? [y/N]` in the terminal                                        |
| [src/utils/index.ts](src/utils/index.ts)                         | types          | `IRunLogger` interface                                                    |
| [src/utils/logger.ts](src/utils/logger.ts)                       | I/O            | Append JSON lines to `logs/<runId>.jsonl`                                 |
| [agents/general.toml](agents/general.toml)                       | data           | The agent: name, model, instructions                                      |
| [skills/\*/SKILL.toml](skills/)                                  | data           | Skills: name, description, instructions                                   |
| `logs/`                                                          | runtime output | One JSONL file per run (git-ignored)                                      |
| `memory/`                                                        | runtime output | One checkpoint JSON per execution (git-ignored)                           |
| [README.md](README.md)                                           | doc            | The original build guide ("The Pond")                                     |
| [FIXES.md](FIXES.md)                                             | doc            | What was broken and how it was fixed                                      |

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
4. **Logger.** `new Logger("<cwd>/logs", randomUUID())`. Each _run_ gets a new log file, even when resuming.
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
   {
     "type": "run_started",
     "runId": "55080c84-…",
     "task": "give me the last git log…",
     "timestamp": "…09:37:07.206Z"
   }
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
         "command": {
           "type": "string",
           "minLength": 1,
           "description": "The program to run, on its own. …"
         },
         "args": {
           "type": "array",
           "items": { "type": "string" },
           "default": [],
           "description": "…"
         }
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
{
  "ok": true,
  "content": "$ git log -1 --format=%H %s\n\n(exit code 0)\n\nSTDOUT:\n4b7a690… working, follow md and done"
}
```

For each result, `runTools()`:

1. logs it and yields `tool_result` (the CLI prints `[tool result] success`),
2. converts it with `toToolResultBlock()` into `{ type: "tool_result", toolUseId: "call_0a01…", content, isError: false }`,
3. on the **first** result, pushes **one** user message whose `content` is the `results` array. Later results are pushed into the _same array_, so that message grows in place,
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
  {
    "role": "system",
    "content": "You are an expert senior software engineer…"
  },
  { "role": "user", "content": "give me the last git log…" },
  {
    "role": "assistant",
    "content": "I'll get the last git log and status for you.",
    "tool_calls": [
      {
        "id": "call_0a01…",
        "type": "function",
        "function": {
          "name": "shell_exec",
          "arguments": "{\"command\":\"git\",…}"
        }
      },
      {
        "id": "call_3728…",
        "type": "function",
        "function": {
          "name": "shell_exec",
          "arguments": "{\"command\":\"git\",\"args\":[\"status\"]}"
        }
      }
    ]
  },
  { "role": "tool", "tool_call_id": "call_0a01…", "content": "$ git log …" },
  { "role": "tool", "tool_call_id": "call_3728…", "content": "$ git status …" }
]
```

See how one internal user message with two `tool_result` blocks became **two** `role: "tool"` messages. That's the adapter's job.

The model streams a Markdown answer ("Here's the latest git log and repository status: …") with **no** tool calls. The loop pushes the assistant message, checkpoints, sees `toolCalls.length === 0`, sets `outcome = "completed"` and breaks.

## Step 6: Finishing

- `finish("completed", "completed")` saves the final checkpoint with `status: "completed"` and writes the last log line:
  ```json
  {
    "type": "run_finished",
    "runId": "55080c84-…",
    "outcome": "completed",
    "iterations": 2,
    "usage": { "inputTokens": 3293, "outputTokens": 761, "costUsd": 0 }
  }
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

An **effect** classifies what a tool _can do_. The permission policy decides based on the effect, not the tool's name. That's what lets you add a new tool without touching permissions: just declare its effect.

| Effect  | Meaning                                 | Tools                  |
| ------- | --------------------------------------- | ---------------------- |
| `read`  | Only observes the workspace             | `fs_read`, `fs_glob`   |
| `write` | Changes files                           | `fs_write`, `fs_mkdir` |
| `exec`  | Runs arbitrary programs                 | `shell_exec`           |
| `meta`  | Affects the agent itself, not the world | `open_skill`           |

```ts
interface IToolContext {
  workspaceRoot: string;
  signal: AbortSignal;
}
```

What a handler gets besides its input: where the workspace is, and a signal that fires on Ctrl-C. The loop holds `Omit<IToolContext, "signal">` and adds the signal per call ([loop.ts:70](src/runtime/loop.ts#L70)).

```ts
interface IToolResult {
  ok: boolean;
  content: string;
  error?: string;
}
```

What a handler returns. **`content` is exactly what the model will see.** Rule: handlers **return** errors (`ok: false`), they don't throw. The model reads the error and adapts, like a client reading a 4xx body.

```ts
interface IToolDefinition<I = unknown> {
  name;
  description;
  schema: z.ZodType<I>;
  effect;
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
  model;
  modelSource;
  maxIterations;
  maxCostUsd;
  permissionMode;
  inputUsdPerMTok;
  outputUsdPerMTok;
};
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

  | Event         | When                              | CLI prints                           |
  | ------------- | --------------------------------- | ------------------------------------ |
  | `text`        | Each text fragment from the model | the fragment, inline                 |
  | `tool_start`  | The model requested a tool        | `[tool] shell_exec`                  |
  | `tool_result` | A tool finished (or was refused)  | `[tool result] success` or the error |
  | `done`        | End of run                        | the summary line                     |

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

| Field                                    | Purpose                                      |
| ---------------------------------------- | -------------------------------------------- |
| `provider`                               | Talks to the model                           |
| `execution`                              | Task, config, tools, agent                   |
| `toolContext`                            | `{ workspaceRoot }` passed to handlers       |
| `permissionPolicy`, `permissionPrompter` | The permission gate                          |
| `messages`                               | **The conversation: the agent's only state** |
| `memory`                                 | Checkpoint store                             |
| `logger`                                 | Run log                                      |
| `usage`                                  | Running token and cost totals                |
| `iterations`                             | Model calls made in this run                 |

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

- **Why check limits at the top of the loop?** So you never _start_ a call you're not allowed to make. Consequence: the cost check can't stop a call already in progress, so one call can overshoot the budget.
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

The contract promise: _whatever the vendor does, the loop receives these four event types, and `tool_use` events arrive with full, parsed input._ All the vendor mess stays inside the adapters.

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

| SDK event                                  | What the adapter does                                                                                           |
| ------------------------------------------ | --------------------------------------------------------------------------------------------------------------- |
| `message_start`                            | yield `usage` (initial input + output tokens)                                                                   |
| `content_block_start` (tool_use)           | remember `id` and `name`                                                                                        |
| `content_block_delta` / `text_delta`       | yield `text` immediately                                                                                        |
| `content_block_delta` / `input_json_delta` | append `partial_json` to a buffer                                                                               |
| `content_block_stop`                       | if a tool block was open: `JSON.parse` buffer, yield `tool_use`, reset                                          |
| `message_delta`                            | yield `usage` for **new** output tokens only (Anthropic sends a running total); yield `stop` with mapped reason |

Anthropic streams blocks one at a time (they don't interleave), so a single set of `toolId/toolName/toolInput` variables is enough, unlike OpenRouter where calls are keyed by index.

Mapping out is nearly 1:1 because the internal format is Anthropic-shaped: `toolUseId` → `tool_use_id`, `isError` → `is_error`, `inputSchema` → `input_schema`, `system` is a top-level field.

Anthropic doesn't report cost, which is why `inputUsdPerMTok`/`outputUsdPerMTok` exist.

## 4.5 `tools/`: what the agent can do

### [tools/catalog.ts](src/tools/catalog.ts): `ToolCatalog`

A registry: every tool the _program_ knows (`set`, `get`, `list`). `createToolSet(names)` picks a subset for one execution and throws if a name is unknown. Why two classes? The catalog is global; the toolset is **per agent**. Today they're identical (all six), but when agent files get a `tools = [...]` list, different agents get different toolsets from the same catalog.

### [tools/toolSet.ts](src/tools/toolSet.ts): `ToolSet`

The tools one execution may use: `get`, `list`, `has`, and `modelTools()`, which converts Zod to JSON Schema **once**, at the boundary, so no provider needs to know Zod. `toInputJsonSchema` uses `z.toJSONSchema(schema, { io: "input" })` so defaulted fields are optional (what the model may _send_), and strips the `$schema` key with a rest destructure.

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
- **`detached: true`** puts the child in its own **process group**. `process.kill(-pid, "SIGKILL")` (negative pid = the group) then kills the program _and everything it started_ (npm → node → …). Side effect: the child doesn't receive the terminal's Ctrl-C, so the code must kill it explicitly on abort, which it does.
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

| Mode                 | read  | meta     | write | exec  |
| -------------------- | ----- | -------- | ----- | ----- |
| `strict`             | allow | **deny** | deny  | deny  |
| `standard` (default) | allow | allow    | ask   | ask   |
| `yolo`               | allow | allow    | allow | allow |

Unknown modes fall back to strict; unknown effects fall back to deny (strict) or ask (standard). **Fail closed**: when in doubt, be restrictive.

Note two differences from [README.md](README.md)'s table: strict _denies_ write/exec rather than asking, and it also denies `meta`, so `open_skill` can't be used in strict mode. See [Part 9](#part-9-known-gaps-and-bugs).

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

`name` (must equal the folder name), `description` (goes into the system prompt, so it must say _when_ to use the skill), `instructions` (returned by `open_skill`).

---

# Part 5: Data flow in detail

This part follows your input through the code **call by call**: which method runs first, what it calls next, what arguments it passes, what comes back, and where that result goes. It ends when the answer is on your screen and the process exits.

It uses the same real run as [Part 3](#part-3-one-real-run-traced-end-to-end) (`"give me the last git log and it's description and status"`), so you can read the two side by side: Part 3 explains *why*, this part shows *exactly where in the code*.

**How to read the diagrams**

| Notation | Meaning |
| --- | --- |
| `A ─▶ B.method(x)` | A calls `B.method` with `x` |
| `◀── value` | the call returns `value` |
| `yield X ─▶` | a generator emits `X` to whoever is looping over it |
| `loop.ts:95` | file and line number. Paths are under `src/` (`loop.ts` = `src/runtime/loop.ts`) |
| `├─` / `└─` | the next call made inside the parent call, in order |

**Quick links to the methods you'll see most**

| Method | Where |
| --- | --- |
| `CliAgent.run` | [cli/index.ts:34](src/cli/index.ts#L34) |
| `AgentLoop.run` | [runtime/loop.ts:78](src/runtime/loop.ts#L78) |
| `AgentLoop.runTools` | [runtime/loop.ts:159](src/runtime/loop.ts#L159) |
| `AgentLoop.executeTool` | [runtime/loop.ts:49](src/runtime/loop.ts#L49) |
| `AgentLoop.checkpoint` | [runtime/loop.ts:202](src/runtime/loop.ts#L202) |
| `OpenRouterProvider.complete` | [providers/openrouter.ts:13](src/providers/openrouter.ts#L13) |
| `PermissionPolicy.check` | [permissions/policy.ts:10](src/permissions/policy.ts#L10) |
| `CliPermissionPrompter.confirm` | [permissions/cliPrompter.ts:9](src/permissions/cliPrompter.ts#L9) |
| `ExecutionMemory.save` / `load` | [runtime/executionMemory.ts:9](src/runtime/executionMemory.ts#L9) / [:19](src/runtime/executionMemory.ts#L19) |
| `Logger.write` | [utils/logger.ts:36](src/utils/logger.ts#L36) |

---

## 5.0 Two things to understand before the call graph

### A. The three generators run interleaved, not one after another

`CliAgent.run`, `AgentLoop.run` and `OpenRouterProvider.complete` are chained with `for await`. It's tempting to picture "the provider finishes, then the loop runs, then the CLI prints". That's **not** what happens.

- A `for await` asking for the next value **passes control down** one level.
- A `yield` **passes control back up** one level, and the generator **pauses** right there until it's asked for the next value.

So one text fragment travels all the way from the network to your terminal *before the next network chunk is even read*:

```
 CliAgent.run                    AgentLoop.run                   OpenRouterProvider.complete        network
 for await (… of loop.run())     for await (… of complete())     for await (chunk of stream)
 cli/index.ts:109                loop.ts:102                     openrouter.ts:33
      │                               │                               │                                │
  ①   │── "next event please" ───────▶│                               │                                │
  ②   │                               │── "next event please" ───────▶│                                │
  ③   │                               │                               │── read next SSE chunk ────────▶│
  ④   │                               │                               │◀── {delta:{content:"I'll"}} ───│
  ⑤   │                               │◀── yield {text,"I'll"} :50 ───│  (complete() PAUSES here)      │
  ⑥   │                               │ delta += "I'll"  :106         │                                │
  ⑦   │◀── yield {text,"I'll"} :107 ──│  (run() PAUSES here)          │                                │
  ⑧   │ process.stdout.write("I'll")  │                               │                                │
      │ cli/index.ts:111              │                               │                                │
  ⑨   │── "next event please" ───────▶│ resumes after :107            │                                │
  ⑩   │                               │── "next event please" ───────▶│ resumes after :50              │
  ⑪   │                               │                               │── read next SSE chunk ────────▶│
      │                              … and so on, one fragment at a time …                             │
```

That's why text appears word by word, and why, if the CLI is slow (for example, waiting for you at a permission prompt), nothing upstream races ahead. This is **pull-based backpressure**.

### B. Two separate flows of data

| | The conversation (`AgentLoop.messages`) | The event stream (`TAgentEvent`) |
| --- | --- | --- |
| Direction | **Down**: loop → provider → model API | **Up**: provider → loop → CLI and logger |
| Lifetime | Persistent: grows every iteration, saved to `memory/`, resent every call | Transient: printed or logged, then gone |
| Purpose | What the model knows | What *you* see |
| Written by | `loop.ts:132` (assistant), `:172` (tool results), `:217` (task) | `yield` in `loop.ts` |

Keep these apart in your head. Almost every step below either **adds to the conversation** or **emits an event**, and many do both.

---

## 5.1 The complete call tree, start to exit

This is the whole run on one page. Indentation means "called from inside the line above". The sections after this zoom into each phase.

```
bun run dev "…task…"  →  tsx src/cli/index.ts
│
├─ [module loading] every import is evaluated first (fs.ts, shell.ts read MAX_OUTPUT_BYTES here)
├─ config({ path: ".env" })                                         cli/index.ts:19
└─ new CliAgent().run()                                             cli/index.ts:130 → :34
   │
   │  ═══ PHASE 1: INPUT & STARTUP (5.2) ═══
   ├─ process.argv.slice(2) → task, executionId?                    cli :35-58
   ├─ new Loader()                                                  cli :60
   ├─ new ToolCatalog()                                             cli :61
   ├─ new SkillLoader("<cwd>/skills")                               cli :62
   ├─ skillLoader.discover()                                        cli :63 → skillLoader.ts:14
   │  ├─ readdir("skills/")                                         skillLoader.ts:17
   │  └─ for each directory:
   │     ├─ readFile("skills/<dir>/SKILL.toml")                     :23
   │     ├─ parseSkillToml(text, path)                              :24 → formatter.ts:8
   │     │  └─ smol-toml parse() → check 3 fields → ISkill          formatter.ts:9-27
   │     └─ skills.set(name, skill)                                 :27
   ├─ skillLoader.formatAvailableSkills(skillLoader.list())         cli :67 → skillLoader.ts:43, :39
   │  ◀── availableSkills: "- code-review: …\n- scientific-review: …"
   ├─ catalog.set(new FsRead()) … catalog.set(new OpenSkill(skillLoader))   cli :69-74 → catalog.ts:10
   ├─ catalog.createToolSet([6 names])                              cli :76 → catalog.ts:13
   │  └─ new ToolSet(tools)                                         toolSet.ts:7
   ├─ new Logger("<cwd>/logs", randomUUID())                        cli :77 → logger.ts:7
   ├─ new ExecutionMemory("<cwd>/memory")                           cli :79
   ├─ new AgentDefination("<cwd>/agents") → .load()                 cli :82-83 → agent.ts:14
   │  └─ readFile("agents/general.toml") → parse() → copy 4 fields  agent.ts:15-20
   ├─ loader.agentConfig(agent)                                     cli :84 → loadConfig.ts:20
   │  └─ isPermissionMode(mode)                                     loadConfig.ts:29 → :43
   │  ◀── TAgentConfig
   ├─ new AgentExecution(id, task, config, toolset, availableSkills, agent)   cli :87
   ├─ new OpenRouterProvider() → new OpenRouter({ apiKey })         cli :88 → openrouter.ts:6-11
   ├─ new PermissionPolicy(config.permissionMode)                   cli :90
   ├─ new CliPermissionPrompter()                                   cli :91
   ├─ new AgentLoop(provider, execution, {workspaceRoot}, policy, prompter, memory, logger)   cli :93
   ├─ new AbortController(); process.on("SIGINT", onSigint)         cli :97-106
   │
   └─ for await (event of agentloop.run(abort.signal))              cli :109 → loop.ts:78
      │
      │  ═══ PHASE 2: PREPARE THE RUN (5.3) ═══
      ├─ logger.start(task) → write() → mkdir + appendFile          loop.ts:79 → logger.ts:12, :36
      ├─ loadMemoryCheckpoint()                                     loop.ts:80 → :214
      │  ├─ memory.load(id) → readFile → ENOENT → null              executionMemory.ts:19-28
      │  │  (on --resume: JSON.parse → repairHistory(messages))     history.ts:12
      │  └─ messages.push({ role: "user", content: task })          loop.ts:217
      ├─ buildSystemPrompt()                                        loop.ts:85 → :177
      ├─ execution.tools.modelTools()                               loop.ts:86 → toolSet.ts:19
      │  └─ toInputJsonSchema(schema) → z.toJSONSchema(…)  × 6      toolSet.ts:28-31
      │
      └─ while (true)                                               loop.ts:90
         │
         │  ═══ PHASE 3: ONE MODEL CALL (5.4) ═══
         ├─ guards: aborted? / iterations ≥ max? / cost ≥ max?      loop.ts:91-94
         ├─ iterations++                                            :95
         ├─ for await (event of provider.complete(request))         :102 → openrouter.ts:13
         │  ├─ mapTools(tools)                                      openrouter.ts:15 → :147
         │  ├─ mapMessages(request) → mapMessage(m) for each m      :16 → :89 → :98
         │  ├─ client.chat.send({ chatRequest }, { signal })        :18
         │  └─ for await (chunk of stream)                          :33
         │     ├─ delta.content    → yield text ──▶ loop :104-108 → yield ──▶ CLI :111 stdout.write
         │     ├─ delta.toolCalls  → accumulateToolCall()           :56-58 → :168
         │     ├─ usage            → toUsageEvent() → yield usage ──▶ loop :124-126 → addUsage() :187
         │     └─ finishReason     → mapStopReason()                :66-68 → :199
         │     after the stream ends:
         │     ├─ parseToolArguments() → yield tool_use ──▶ loop :110-121
         │     │                                               ├─ agentContent.push / toolCalls.push
         │     │                                               ├─ logger.event(tool_start)       :118
         │     │                                               └─ yield tool_start ──▶ CLI :112
         │     └─ yield stop ──▶ loop :122 (ignored)
         ├─ flush text; messages.push({ role: "assistant", … })     loop.ts:130-132
         ├─ checkpoint("running") → memory.save()                   :133 → :202 → executionMemory.ts:9
         ├─ no tool calls? → outcome = "completed"; break           :137
         │
         │  ═══ PHASE 4: RUN THE TOOLS (5.5) ═══
         └─ yield* runTools(toolCalls, signal)                      :139 → :159
            └─ for each tool call:                                  :162
               ├─ executeTool(name, input, signal)                  :166 → :49
               │  ├─ tools.get(name)                                :50 → toolSet.ts:11
               │  ├─ tool.schema.safeParse(input)                   :57
               │  ├─ permissionPolicy.check(tool)                   :60 → policy.ts:10 → :28
               │  ├─ permissionPrompter.confirm({toolName, input}, signal)   :63 → cliPrompter.ts:9
               │  └─ tool.handler(data, {workspaceRoot, signal})    :70  (inner calls: 5.5.2)
               ├─ logger.event(tool_result)                         :168
               ├─ yield tool_result ──▶ CLI :113 console.log
               ├─ toToolResultBlock(id, result)                     :171 → :221
               ├─ 1st result? messages.push({ role: "user", content: results })   :172
               └─ checkpoint("running")                             :173
            (back to the top of while → iteration 2 → Phase 3 again)
      │
      │  ═══ PHASE 6: FINISH & OUTPUT (5.7) ═══
      ├─ finish(STATUS_FOR_OUTCOME[outcome], outcome)               loop.ts:150 → :196
      │  ├─ checkpoint(status) → memory.save()                      :197
      │  └─ logger.done({ outcome, iterations, usage })             :199 → logger.ts:27
      └─ yield done ──▶ CLI :114-119 → summary line, process.exitCode
   finally: process.off("SIGINT", onSigint)                         cli :124
.then(() => console.log("🤖 agent done 🤖"))                         cli :132
```

(Phase 5, persistence, happens *inside* phases 3, 4 and 6 at every `checkpoint()` and `logger.*` call. It has its own section, [5.6](#56-phase-5-persistence-calls-checkpoints-and-the-run-log).)

---

## 5.2 Phase 1: Input and startup

Everything in this phase happens once, inside [`CliAgent.run()`](src/cli/index.ts#L34), before the agent does anything. Its job is to turn **files + env vars + argv** into **one fully wired `AgentLoop`**.

### 5.2.1 Call by call

| # | Call | Input | Returns / produces | Stored in |
| --- | --- | --- | --- | --- |
| 1 | `config({ path: ".env" })` · cli:19 | `.env` file | fills `process.env` | global env |
| 2 | `process.argv.slice(2)` · cli:35 | `["give me the last…"]` | `task`, `executionId` (only with `--resume`) | locals |
| 3 | `new SkillLoader(cwd + "/skills")` · cli:62 | path | empty `skills` Map | `skillLoader` |
| 4 | `skillLoader.discover()` · skillLoader:14 | — | fills `skills` Map: `"code-review" → ISkill` … | `skillLoader.skills` |
| 4a | ↳ `readdir(skillsRoot)` · :17 | dir path | `Dirent[]` | local |
| 4b | ↳ `readFile(".../SKILL.toml")` · :23 | path | TOML text | local |
| 4c | ↳ `parseSkillToml(text, path)` · formatter:8 | TOML text | `ISkill { meta: {name, description, path}, instructions }` or throws | local |
| 4d | ↳ `skills.set(name, skill)` · :27 | — | — | Map |
| 5 | `formatAvailableSkills(list())` · skillLoader:43 | `ISkill[]` | `"- code-review: …\n- scientific-review: …"` | `availableSkills` |
| 6 | `catalog.set(new FsRead())` … × 6 · catalog:10 | tool objects | — | `catalog.tools` Map |
| 7 | `catalog.createToolSet(names)` · catalog:13 | 6 names | `ToolSet` (throws on an unknown name) | `toolset` |
| 8 | `new Logger(cwd + "/logs", randomUUID())` · logger:7 | dir, run id | logger with `filePath = logs/<runId>.jsonl` (prints the path) | `logger` |
| 9 | `new ExecutionMemory(cwd + "/memory")` · cli:79 | dir | store | `memory` |
| 10 | `agent.load()` · agent:14 | `agents/general.toml` | fills `name, model, description, instructions` | `agent` |
| 11 | `loader.agentConfig(agent)` · loadConfig:20 | `agent` + `process.env` | `TAgentConfig { model, modelSource, maxIterations, maxCostUsd, permissionMode, …Tok }` or throws `ConfigError` | `agentConfig` |
| 12 | `new AgentExecution(…)` · execution:13 | id (new UUID or `--resume` id), task, config, toolset, skills text, agent | the job object | `execution` |
| 13 | `new OpenRouterProvider()` · openrouter:6 | `OPENROUTER_API_KEY` | provider with SDK client (throws if no key) | `provider` |
| 14 | `new PermissionPolicy(mode)` / `new CliPermissionPrompter()` · cli:90-91 | mode | policy, prompter | locals |
| 15 | `new AgentLoop(…7 deps)` · loop:30 | all of the above | loop with `messages = []`, `usage = 0`, `iterations = 0` | `agentloop` |
| 16 | `new AbortController()` + `process.on("SIGINT")` · cli:97-106 | — | `abort.signal` | `abort` |

### 5.2.2 How the pieces are assembled into the loop

```
 SOURCES                        CALLS                                   OBJECTS
 ───────                        ─────                                   ───────
 argv ─────────────────────────────────────────────────────────────▶ task, executionId ─────────────┐
                                                                                                     │
 skills/*/SKILL.toml ─▶ SkillLoader.discover() ─▶ parseSkillToml() ─▶ skills Map ─┬─▶ formatAvailableSkills()
                                                                                   │        │
                                                                                   │        ▼
                                                                                   │   availableSkills ──────┤
                                                                                   ▼                          │
 tool classes ─▶ new FsRead/FsGlob/FsWrite/FsMkdir/ShellExec, new OpenSkill(skillLoader)                     │
                        │ catalog.set() ×6                                                                    │
                        ▼                                                                                     │
                   ToolCatalog ─▶ createToolSet([...]) ─▶ ToolSet ──────────────────────────────────────────┤
                                                                                                              │
 agents/general.toml ─▶ AgentDefination.load() ─▶ agent ─┬───────────────────────────────────────────────────┤
                                                          ▼                                                   │
 .env ─▶ process.env ─────────────────────▶ Loader.agentConfig(agent) ─▶ TAgentConfig ──────────────────────┤
                                                          │                                                   ▼
                                                          │               new AgentExecution(id, task, config, toolset,
                                                          │                                  availableSkills, agent)
                                                          │                                                   │
 OPENROUTER_API_KEY ─▶ new OpenRouterProvider() ──────────┼──────────────┐                                    │
                       new PermissionPolicy(config.permissionMode) ◀─────┘  │                                 │
                       new CliPermissionPrompter() ─────────────────────────┤                                 │
 memory/ ────────────▶ new ExecutionMemory() ───────────────────────────────┤                                 │
 logs/ ──────────────▶ new Logger(runId) ───────────────────────────────────┤                                 │
 cwd ────────────────▶ { workspaceRoot: process.cwd() } ────────────────────┤                                 │
                                                                             ▼                                 ▼
                              new AgentLoop(provider, execution, {workspaceRoot}, policy, prompter, memory, logger)
                                                                             │
                                                                             ▼
                                             for await (event of agentloop.run(abort.signal))   cli:109
```

Nothing has talked to the model yet. Phase 1 only reads local files and builds objects. If anything is misconfigured (no API key, bad `permissionMode`, broken `SKILL.toml`), it fails here, before any cost is incurred.

---

## 5.3 Phase 2: Preparing the run

The CLI's `for await` makes the first request for an event, which starts executing the body of [`AgentLoop.run()`](src/runtime/loop.ts#L78). Before the first model call, it sets up the three things every request needs: **messages**, **system** and **tools**.

```
AgentLoop.run(signal)                                                   loop.ts:78
│
├─① logger.start(execution.task)                                        loop.ts:79 → logger.ts:12
│     └─ write({ type:"run_started", runId, task, timestamp })          logger.ts:36
│          ├─ mkdir("logs/", { recursive: true })                       :37
│          └─ appendFile("logs/<runId>.jsonl", JSON + "\n")             :38
│
├─② loadMemoryCheckpoint()                                              loop.ts:214
│     ├─ memory.load(execution.id)                                      :215 → executionMemory.ts:19
│     │    ├─ pathFor(id) ─▶ "memory/<id>.json"                         :20 → :40
│     │    ├─ readFile(path, "utf-8")                                   :24
│     │    │    ├─ error.code === "ENOENT" ──────────▶ return null      :27   ◀── NEW RUN (our example)
│     │    │    └─ any other error ──────────────────▶ throw            :28
│     │    └─ JSON.parse(content)                                       :32
│     │         ├─ ok ───────────────────────────────▶ return checkpoint     ◀── --resume
│     │         └─ fails ────────────────────────────▶ throw EcoError("CHECKPOINT_CORRUPT")   :36
│     │
│     ├─ if (checkpoint) messages.push(...repairHistory(checkpoint.messages))   :216 → history.ts:12
│     │    ├─ filter(m => m.content.length > 0)                         history.ts:14
│     │    ├─ findLastIndex(role === "assistant")                       :16
│     │    ├─ toolUseIds = its tool_use block ids                       :19  (via blocks() :33)
│     │    ├─ answered = tool_result ids in later messages              :20-22
│     │    ├─ missing = toolUseIds − answered                           :23
│     │    └─ missing? push { role:"user", content:[ "Interrupted…" tool_results ] }   :26-29
│     │
│     └─ messages.push({ role: "user", content: execution.task })       loop.ts:217
│
├─③ const { model, maxIterations, maxCostUsd } = execution.config       loop.ts:82
│
├─④ system = buildSystemPrompt()                                        loop.ts:85 → :177
│     └─ [ agent.instructions.trim(),
│          "[AVAILABLE SKILLS]",
│          "When a task matches one of these skills, call open_skill …",
│          availableSkills ].join("\n\n")
│
└─⑤ tools = execution.tools.modelTools()                                loop.ts:86 → toolSet.ts:19
      └─ list().map(t ⇒ { name, description, inputSchema: toInputJsonSchema(t.schema) })
           └─ z.toJSONSchema(schema, { io: "input" }), then drop "$schema"   toolSet.ts:28-32
```

**State after Phase 2 (new run):**

```
messages = [ { role: "user", content: "give me the last git log and it's description and status" } ]
system   = "You are an expert senior software engineer … [AVAILABLE SKILLS] … - code-review: … - scientific-review: …"
tools    = [ {name:"fs_read", …}, {name:"fs_glob", …}, {name:"fs_write", …},
             {name:"fs_mkdir", …}, {name:"shell_exec", …}, {name:"open_skill", …} ]   (JSON Schema, no Zod)
usage    = { inputTokens: 0, outputTokens: 0, costUsd: 0 }
iterations = 0
```

`system` and `tools` are built **once** and reused for every iteration. Only `messages` changes.

---

## 5.4 Phase 3: One model call (request down, events up)

This is one pass through the top half of the `while` loop. It covers how the request is built and translated, how the stream is read, and how each piece of the reply reaches the terminal and the conversation.

### 5.4.1 Sequence diagram

```
 CliAgent.run           AgentLoop.run                      OpenRouterProvider.complete         OpenRouter SDK / HTTPS
 cli/index.ts           loop.ts                            openrouter.ts
     │                       │                                     │                                 │
     │                       │ signal.aborted?          :91        │                                 │
     │                       │ iterations >= max?       :92        │                                 │
     │                       │ usage.costUsd >= max?    :94        │                                 │
     │                       │ iterations++             :95        │                                 │
     │                       │ request = { model, system,          │                                 │
     │                       │   messages, tools, signal } :97     │                                 │
     │                       │ toolCalls=[], agentContent=[],      │                                 │
     │                       │ delta=""               :99-101      │                                 │
     │                       │                                     │                                 │
     │                       │── complete(request) ───────────────▶│ :13                             │
     │                       │                                     │ tools    = mapTools()    :15→:147
     │                       │                                     │ messages = mapMessages() :16→:89
     │                       │                                     │   ├ push {role:"system"}   :91  │
     │                       │                                     │   └ mapMessage(m) each     :98  │
     │                       │                                     │── chat.send({chatRequest:{model,│
     │                       │                                     │   messages, tools, maxTokens:4096,
     │                       │                                     │   stream:true}}, {signal}) :18 ─▶│
     │                       │                                     │                                 │── POST (SSE) ──▶ model
     │                       │                                     │ toolCalls = new Map()   :28     │
     │                       │                                     │                                 │
     │                       │                                     │◀─ chunk {delta:{content:"I'll"}}│
     │                       │◀── yield {type:"text", delta} :50 ──│                                 │
     │                       │ delta += event.delta     :106       │                                 │
     │◀─ yield {text} :107 ──│                                     │                                 │
     │ stdout.write(delta)   │                                     │                                 │
     │ cli:111               │                                     │                                 │
     │        … repeated for every text chunk …                    │                                 │
     │                       │                                     │◀─ chunk {delta:{toolCalls:[     │
     │                       │                                     │     {index:0, id:"call_0a01…",  │
     │                       │                                     │      function:{name:"shell_exec",
     │                       │                                     │      arguments:"{\"comm"}}]}}   │
     │                       │                                     │ accumulateToolCall() :57→:168   │
     │                       │                                     │   Map[0] = {id, name, args:"{\"comm"}
     │                       │                                     │◀─ chunk {toolCalls:[{index:0,   │
     │                       │                                     │     arguments:"and\":\"git\"…"}]}
     │                       │                                     │ accumulateToolCall()            │
     │                       │                                     │   Map[0].arguments += "and…"    │
     │                       │                                     │◀─ chunk {toolCalls:[{index:1,…}]}  (2nd call, same way)
     │                       │                                     │◀─ chunk {finishReason:"tool_calls", usage:{…}}
     │                       │◀── yield usage (toUsageEvent :158) ─│ :39-43 / :60-63                 │
     │                       │ addUsage(event)  :125 → :187        │ mapStopReason → "tool_use" :67  │
     │                       │   usage.inputTokens  += …           │                                 │
     │                       │   usage.outputTokens += …           │                                 │
     │                       │   usage.costUsd += costUsd ?? price │                                 │
     │                       │                                     │◀─ stream ends ──────────────────│
     │                       │                                     │ for tool of Map.values()   :72  │
     │                       │                                     │   parseToolArguments() :77→:191 │
     │                       │◀── yield {tool_use, id, name,       │                                 │
     │                       │           input} :73 ───────────────│                                 │
     │                       │ if (delta) agentContent.push(text)  │                                 │
     │                       │   delta = ""          :112-115      │                                 │
     │                       │ agentContent.push(tool_use) :116    │                                 │
     │                       │ toolCalls.push({id,input,name}) :117│                                 │
     │                       │ logger.event(tool_start)  :118 ─────┼─▶ logs/<runId>.jsonl            │
     │◀─ yield tool_start ───│ :119                                │                                 │
     │ console.log("[tool]   │                                     │                                 │
     │  shell_exec") cli:112 │                                     │                                 │
     │        … same for the 2nd tool_use …                        │                                 │
     │                       │◀── yield {stop, "tool_use"} :82 ────│ generator returns               │
     │                       │ case "stop": break  :122            │                                 │
     │                       │ (for await exits)                   │                                 │
     │                       │                                     │
     │                       │ if (delta) agentContent.push(text)            :130
     │                       │ messages.push({role:"assistant", content: agentContent})   :132
     │                       │ checkpoint("running") ─▶ memory.save()        :133  (5.6)
     │                       │ toolCalls.length === 0 ?                      :137
     │                       │    yes ─▶ outcome = "completed"; break  ─▶ Phase 6
     │                       │    no  ─▶ yield* runTools(toolCalls, signal) :139 ─▶ Phase 4
```

### 5.4.2 What `mapMessage()` does to each internal message

[`mapMessage()`](src/providers/openrouter.ts#L98) is where the internal (Anthropic-shaped) conversation becomes the OpenAI-style format OpenRouter expects:

```
internal IModelMessage                                    OpenRouter TChatMessages
──────────────────────                                    ────────────────────────
{ role:"user", content:"give me…" }       (string) ─────▶ { role:"user", content:"give me…" }

{ role:"assistant", content:[                             { role:"assistant",
    {type:"text", text:"I'll get…"},          ─────────▶    content:"I'll get…",            ← texts joined
    {type:"tool_use", id:"call_0a01…",                       toolCalls:[
     name:"shell_exec", input:{…}},                            {id:"call_0a01…", type:"function",
    {type:"tool_use", id:"call_3728…", …}                        function:{name:"shell_exec",
]}                                                                 arguments: JSON.stringify(input)}},
                                                                {id:"call_3728…", …} ] }

{ role:"user", content:[                                  { role:"tool", toolCallId:"call_0a01…", content:"$ git log…" }
    {type:"tool_result", toolUseId:"call_0a01…", …}, ───▶ { role:"tool", toolCallId:"call_3728…", content:"$ git status…" }
    {type:"tool_result", toolUseId:"call_3728…", …}       ← ONE internal message becomes TWO wire messages
]}
```

### 5.4.3 What changed after Phase 3

```
messages = [
  { role:"user",      content:"give me the last git log…" },
  { role:"assistant", content:[ text "I'll get the last git log and status for you.",
                                tool_use call_0a01… shell_exec {command:"git", args:["log","-1","--format=%H %s"]},
                                tool_use call_3728… shell_exec {command:"git", args:["status"]} ] }   ← NEW
]
toolCalls = [ {id:"call_0a01…", …}, {id:"call_3728…", …} ]     (local to this iteration)
usage     = { inputTokens: …, outputTokens: …, costUsd: … }    (increased)
disk      = memory/<id>.json saved with status "running"; 2 × tool_start in logs/<runId>.jsonl
terminal  = "I'll get the last git log and status for you."  "[tool] shell_exec"  "[tool] shell_exec"
```

---

## 5.5 Phase 4: Running the tools

### 5.5.1 `runTools` → `executeTool`, with every branch

```
yield* runTools(toolCalls, signal)                                        loop.ts:139 → :159
│  results: IContentBlock[] = []                                          :160
│
└─ for (const tc of toolCalls)                                            :162
   │
   ├─ signal.aborted ?                                                    :164
   │     yes ─▶ result = { ok:false, error:"Cancelled by the user before this tool ran." }
   │     no  ─▶ result = await executeTool(tc.name, tc.input, signal)     :166 → :49
   │             │
   │             ├─① tool = execution.tools.get(toolName)                  :50 → toolSet.ts:11
   │             │     undefined ─▶ tools.list() names                     :52
   │             │                  return { ok:false, "Unknown tool "X". Available tools: …" }   :53
   │             │
   │             ├─② parsedInput = tool.schema.safeParse(input)            :57  (Zod)
   │             │     !success ─▶ return { ok:false, "Invalid input for X:\n" + z.prettifyError() }   :58
   │             │     success  ─▶ parsedInput.data   (defaults applied: args ⇒ [], overwrite ⇒ false)
   │             │
   │             ├─③ decision = permissionPolicy.check(tool)               :60 → policy.ts:10
   │             │     switch (mode)                                       policy.ts:11
   │             │       "standard" ─▶ checkStandard(tool.effect)          :28   read/meta → allow, write/exec → ask
   │             │       "strict"   ─▶ checkStrict(tool.effect)            :19   read → allow, else → deny
   │             │       "yolo"     ─▶ "allow"                             :14
   │             │     "deny"  ─▶ return { ok:false, "X is not allowed in the current permission mode." }   :61
   │             │     "allow" ─▶ go to ④
   │             │     "ask"   ─▶ allowed = await permissionPrompter.confirm({ toolName, input: data }, signal)
   │             │                  │                                      :63 → cliPrompter.ts:9
   │             │                  ├─ readline = createInterface({ input: stdin, output: stdout })   :10
   │             │                  ├─ readline.on("SIGINT", () ⇒ process.emit("SIGINT"))             :12
   │             │                  ├─ text = preview(input)  → JSON.stringify(input,null,2), cap 2000  :16 → :30
   │             │                  ├─ ans = await readline.question("Permission required … Allow? [y/N] ", { signal })  :15
   │             │                  │     (the whole program is waiting for your keypress here)
   │             │                  ├─ return ["y","yes"].includes(ans.trim().toLowerCase())   :19
   │             │                  ├─ catch: signal.aborted ? return false                    :21-24
   │             │                  └─ finally: readline.close()                               :26
   │             │                signal.aborted ─▶ return { ok:false, "Cancelled by the user." }   :64
   │             │                !allowed       ─▶ return { ok:false, "The user denied this action." }   :66
   │             │
   │             └─④ try { return await tool.handler(parsedInput.data, { ...toolContext, signal }) }   :70
   │                   catch (error) ─▶ return { ok:false, error: error.message }            :71-75
   │                   (what each handler does inside: 5.5.2)
   │             ◀── IToolResult { ok, content, error? }
   │
   ├─ logger.event({ type:"tool_result", toolName, result })             :168 → logger.ts:20 → write()
   ├─ yield { type:"tool_result", toolName, result }                     :169
   │     ─▶ CLI: console.log("[tool result] " + (ok ? "success" : error))  cli:113
   ├─ block = toToolResultBlock(tc.id, result)                           :171 → :221
   │     ok  ─▶ { type:"tool_result", toolUseId, content: result.content, isError:false }
   │     !ok ─▶ { type:"tool_result", toolUseId, content:"Error: <error>\n\n<content>", isError:true }
   ├─ results.push(block)                                                :171
   ├─ if (results.length === 1) messages.push({ role:"user", content: results })   :172
   │     (the message holds a REFERENCE to `results`, so the next pushes grow the same message)
   └─ checkpoint("running") ─▶ memory.save()                             :173  (5.6)

runTools ends ─▶ back to the top of the while loop (loop.ts:90) ─▶ Phase 3 again with the longer messages
```

### 5.5.2 Inside each tool handler

**`fs_read`**: [FsRead.handler](src/tools/fs.ts#L69)

```
FsRead.handler({ path }, ctx)                                    fs.ts:69
├─ fileResolver.resolveFilePath(ctx.workspaceRoot, input.path)   :71 → :32
│    ├─ rootDir       = path.resolve(workspaceRoot)              :33
│    ├─ requestedFile = path.resolve(rootDir, requestedPath)     :34
│    ├─ relativePath  = path.relative(rootDir, requestedFile)    :35
│    └─ starts with ".." or absolute? ─▶ { ok:false, "Path is outside the workspace" }   :37-40
├─ readFile(path, "utf-8")                                       :74
├─ fileResolver.truncateOutput(content)                          :75 → :43
│    └─ > MAX_OUTPUT_BYTES? keep the first 30 KB + "...[truncated N bytes]..."
└─ ◀── { ok:true, content }     (any throw ─▶ catch ─▶ { ok:false, error })   :76-78
```

**`fs_glob`**: [FsGlob.handler](src/tools/fs.ts#L106)

```
FsGlob.handler({ pattern }, ctx)                                 fs.ts:106
├─ absolute pattern or a ".." segment? ─▶ { ok:false, "The pattern must be relative…" }   :109-110
├─ for await (match of glob(pattern, { cwd: workspaceRoot, exclude }))   :114   (node:fs/promises)
│    ├─ isInIgnoredDir(match)?  (node_modules / .git) ─▶ skip    :117 → :101
│    ├─ resolveFilePath(root, match).ok === false?   ─▶ skip    :118
│    └─ matches.push(match)                                      :119
├─ matches.length === 0 ─▶ { ok:true, 'No files matched "…"' }   :122
├─ shown = matches.slice(0, 200); note if more                   :124-126
└─ ◀── { ok:true, content: truncateOutput(shown.join("\n") + note) }   :127
```

**`fs_write`**: [FsWrite.handler](src/tools/fs.ts#L150)

```
FsWrite.handler({ filePath, content, overwrite }, ctx)           fs.ts:150
├─ resolveFilePath(root, filePath)  → outside? error             :152-153
├─ if (!overwrite)                                               :155
│    └─ access(path) succeeds (file exists) ─▶ { ok:false, "File protection fault: … already exists…" }   :157-162
│       access throws (file missing)        ─▶ continue          :163
├─ mkdir(dirname(path), { recursive: true })                     :167
├─ writeFile(path, content, "utf-8")                             :168
└─ ◀── { ok:true, "Successfully wrote N bytes to <filePath>" }   :170-173
```

**`fs_mkdir`**: [FsMkdir.handler](src/tools/fs.ts#L195): `resolveFilePath()` → `mkdir(path, { recursive: true })` → `{ ok:true, "Successfully created dir: …" }`.

**`shell_exec`**: [ShellExec.handler](src/tools/shell.ts#L31) (the one our example used)

```
ShellExec.handler({ command:"git", args:["status"] }, ctx)       shell.ts:31
└─ return new Promise(resolve ⇒ {                                 :32
   ├─ child = spawn("git", ["status"], { cwd, shell:false,
   │                  stdio:["ignore","pipe","pipe"], detached:true })   :36-42
   ├─ stdout = new OutputCollector(); stderr = new OutputCollector()     :44-45
   ├─ child.stdout.on("data", chunk ⇒ stdout.push(chunk))                 :46 → :93
   ├─ child.stderr.on("data", chunk ⇒ stderr.push(chunk))                 :47 → :93
   │     push(): stop storing past 10 MB, count dropped bytes
   ├─ timer = setTimeout(() ⇒ { timedOut = true; killGroup() }, 60_000)   :54
   ├─ ctx.signal.addEventListener("abort", killGroup, { once:true })      :55
   │     killGroup() = process.kill(-child.pid, "SIGKILL")                :50-53
   │
   ├─ on "error" (program couldn't start)                                 :61
   │     cleanup(); resolve({ ok:false, 'Could not start "git": …' })
   │
   └─ on "close" (code, signal)                                           :66
         ├─ cleanup()  → clearTimeout + removeEventListener                :56-59
         ├─ status = "timed out…" | "cancelled by the user" | "killed by X" | "exit code 0"   :68-71
         ├─ content = [ "$ git status", "(exit code 0)",
         │              "STDOUT:\n" + stdout.text(), "STDERR:\n" + stderr.text() ]
         │              .filter(Boolean).join("\n\n")                       :74-79 → text() :100
         │     text(): ≤ 30 KB → whole thing; else first 15 KB + "...[truncated]..." + last 15 KB
         └─ code === 0 ? resolve({ ok:true, content }) : resolve({ ok:false, error: status, content })   :81-82
   })
```

**`open_skill`**: [OpenSkill.handler](src/tools/skill.ts#L23)

```
OpenSkill.handler({ name:"code-review" }, _)                     skill.ts:23
├─ skillLoader.open(name)                                        :25 → skillLoader.ts:33
│    └─ skills.get(name) ?? throw Error("Skill not found")
└─ ◀── { ok:true, content: skill.instructions }   (throw ─▶ { ok:false, error })   :26-36
```

### 5.5.3 What changed after Phase 4

```
messages = [
  { role:"user",      content:"give me the last git log…" },
  { role:"assistant", content:[ text, tool_use call_0a01…, tool_use call_3728… ] },
  { role:"user",      content:[ tool_result call_0a01… "$ git log -1 …(exit code 0)…STDOUT: 4b7a690 working, follow md and done",
                                tool_result call_3728… "$ git status …(exit code 0)…STDOUT: On branch main …" ] }   ← NEW
]
disk     = memory/<id>.json saved twice (after each result); 2 × tool_result in logs/<runId>.jsonl
terminal = 2 permission prompts (answered y), "[tool result] success" × 2
```

Now the `while` loop goes back to the top. **Iteration 2** repeats Phase 3 with this longer `messages` array. This time the model replies with only text, so `toolCalls.length === 0` at `loop.ts:137` and the loop breaks with `outcome = "completed"`.

---

## 5.6 Phase 5: Persistence calls (checkpoints and the run log)

These two paths are called from inside the other phases.

### 5.6.1 Checkpoint: `checkpoint(status)` → `memory.save()`

```
AgentLoop.checkpoint(status)                                         loop.ts:202
└─ memory.save({                                                     :203 → executionMemory.ts:9
       executionId: execution.id, agent: { name }, task,
       iteration: this.iterations, status, messages: this.messages,
       updatedAt: new Date().toISOString() })
   ├─ mkdir("memory/", { recursive: true })                          :10
   ├─ filePath = pathFor(executionId) ─▶ "memory/<id>.json"          :11 → :40
   ├─ tempPath = filePath + "." + process.pid + ".tmp"               :14
   ├─ writeFile(tempPath, JSON.stringify(checkpoint))                :15
   └─ rename(tempPath, filePath)          ← atomic swap              :16
```

### 5.6.2 Run log: `logger.*` → `write()`

```
logger.start(task)   ─▶ { type:"run_started",  runId, task, timestamp }           logger.ts:12
logger.event(event)  ─▶ { type:"event", event:{tool_start|tool_result}, timestamp } :20
logger.done(summary) ─▶ { type:"run_finished", runId, outcome, iterations, usage, timestamp }   :27
        │
        └─ write(data)                                                             :36
             ├─ mkdir(dirname(filePath), { recursive: true })                      :37
             └─ appendFile("logs/<runId>.jsonl", JSON.stringify(data) + "\n")      :38
```

### 5.6.3 When each one is called

| Moment | Caller | `memory/<executionId>.json` | `logs/<runId>.jsonl` |
| --- | --- | --- | --- |
| Run starts | `loop.ts:79` | — | `run_started` |
| Model requests a tool | `loop.ts:118` | — | `event: tool_start` |
| Model reply finished | `loop.ts:133` | checkpoint `running` | — |
| Each tool result | `loop.ts:168`, `:173` | checkpoint `running` | `event: tool_result` |
| Run ends (any outcome) | `loop.ts:197`, `:199` | checkpoint with final status | `run_finished` |

For our example run: 5 checkpoint writes (after reply 1, after each of 2 tool results, after reply 2, final) and 6 log lines.

---

## 5.7 Phase 6: Finishing and output

```
while loop exits with an outcome (loop.ts):
   :91   signal.aborted                  ─▶ outcome = "cancelled"
   :92   iterations >= maxIterations     ─▶ outcome = "max_iterations"
   :94   usage.costUsd >= maxCostUsd     ─▶ outcome = "budget_exceeded"
   :137  toolCalls.length === 0          ─▶ outcome = "completed"            ◀── our example
   :141  catch + signal.aborted          ─▶ outcome = "cancelled"
   :141  catch + NOT aborted             ─▶ finish("failed","failed") :144 ; throw :145
                                               └─▶ out of run() ─▶ out of CLI for-await
                                                   ─▶ .catch  cli:133 ─▶ console.error ─▶ process.exit(1)
        │
        ▼
finish(STATUS_FOR_OUTCOME[outcome], outcome)                           loop.ts:150 → :196
│   STATUS_FOR_OUTCOME: completed→completed, cancelled→cancelled,
│                       max_iterations→paused, budget_exceeded→paused   :10-16
├─ checkpoint(status) ─▶ memory.save()                                  :197
└─ logger.done({ outcome, iterations, usage })                         :199
        │
        ▼
yield { type:"done", outcome, iterations, usage: { ...usage } }        loop.ts:151
        │
        ▼
CliAgent.run: case "done"                                              cli:114
├─ tokens = usage.inputTokens + usage.outputTokens                      :116
├─ console.log(`[completed] 2 iterations · 4054 tokens · $0.0000 · execution 74115231-…`)   :117
└─ process.exitCode = EXIT_CODES[outcome]   (completed → 0)            :118
        │
        ▼
run() generator returns ─▶ for await ends ─▶ finally: process.off("SIGINT", onSigint)   cli:123-125
        │
        ▼
CliAgent.run() promise resolves ─▶ .then(() ⇒ console.log("🤖 agent done 🤖"))          cli:132
        │
        ▼
event loop empty ─▶ Node exits with process.exitCode (0)
```

---

## 5.8 Alternate paths

The example above is the "happy path". These are the other routes through the same code.

### 5.8.1 `--resume <id> "<new task>"`

```
argv = ["--resume", "74115231-…", "now", "show", "3", "commits"]
├─ executionId = args[1]; task = args.slice(2).join(" ")             cli:40-51
├─ new AgentExecution(executionId, …)    (reuses the id, not a new UUID)   cli:87
├─ new Logger(logs/, NEW runId)          (a new log file for this run)      cli:77
└─ run() ─▶ loadMemoryCheckpoint()                                    loop.ts:214
      ├─ memory.load("74115231-…") ─▶ checkpoint (JSON.parse ok)
      ├─ repairHistory(checkpoint.messages) ─▶ [old messages (+ "Interrupted" results if needed)]
      └─ messages.push({ role:"user", content:"now show 3 commits" })
   ─▶ continues exactly like a normal run, but the model sees the whole previous conversation
```

### 5.8.2 Ctrl-C while the model is streaming

```
Ctrl-C ─▶ SIGINT ─▶ onSigint()                                       cli:98
   └─ first time: console.log("Cancelling…"); abort.abort()          cli:103-104
        └─ SDK's fetch is aborted ─▶ the stream iterator THROWS inside openrouter.ts:33
             ─▶ exception leaves provider.complete()
             ─▶ exception leaves for await at loop.ts:102
                  (lines :130-139 are skipped, so the partial assistant text is NOT added to messages)
             ─▶ catch (loop.ts:141): signal.aborted ─▶ outcome = "cancelled"   :147
             ─▶ finish("cancelled") ─▶ checkpoint + logger.done
             ─▶ yield done ─▶ CLI prints "[cancelled] …", exitCode = 130
Second Ctrl-C ─▶ onSigint sees signal.aborted ─▶ process.exit(130) immediately   cli:99-102
```

### 5.8.3 Ctrl-C while the permission prompt is waiting

```
Ctrl-C ─▶ readline catches it ─▶ readline "SIGINT" handler           cliPrompter.ts:12
   ─▶ process.emit("SIGINT") ─▶ onSigint() ─▶ abort.abort()           cli:98-104
   ─▶ readline.question() rejects (it was given the signal)          cliPrompter.ts:15
   ─▶ catch: signal.aborted ─▶ return false ; finally close()        :21-26
─▶ executeTool: signal.aborted ─▶ { ok:false, "Cancelled by the user." }   loop.ts:64
─▶ runTools: logs + yields that result, adds tool_result block, checkpoints
─▶ remaining tool calls: signal.aborted ─▶ "Cancelled by the user before this tool ran."   :164
─▶ back to while: :91 signal.aborted ─▶ outcome "cancelled" ─▶ finish ─▶ done ─▶ exit 130
```

### 5.8.4 Ctrl-C while `shell_exec` is running

```
abort.abort() ─▶ "abort" listener registered at shell.ts:55 ─▶ killGroup()
   ─▶ process.kill(-pid, "SIGKILL")   (kills git/npm AND its children)
   ─▶ child "close"(null, "SIGKILL") ─▶ status = "cancelled by the user"   shell.ts:69
   ─▶ resolve({ ok:false, error:"cancelled by the user", content })
─▶ same as 5.8.3 from runTools onwards
```

### 5.8.5 You answer "n" at the prompt

```
confirm() ─▶ false ─▶ executeTool returns { ok:false, error:"The user denied this action." }   loop.ts:66
─▶ toToolResultBlock ─▶ { tool_result, content:"Error: The user denied this action.", isError:true }
─▶ next iteration: the model reads that result and tries another approach or explains
   (the run does NOT stop; a denial is just data for the model)
```

### 5.8.6 The model sends bad arguments

```
tool_use shell_exec { cmd:"git status" }        (wrong field name)
─▶ schema.safeParse fails ─▶ { ok:false, "Invalid input for shell_exec:\n✖ Invalid input: expected string, received undefined\n  → at command" }   loop.ts:58
─▶ no permission prompt, no handler call
─▶ next iteration: the model sees the Zod error and retries with { command:"git", args:["status"] }
```

### 5.8.7 A limit is reached

```
top of while: iterations >= maxIterations (loop.ts:92) or costUsd >= maxCostUsd (:94)
─▶ outcome "max_iterations" / "budget_exceeded"
─▶ finish(STATUS_FOR_OUTCOME → "paused") ─▶ checkpoint status "paused"
─▶ done ─▶ exit code 1 / 4 ─▶ you can continue later with --resume
```

---

## 5.9 How the data changes shape: from keyboard to screen

The same information, followed through every transformation in the example run:

| # | Where | Type | Value (abridged) |
| --- | --- | --- | --- |
| 1 | Your shell | text | `bun run dev "give me the last git log…"` |
| 2 | `process.argv.slice(2)` · cli:35 | `string[]` | `["give me the last git log…"]` |
| 3 | `task` · cli:53 | `string` | `"give me the last git log…"` |
| 4 | `execution.task` · cli:87 | `string` | same |
| 5 | `messages[0]` · loop:217 | `IModelMessage` | `{ role:"user", content:"give me…" }` |
| 6 | `request` · loop:97 | `ICompleteRequest` | `{ model, system, messages, tools, signal }` |
| 7 | `mapMessages()` · openrouter:89 | `TChatMessages[]` | `[{role:"system",…}, {role:"user", content:"give me…"}]` |
| 8 | HTTP body (by the SDK) | JSON | `{"model":…,"messages":[…],"tools":[…],"max_tokens":4096,"stream":true}` |
| 9 | SSE chunks | JSON per event | `{choices:[{delta:{content:"I'll"}}]}`, `{choices:[{delta:{tool_calls:[{index:0,…,arguments:"{\"com"}]}}]}` |
| 10 | Accumulator · openrouter:168 | `Map<number, TToolCallAccumulator>` | `0 → {id:"call_0a01…", name:"shell_exec", arguments:'{"command":"git",…}'}` |
| 11 | `IProviderEvent` · openrouter:50, :73 | union | `{type:"text", delta:"I'll"}`, `{type:"tool_use", id, name, input:{command:"git", args:[…]}}` |
| 12 | `TAgentEvent` · loop:107, :119 | union | `{type:"text", …}` → **terminal**: `I'll get…`; `{type:"tool_start"}` → **terminal**: `[tool] shell_exec` |
| 13 | `agentContent` → `messages[1]` · loop:132 | `IModelMessage` | assistant: text + 2 × tool_use |
| 14 | `toolCalls[i]` · loop:117 | `IToolCall` | `{ id:"call_3728…", name:"shell_exec", input:{…} }` |
| 15 | `parsedInput.data` · loop:57 | `TShellExecInput` | `{ command:"git", args:["status"] }` |
| 16 | Permission prompt · cliPrompter:15 | terminal text | `Permission required for 'shell_exec' with: {…} Allow? [y/N]` → you type `y` |
| 17 | `spawn()` · shell:36 | child process | `git status`, stdout bytes → `OutputCollector` |
| 18 | `IToolResult` · shell:81 | object | `{ ok:true, content:"$ git status\n\n(exit code 0)\n\nSTDOUT:\nOn branch main…" }` |
| 19 | `TAgentEvent` · loop:169 | union | `{type:"tool_result", …}` → **terminal**: `[tool result] success` |
| 20 | `toToolResultBlock()` · loop:221 | `IContentBlock` | `{ type:"tool_result", toolUseId:"call_3728…", content, isError:false }` |
| 21 | `messages[2]` · loop:172 | `IModelMessage` | user: 2 × tool_result |
| 22 | Checkpoint · executionMemory:15 | JSON file | `memory/<id>.json` |
| 23 | Iteration 2 `mapMessage()` · openrouter:98 | `TChatMessages[]` | assistant with `toolCalls`, then 2 × `{ role:"tool", toolCallId, content }` |
| 24 | Iteration 2 text events · loop:107 | `TAgentEvent` | **terminal**: `Here's the latest git log and repository status: …` |
| 25 | `done` event · loop:151 | `TAgentEvent` | **terminal**: `[completed] 2 iterations · 4054 tokens · $0.0000 · execution …` |
| 26 | `process.exitCode` · cli:118 | number | `0` |

---

## 5.10 Execution status lifecycle

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

| Kind                                   | Examples                                                                 | Handling                                                                                          | Why                                                            |
| -------------------------------------- | ------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------- | -------------------------------------------------------------- |
| **Expected, recoverable by the model** | file not found, bad args, unknown tool, permission denied, non-zero exit | Returned as `IToolResult { ok: false }` → sent to the model as `tool_result` with `isError: true` | The model can read it and adapt. Like a 4xx the client handles |
| **Cancellation**                       | Ctrl-C                                                                   | Converted to outcome `cancelled`, clean checkpoint                                                | Not an error; the user asked for it                            |
| **Unexpected / infrastructure**        | API down, bad API key, corrupt checkpoint, missing config                | Thrown → checkpoint `failed` → CLI `.catch` → exit 1                                              | Nothing the model can do. Like a 5xx                           |

The key line that enforces the boundary is the `try/catch` in [executeTool](src/runtime/loop.ts#L69-L75): even a buggy tool that throws becomes a type-1 failure, so one tool can't kill the run.

## 6.3 Limits and budgets

| Limit                            | Where                            | Default      |
| -------------------------------- | -------------------------------- | ------------ |
| Iterations (model calls) per run | `maxIterations`, checked in loop | 10           |
| Cost per run (USD)               | `maxCostUsd`, checked in loop    | 1            |
| Output tokens per model call     | hardcoded in providers           | 4096         |
| Tool output size                 | `MAX_OUTPUT_BYTES`               | 30,000 bytes |
| Glob matches                     | `MAX_GLOB_MATCHES`               | 200          |
| Shell runtime                    | `TIMEOUT_MS`                     | 60 s         |
| Shell output held in memory      | `MAX_COLLECTED_BYTES`            | 10 MB        |
| Permission prompt preview        | `MAX_PREVIEW_CHARS`              | 2,000 chars  |

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

| Failure                                              | Protection                                                                      |
| ---------------------------------------------------- | ------------------------------------------------------------------------------- |
| Crash while **writing** a checkpoint                 | temp file + atomic `rename`                                                     |
| **Reading** a broken checkpoint                      | `ENOENT` → new; corrupt JSON → loud `CHECKPOINT_CORRUPT` error                  |
| Process dies **between** a `tool_use` and its result | `repairHistory` adds "Interrupted" results so the resumed conversation is valid |

Checkpoints are also valid at every intermediate point because tool results are added to one user message that grows in place.

---

# Part 7: TypeScript features this code relies on

## Async generators (`async function*`, `yield`, `for await`, `yield*`)

The backbone of the streaming design.

```ts
async function* numbers() {
  yield 1; // hand a value to the consumer, pause here
  await sleep(100); // can await in between
  yield 2;
}
for await (const n of numbers()) console.log(n); // pulls values one at a time
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

| Key                                    | Used by              | Default              | Meaning                                                                                     |
| -------------------------------------- | -------------------- | -------------------- | ------------------------------------------------------------------------------------------- |
| `OPENROUTER_API_KEY`                   | `OpenRouterProvider` | **required**         | API key                                                                                     |
| `MODEL`                                | `Loader`             | agent file's `model` | Model id, for example an OpenRouter model slug                                              |
| `permissionMode`                       | `Loader`             | `standard`           | `strict`, `standard` or `yolo`                                                              |
| `maxIterations`                        | `Loader`             | 10                   | Model calls per run                                                                         |
| `maxCostUsd`                           | `Loader`             | 1                    | Budget per run in USD                                                                       |
| `inputUsdPerMTok` / `outputUsdPerMTok` | `Loader`             | 0                    | Prices when the provider doesn't report cost                                                |
| `MAX_OUTPUT_BYTES`                     | `fs.ts`, `shell.ts`  | 30000                | Tool output cap (see bug 1 below: currently ignored from `.env` when run via `bun run dev`) |
| `ANTHROPIC_API_KEY`                    | `AnthropicProvider`  | —                    | Only if you wire in the Anthropic adapter                                                   |

## Exit codes

| Code | Meaning                                  |
| ---- | ---------------------------------------- |
| 0    | Completed                                |
| 1    | Hit the iteration limit, or crashed      |
| 2    | Bad usage (missing task or execution id) |
| 4    | Over budget                              |
| 130  | Cancelled with Ctrl-C                    |

---

# Part 9: Known gaps and bugs

Found while writing this guide (beyond what [FIXES.md](FIXES.md) already covers). Each one is also a good learning exercise.

### Bugs

1. **`MAX_OUTPUT_BYTES` in `.env` is ignored under `bun run dev`.** ES modules evaluate all imports before the importing file's body. `fs.ts` and `shell.ts` read `process.env.MAX_OUTPUT_BYTES` at module load, which happens _before_ `config({ path: ".env" })` runs in `cli/index.ts`. I verified this: under `tsx` (what `bun run dev` runs) the imported module sees the variable as unset. (Running the file directly with `bun src/cli/index.ts` hides the bug, because Bun loads `.env` itself.) Fix: `import "dotenv/config"` as the **first** import in `cli/index.ts`, or read the env var inside the function instead of at module level. `MODEL` and the API key aren't affected, because they're read later.
2. **`fs_write`/`fs_mkdir` glob check only rejects a _leading_ `*`.** The regex `/^(?!\*)/` means "doesn't start with `*`", so `src/*.ts` passes (verified). The error message says "cannot contain glob wildcards". Fix: `/^[^*?[\]{}]*$/`.
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

| Term                       | Meaning                                                                        |
| -------------------------- | ------------------------------------------------------------------------------ |
| **Agent**                  | An LLM in a loop that can call tools until a task is done                      |
| **Agent loop**             | model call → run requested tools → append results → repeat                     |
| **Checkpoint**             | Saved snapshot of an execution's conversation and status                       |
| **Content block**          | One typed piece of a message: `text`, `tool_use` or `tool_result`              |
| **Context window**         | Max tokens the model can handle per call (input + output)                      |
| **Effect**                 | A tool's side-effect class (`read`/`write`/`exec`/`meta`), used by permissions |
| **Execution**              | One task being worked on; can span several runs via resume                     |
| **JSON Schema**            | A JSON description of valid JSON; how tools advertise their arguments          |
| **JSONL**                  | One JSON object per line; append-friendly log format                           |
| **LLM**                    | Large language model; here, a stateless text-in/text-out API                   |
| **OpenRouter**             | A gateway exposing many vendors' models through one OpenAI-style API           |
| **Path jail**              | Check that a resolved path stays inside the workspace root                     |
| **Progressive disclosure** | Advertise skills cheaply by name; load full text on demand                     |
| **Prompt injection**       | Untrusted text (file contents, web pages) that tries to steer the model        |
| **Provider / adapter**     | Code that translates between the internal model API and a vendor's API         |
| **Run**                    | One process invocation; has its own log file                                   |
| **Skill**                  | A named set of instructions loaded on demand via `open_skill`                  |
| **SSE**                    | Server-Sent Events; the streaming HTTP format model APIs use                   |
| **Stop reason**            | Why the model stopped writing (`end_turn`, `tool_use`, `max_tokens`)           |
| **System prompt**          | Standing instructions sent with every call                                     |
| **Token**                  | The unit models read and bill by (~¾ of a word)                                |
| **Tool**                   | A function the model can ask you to run: name + description + schema + handler |
| **Tool call / `tool_use`** | The model's structured request to run a tool, with an id                       |
| **Tool result**            | Your reply to a tool call, matched by id                                       |
| **Zod**                    | A TypeScript validation library; schemas double as types and JSON Schema       |
