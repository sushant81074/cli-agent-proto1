import type { z } from "zod";

export type TToolEffect = "read" | "write" | "exec" | "meta";

export interface IToolContext {
    workspaceRoot: string;
}

export type TResolvedPathResult =
    | { ok: true; path: string; }
    | { ok: false; error: string; };

export interface IToolResult {
    ok: boolean;
    content: string;
    error?: string;
}

export interface IToolCall {
    id: string;
    name: string;
    input: unknown;
}

export interface IToolDefinition<I = unknown> {
    name: string;
    description: string;
    schema: z.ZodType<I>;
    effect: TToolEffect;
    handler(
        input: I,
        context: IToolContext
    ): Promise<IToolResult>;
}