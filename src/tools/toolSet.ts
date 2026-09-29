import { z } from "zod";
import type { IToolDefinition } from "../domains/tool";
import type { IModelTool, TJsonSchema } from "../providers";

export class ToolSet {
    private readonly tools: Map<string, IToolDefinition>;
    constructor(tools: IToolDefinition[]) {
        this.tools = new Map(tools.map(t => [t.name, t]));
    }

    get(k: string): IToolDefinition | undefined { return this.tools.get(k); }
    list(): IToolDefinition[] { return [...this.tools.values()]; }
    has(k: string): boolean { return this.tools.has(k); }

    /**
     * The tool list as the model sees it. Zod is converted to JSON Schema here, once, so every
     * provider receives the same plain JSON and none of them needs to know about Zod.
     */
    modelTools(): IModelTool[] {
        return this.list().map(t => ({
            name: t.name,
            description: t.description,
            inputSchema: toInputJsonSchema(t.schema),
        }));
    }
}

function toInputJsonSchema(schema: z.ZodType): TJsonSchema {
    // io: "input" describes what the model may SEND, so fields with a .default() stay optional.
    // The default (io: "output") marks them required, e.g. fs_write's `overwrite`.
    const { $schema: _dialect, ...jsonSchema } = z.toJSONSchema(schema, { io: "input" });
    return jsonSchema;
}
