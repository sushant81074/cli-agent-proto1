import type { IToolDefinition } from "../domains/tool";

export class ToolSet {
    private readonly tools: Map<string, IToolDefinition>;
    constructor(tools: IToolDefinition[]) {
        this.tools = new Map(tools.map(t => [t.name, t]));
    }

    get(k: string): IToolDefinition | undefined { return this.tools.get(k); }
    list(): IToolDefinition[] { return [...this.tools.values()]; }
    has(k: string): boolean { return this.tools.has(k); }
}