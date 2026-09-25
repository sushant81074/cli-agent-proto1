import type { IToolCall, IToolContext, IToolResult } from "../domains/tool";
import type { IPermissionPolicy, IPermissionPrompter } from "../permissions";
import type { ICompleteRequest, IContentBlock, IModelMessage, Provider, TStopReason } from "../providers";
import type { IRunLogger } from "../utils";
import type { IExecutionMemory, TAgentEvent, TExecutionStatus } from ".";
import type { AgentExecution } from "./execution";

export class AgentLoop {
    private readonly provider: Provider;
    private readonly execution: AgentExecution;
    private readonly toolContext: IToolContext;
    private readonly permissionPolicy: IPermissionPolicy;
    private readonly permissionPrompter: IPermissionPrompter;
    private readonly messages: IModelMessage[];
    private readonly memory: IExecutionMemory;
    private readonly logger: IRunLogger;

    constructor(
        provider: Provider,
        execution: AgentExecution,
        toolContext: IToolContext,
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

    private async executeTool(toolName: string, input: unknown): Promise<IToolResult> {
        const tool = this.execution.tools.get(toolName);
        if (!tool) return { ok: false, error: toolName + "Tool not present", content: "" };

        const decission = this.permissionPolicy.check(tool);
        let move = false;
        switch (decission) {
            case "allow":
                move = true;
                break;
            case "ask":
                move = await this.permissionPrompter.confirm(toolName);
                break;
            case "deny":
            default: break;
        }
        if (!move) return { ok: false, error: toolName + "tool is denied to run", content: "" };

        const parsedInput = tool.schema.safeParse(input);
        if (!parsedInput.success) return { ok: false, error: JSON.stringify(parsedInput.error), content: "" };

        return tool.handler(parsedInput.data, this.toolContext);
    }

    async *run(signal: AbortSignal): AsyncGenerator<TAgentEvent> {
        await this.logger.start(this.execution.task);
        await this.loadMemoryCheckpoint();

        console.log(this.messages, "messages");

        for (let i = 0; i < this.execution.config.maxIterations; i++) {
            const request: ICompleteRequest = {
                model: this.execution.config.model,
                messages: this.messages,
                tools: this.execution.tools.list().map(t => ({ name: t.name, description: t.description, inputSchema: t.schema })),
                system: "",
                signal,
            };

            let stopReason: TStopReason | "" = "";
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
                        stopReason = event.reason;
                        break;
                    case "usage":
                        break;
                }
            }

            if (delta) agentContent.push({ type: "text", text: delta });

            this.messages.push({ role: "assistant", content: agentContent });
            await this.checkpoint(i, "running");

            if (stopReason == "end_turn" || toolCalls.length == 0) {
                await this.logger.event({ type: "done" });
                return yield { type: "done" };
            }

            for await (const tc of toolCalls) {

                const result = await this.executeTool(tc.name, tc.input);
                await this.logger.event({ type: "tool_result", toolName: tc.name, result });
                yield {
                    type: "tool_result",
                    toolName: tc.name,
                    result
                };
                this.messages.push({
                    role: "user",
                    content: [
                        {
                            type: "tool_result",
                            toolUseId: tc.id,
                            content: result.ok ? result.content : `Error occured: ${result.error}`,
                            isError: !result.ok
                        }
                    ]
                });
                await this.checkpoint(i, "running");
            }
        }
    }

    private async checkpoint(iteration: number, status: TExecutionStatus) {
        return await this.memory.save({
            executionId: this.execution.id,
            agent: this.execution.agent,
            task: this.execution.task,
            iteration,
            status,
            messages: this.messages,
            updatedAt: new Date().toISOString()
        });
    }

    private async loadMemoryCheckpoint() {
        const checkpoint = await this.memory.load(this.execution.id);
        if (!checkpoint) return this.messages.push({ role: "user", content: this.execution.task });
        this.messages.push(...(checkpoint?.messages ?? []));
        return this.messages.push({ role: "user", content: this.execution.task });
    }
}
