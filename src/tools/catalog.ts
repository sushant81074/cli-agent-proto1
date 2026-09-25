import type { IToolDefinition } from "../domains/tool";
import { ToolSet } from "./toolSet";

export class ToolCatalog {
    private readonly tools: Map<string, IToolDefinition>;
    constructor() {
        this.tools = new Map();
    }

    set(t: IToolDefinition): void { this.tools.set(t.name, t); }
    get(k: string): IToolDefinition | undefined { return this.tools.get(k); }
    list(): IToolDefinition[] { return [...this.tools.values()]; }
    createToolSet(tools: string[]): ToolSet {
        return new ToolSet(
            tools.map(t => {
                const tool = this.tools.get(t);
                if (!tool) throw new Error(`Tool not found: ${t}`);
                return tool;
            })
        );
    }
}