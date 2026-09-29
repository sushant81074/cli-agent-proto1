import { z } from "zod";
import type { IToolCall, IToolContext, IToolResult } from "../domains/tool";
import type { IPermissionPolicy, IPermissionPrompter } from "../permissions";
import type { ICompleteRequest, IContentBlock, IModelMessage, IModelTool, Provider } from "../providers";
import type { IRunLogger } from "../utils";
import type { IExecutionMemory, IRunUsage, TAgentEvent, TExecutionStatus, TRunOutcome } from ".";
import type { AgentExecution } from "./execution";
import { repairHistory } from "./history";

const STATUS_FOR_OUTCOME: Record<TRunOutcome, TExecutionStatus> = {
    completed: "completed",
    cancelled: "cancelled",
    // Stopped by a limit, not finished: the conversation can be picked up again with --resume.
    max_iterations: "paused",
    budget_exceeded: "paused",
};

export class AgentLoop {
    private readonly provider: Provider;
    private readonly execution: AgentExecution;
    private readonly toolContext: Omit<IToolContext, "signal">;
    private readonly permissionPolicy: IPermissionPolicy;
    private readonly permissionPrompter: IPermissionPrompter;
    private readonly messages: IModelMessage[];
    private readonly memory: IExecutionMemory;
    private readonly logger: IRunLogger;
    private readonly usage: IRunUsage = { inputTokens: 0, outputTokens: 0, costUsd: 0 };
    private iterations = 0;

    constructor(
        provider: Provider,
        execution: AgentExecution,
        toolContext: Omit<IToolContext, "signal">,
        permission: IPermissionPolicy,
        prompter: IPermissionPrompter,
        memory: IExecutionMemory,
        logger: IRunLogger
    ) {
        this.provider = provider;
        this.execution = execution;
        this.toolContext = toolContext;
        this.permissionPolicy = permission;
        this.permissionPrompter = prompter;
        this.messages = [];
        this.memory = memory;
        this.logger = logger;
    }

    private async executeTool(toolName: string, input: unknown, signal: AbortSignal): Promise<IToolResult> {
        const tool = this.execution.tools.get(toolName);
        if (!tool) {
            const available = this.execution.tools.list().map(t => t.name).join(", ");
            return { ok: false, error: `Unknown tool "${toolName}". Available tools: ${available}`, content: "" };
        }

        // Validate before asking, so the prompt shows the exact arguments that will run.
        const parsedInput = tool.schema.safeParse(input);
        if (!parsedInput.success) return { ok: false, error: `Invalid input for ${toolName}:\n${z.prettifyError(parsedInput.error)}`, content: "" };

        const decision = this.permissionPolicy.check(tool);
        if (decision === "deny") return { ok: false, error: `${toolName} is not allowed in the current permission mode.`, content: "" };
        if (decision === "ask") {
            const allowed = await this.permissionPrompter.confirm({ toolName, input: parsedInput.data }, signal);
            if (signal.aborted) return { ok: false, error: "Cancelled by the user.", content: "" };
            // A denial is a normal result, not a failure: the model reads it and tries something else.
            if (!allowed) return { ok: false, error: "The user denied this action.", content: "" };
        }

        try {
            return await tool.handler(parsedInput.data, { ...this.toolContext, signal });
        } catch (error) {
            // Handlers should return errors, not throw them. If one throws anyway, turn it into a
            // result so a single broken tool can't end the whole run.
            return { ok: false, error: error instanceof Error ? error.message : String(error), content: "" };
        }
    }

    async *run(signal: AbortSignal): AsyncGenerator<TAgentEvent> {
        await this.logger.start(this.execution.task);
        await this.loadMemoryCheckpoint();

        const { model, maxIterations, maxCostUsd } = this.execution.config;
        // Built once per run. Before, `system` was always "", so the agent's instructions and the
        // skill list never reached the model.
        const system = this.buildSystemPrompt();
        const tools: IModelTool[] = this.execution.tools.modelTools();

        let outcome: TRunOutcome;
        try {
            while (true) {
                if (signal.aborted) { outcome = "cancelled"; break; }
                if (this.iterations >= maxIterations) { outcome = "max_iterations"; break; }
                // Checked before every model call. Before, usage events were dropped and maxCostUsd did nothing.
                if (this.usage.costUsd >= maxCostUsd) { outcome = "budget_exceeded"; break; }
                this.iterations++;

                const request: ICompleteRequest = { model, system, messages: this.messages, tools, signal };

                const toolCalls: Array<IToolCall> = [];
                const agentContent: IContentBlock[] = [];
                let delta = "";
                for await (const event of this.provider.complete(request)) {
                    switch (event.type) {
                        case "text":

                            delta += event.delta;
                            yield { type: event.type, delta: event.delta };

                            break;
                        case "tool_use":

                            if (delta) {
                                agentContent.push({ type: "text", text: delta });
                                delta = "";
                            }
                            agentContent.push({ type: event.type, id: event.id, input: event.input, name: event.name });
                            toolCalls.push({ id: event.id, input: event.input, name: event.name });
                            await this.logger.event({ type: "tool_start", toolName: event.name });
                            yield { type: "tool_start", toolName: event.name };

                            break;
                        case "stop":
                            break;
                        case "usage":
                            this.addUsage(event);
                            break;
                    }
                }

                if (delta) agentContent.push({ type: "text", text: delta });

                if (agentContent.length > 0) this.messages.push({ role: "assistant", content: agentContent });
                await this.checkpoint("running");

                // Decide on the tool calls, not the stop reason. Some models return "stop" together
                // with tool calls; stopping there left tool_use blocks unanswered in the history.
                if (toolCalls.length === 0) { outcome = "completed"; break; }

                yield* this.runTools(toolCalls, signal);
            }
        } catch (error) {
            // An abort shows up as an error thrown from the provider stream: that's a cancel, not a crash.
            if (!signal.aborted) {
                await this.finish("failed", "failed");
                throw error;
            }
            outcome = "cancelled";
        }

        await this.finish(STATUS_FOR_OUTCOME[outcome], outcome);
        yield { type: "done", outcome, iterations: this.iterations, usage: { ...this.usage } };
    }

    /**
     * Runs one batch of tool calls. All results go into ONE user message, in the same order as the
     * tool_use blocks. Before, each result was a separate user message. The message is added on the
     * first result and filled in as results arrive, so every checkpoint is still a valid conversation.
     */
    private async *runTools(toolCalls: IToolCall[], signal: AbortSignal): AsyncGenerator<TAgentEvent> {
        const results: IContentBlock[] = [];

        for (const tc of toolCalls) {
            // Every tool_use needs a result, even the ones skipped because the user cancelled.
            const result: IToolResult = signal.aborted
                ? { ok: false, error: "Cancelled by the user before this tool ran.", content: "" }
                : await this.executeTool(tc.name, tc.input, signal);

            await this.logger.event({ type: "tool_result", toolName: tc.name, result });
            yield { type: "tool_result", toolName: tc.name, result };

            results.push(toToolResultBlock(tc.id, result));
            if (results.length === 1) this.messages.push({ role: "user", content: results });
            await this.checkpoint("running");
        }
    }

    private buildSystemPrompt(): string {
        const { agent, availableSkills } = this.execution;
        return [
            agent.instructions.trim(),
            "[AVAILABLE SKILLS]",
            "When a task matches one of these skills, call open_skill with its name before starting, to load its full instructions.",
            availableSkills,
        ].join("\n\n");
    }

    private addUsage(event: { inputTokens: number; outputTokens: number; costUsd?: number; }) {
        this.usage.inputTokens += event.inputTokens;
        this.usage.outputTokens += event.outputTokens;
        // Use the provider's own figure when it gives one; otherwise price the tokens from config.
        const { inputUsdPerMTok, outputUsdPerMTok } = this.execution.config;
        this.usage.costUsd += event.costUsd
            ?? (event.inputTokens * inputUsdPerMTok + event.outputTokens * outputUsdPerMTok) / 1_000_000;
    }

    private async finish(status: TExecutionStatus, outcome: TRunOutcome | "failed") {
        await this.checkpoint(status);
        // Before, logger.done() was never called, so no run log had an end.
        await this.logger.done({ outcome, iterations: this.iterations, usage: this.usage });
    }

    private async checkpoint(status: TExecutionStatus) {
        return await this.memory.save({
            executionId: this.execution.id,
            agent: { name: this.execution.agent.name },
            task: this.execution.task,
            iteration: this.iterations,
            status,
            messages: this.messages,
            updatedAt: new Date().toISOString()
        });
    }

    private async loadMemoryCheckpoint() {
        const checkpoint = await this.memory.load(this.execution.id);
        if (checkpoint) this.messages.push(...repairHistory(checkpoint.messages));
        this.messages.push({ role: "user", content: this.execution.task });
    }
}

function toToolResultBlock(toolUseId: string, result: IToolResult): IContentBlock {
    // Keep the output when the tool failed too. Before, a failed result sent only the error and
    // dropped `content`, so a failing test run reached the model without its output.
    const content = result.ok
        ? result.content
        : [`Error: ${result.error ?? "unknown error"}`, result.content].filter(Boolean).join("\n\n");
    return { type: "tool_result", toolUseId, content, isError: !result.ok };
}
