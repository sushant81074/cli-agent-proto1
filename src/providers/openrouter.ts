import { OpenRouter } from "@openrouter/sdk";
import type { ICompleteRequest, IContentBlock, IModelMessage, IModelTool, IProviderEvent, Provider, TChatMessages, TChatRequest, TChunk, TStopReason, TToolCallAccumulator } from ".";
import { z } from "zod";

export class OpenRouterProvider implements Provider {
    private readonly client: OpenRouter;
    constructor() {
        const apiKey = process.env.OPENROUTER_API_KEY;
        if (!apiKey) throw new Error("OPENROUTER_API_KEY environment variable is required");

        this.client = new OpenRouter({ apiKey: process.env.OPENROUTER_API_KEY });
    }

    async *complete(request: ICompleteRequest): AsyncGenerator<IProviderEvent> {
        // console.log("[request]", { msg: request.messages.map(e => e.role).join(", "), model: request.model });
        const tools = this.mapTools(request.tools);
        const messages = this.mapMessages(request);

        const stream = await this.client.chat.send({
            chatRequest: {
                model: request.model,
                messages,
                tools,
                maxTokens: 4096,
                stream: true,
            },
        }) as unknown as AsyncIterable<unknown>;

        const toolCalls = new Map<number, TToolCallAccumulator>();

        let stopReason: TStopReason | null = null;
        let usageEmitted = false;

        for await (const chunk of stream) {
            const typedChunk = chunk as TChunk;

            const choice = typedChunk.choices?.[0];

            if (!choice) {
                if (typedChunk.usage && !usageEmitted) {
                    usageEmitted = true;

                    yield {
                        type: "usage",
                        inputTokens: typedChunk.usage.promptTokens ?? 0,
                        outputTokens: typedChunk.usage.completionTokens ?? 0,
                    };
                }
                continue;
            }

            const delta = choice.delta;

            if (delta?.content) {
                yield {
                    type: "text",
                    delta: delta.content,
                };
            }

            for (const toolCall of delta?.toolCalls ?? []) {
                this.accumulateToolCall(toolCalls, toolCall);
            }

            if (typedChunk.usage && !usageEmitted) {
                usageEmitted = true;

                yield {
                    type: "usage",
                    inputTokens: typedChunk.usage.promptTokens ?? 0,
                    outputTokens: typedChunk.usage.completionTokens ?? 0,
                };
            }

            if (choice.finishReason && !stopReason) {
                stopReason = this.mapStopReason(choice.finishReason);
            }
        }

        if (toolCalls.size > 0) {
            for (const tool of toolCalls.values()) {
                yield {
                    type: "tool_use",
                    id: tool.id,
                    name: tool.name,
                    input: this.parseToolArguments(tool.arguments),
                };
            }
        }

        yield {
            type: "stop",
            reason: stopReason ?? (toolCalls.size > 0 ? "tool_use" : "end_turn"),
        };
    }


    private mapMessages(request: ICompleteRequest): TChatRequest["messages"] {
        const messages: TChatMessages[] = [];
        if (request.system) messages.push({ role: "system", content: request.system, });
        for (const message of request.messages) {
            messages.push(...this.mapMessage(message));
        }
        return messages as TChatRequest["messages"];
    }

    private mapMessage(message: IModelMessage): TChatMessages[] {
        if (typeof message.content === "string") {
            return [
                {
                    role: message.role,
                    content: message.content,
                },
            ];
        }

        const textBlocks = message.content.filter((block): block is Extract<IContentBlock, { type: "text"; }> => block.type === "text");
        const toolUseBlocks = message.content.filter((block): block is Extract<IContentBlock, { type: "tool_use"; }> => block.type === "tool_use");
        const toolResultBlocks = message.content.filter((block): block is Extract<IContentBlock, { type: "tool_result"; }> => block.type === "tool_result");
        const messages: TChatMessages[] = [];

        if (toolUseBlocks.length > 0) {
            messages.push({
                role: "assistant",
                content:
                    textBlocks.length > 0
                        ? textBlocks.map((block) => block.text).join("")
                        : null,
                toolCalls: toolUseBlocks.map((block) => ({
                    id: block.id,
                    type: "function",
                    function: {
                        name: block.name,
                        arguments: JSON.stringify(block.input),
                    },
                })),
            });
        } else if (textBlocks.length > 0) {
            messages.push({
                role: message.role,
                content: textBlocks.map((block) => block.text).join(""),
            });
        }

        for (const block of toolResultBlocks) {
            messages.push({
                role: "tool",
                toolCallId: block.toolUseId,
                content: block.content,
            });
        }

        return messages;
    }

    private mapTools(tools: IModelTool[]): TChatRequest["tools"] {
        return tools.map((tool) => ({
            type: "function",
            function: {
                name: tool.name,
                description: tool.description,
                parameters: z.toJSONSchema(tool.inputSchema as z.ZodType),
            },
        })) as TChatRequest["tools"];
    }


    private accumulateToolCall(
        toolCalls: Map<number, TToolCallAccumulator>,
        chunk: {
            index: number; id?: string;
            function?: {
                name?: string;
                arguments?: string;
            };
        }): void {

        let toolCall = toolCalls.get(chunk.index);

        if (!toolCall) {
            toolCall = { id: chunk.id ?? "", name: chunk.function?.name ?? "", arguments: chunk.function?.arguments ?? "", };
            toolCalls.set(chunk.index, toolCall);
            return;
        }

        if (chunk.id) toolCall.id = chunk.id;
        if (chunk.function?.name) toolCall.name = chunk.function.name;
        if (chunk.function?.arguments) toolCall.arguments += chunk.function.arguments;
    }

    private parseToolArguments(argumentsJson: string): unknown {
        try {
            return JSON.parse(argumentsJson);
        } catch {
            return {};
        }
    }

    private mapStopReason(reason: string): TStopReason {
        switch (reason) {
            case "tool_calls": return "tool_use";
            case "length": return "max_tokens";
            case "stop":
            default:
                return "end_turn";
        }
    }

}
