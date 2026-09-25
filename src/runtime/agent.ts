import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { parse } from 'smol-toml';
import type { IAgentDefinition } from ".";

export class AgentDefination implements IAgentDefinition {
    name!: string;
    model!: string;
    description!: string;
    instructions!: string;

    constructor(private readonly root: string) { }

    async load() {
        const data = await readFile(join(this.root, "general.toml"), "utf-8");
        const parsed = parse(data, { maxDepth: 4 }) as unknown as IAgentDefinition;
        this.name = parsed.name;
        this.model = parsed.model;
        this.description = parsed.description;
        this.instructions = parsed.instructions;
    }
}