import Anthropic from "@anthropic-ai/sdk";
import type { ICompleteRequest, IContentBlock, IModelMessage, IModelTool, IProviderEvent, Provider, TStopReason } from ".";

export class AnthropicProvider implements Provider {
    private readonly client: Anthropic;
    constructor() {
        this.client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
    }

    public async *complete(
        request: ICompleteRequest
    ): AsyncGenerator<IProviderEvent> {
        const stream = this.client.messages.stream({
            model: request.model,
            max_tokens: 4096,
            system: request.system,
            messages: request.messages.map(m => this.mapMessage(m)),
            tools: request.tools.map(t => this.mapTool(t))
        });

        let toolId: string | undefined;
        let toolName: string | undefined;
        let toolInput = "";

        for await (const event of stream) {
            switch (event.type) {
                case "content_block_start": {
                    if (event.content_block.type == "tool_use") { toolId = event.content_block.id; toolName = event.content_block.name; }
                } break;
                case "content_block_delta": {
                    if (event.delta.type === "text_delta") {
                        yield {
                            type: "text",
                            delta: event.delta.text
                        };
                    }

                    if (event.delta.type === "input_json_delta") {
                        toolInput += event.delta.partial_json;
                    }
                } break;
                case "content_block_stop": {
                    if (toolId && toolName) {
                        let input: unknown = {};

                        try {
                            input = JSON.parse(toolInput || "{}");
                        } catch {
                            input = {};
                        }

                        yield {
                            type: "tool_use",
                            id: toolId,
                            name: toolName,
                            input
                        };

                        toolId = undefined;
                        toolName = undefined;
                        toolInput = "";
                    }

                } break;
                case "message_start": {
                    yield {
                        type: "usage",
                        inputTokens: event.message.usage.input_tokens,
                        outputTokens: event.message.usage.output_tokens
                    };
                } break;
                case "message_delta": {
                    if (event.usage) {
                        yield {
                            type: "usage",
                            inputTokens: 0,
                            outputTokens: event.usage.output_tokens
                        };
                    }
                    if (event.delta.stop_reason) {
                        yield {
                            type: "stop",
                            reason: this.mapStopReason(event.delta.stop_reason)
                        };
                    }
                } break;
                case "message_stop": break;
                default:
                    break;
            }
        }
    }

    private mapStopReason(reason: string | null): TStopReason {
        switch (reason) {
            case "end_turn": return "end_turn";
            case "tool_use": return "tool_use";
            case "max_tokens": return "max_tokens";
            default: return "end_turn";

        }
    }

    private mapMessage(message: IModelMessage): Anthropic.MessageParam {
        return {
            role: message.role,
            content: typeof message.content === "string" ? message.content : message.content.map((block) => this.mapContentBlock(block))
        };
    }

    private mapContentBlock(block: IContentBlock): Anthropic.ContentBlockParam {
        switch (block.type) {
            case "text":
                return {
                    type: "text",
                    text: block.text
                };

            case "tool_use":
                return {
                    type: "tool_use",
                    id: block.id,
                    name: block.name,
                    input: block.input
                };

            case "tool_result":
                return {
                    type: "tool_result",
                    tool_use_id: block.toolUseId,
                    content: block.content,
                    is_error: block.isError
                };
        }
    }

    private mapTool(tool: IModelTool): Anthropic.Tool {
        return {
            name: tool.name,
            description: tool.description,
            input_schema: tool.inputSchema as Anthropic.Tool.InputSchema
        };
    }

}