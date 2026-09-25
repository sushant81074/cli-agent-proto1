
export type IContentBlock =
    | { type: "text"; text: string; }
    | { type: "tool_use"; id: string; name: string; input: unknown; }
    | { type: "tool_result"; toolUseId: string; content: string; isError?: boolean; };

export type TStopReason =
    | "end_turn"
    | "tool_use"
    | "max_tokens";

export type IProviderEvent =
    | { type: 'text'; delta: string; }
    | { type: 'tool_use'; id: string; name: string; input: unknown; }
    | { type: 'usage'; inputTokens: number; outputTokens: number; }
    | { type: 'stop'; reason: TStopReason; };

export interface IModelMessage {
    role: "user" | "assistant";
    content: string | IContentBlock[];
}

export interface IModelTool {
    name: string;
    description: string;
    inputSchema: unknown;
}

export interface ICompleteRequest {
    model: string;
    system: string;
    messages: IModelMessage[];
    signal: AbortSignal;
    tools: IModelTool[];
}

export interface Provider {
    complete(
        request: ICompleteRequest
    ): AsyncGenerator<IProviderEvent>;
}

export type TChatMessages = {
    role: "system" | "user" | "assistant" | "tool";
    content: string | null;
    toolCalls?: Array<{
        id: string;
        type: "function";
        function: {
            name: string;
            arguments: string;
        };
    }>;
    toolCallId?: string;
};

export type TChatRequest = NonNullable<Parameters<OpenRouter["chat"]["send"]>[0]["chatRequest"]>;

export type TToolCallAccumulator = {
    id: string;
    name: string;
    arguments: string;
};

export type TChunk = {
    choices?: Array<{
        delta?: {
            content?: string | null;
            toolCalls?: Array<{
                index: number;
                id?: string;
                function?: {
                    name?: string;
                    arguments?: string;
                };
            }>;
        }; finishReason?: string | null;
    }>;
    usage?: {
        promptTokens?: number;
        completionTokens?: number;
    };
};