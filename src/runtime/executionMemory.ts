import { mkdir, readFile, writeFile } from "node:fs/promises";
import type { IExecutionCheckpoint, IExecutionMemory } from ".";
import { join } from "node:path";

export class ExecutionMemory implements IExecutionMemory {
    constructor(private readonly root: string) { }

    async save(checkpoint: IExecutionCheckpoint): Promise<void> {
        await mkdir(this.root, { recursive: true });
        const filePath = join(this.root, `${checkpoint.executionId}.json`);
        await writeFile(filePath, JSON.stringify(checkpoint), "utf-8");
        return;
    }

    async load(executionId: string): Promise<IExecutionCheckpoint | null> {
        try {
            const content = await readFile(join(this.root, `${executionId}.json`), "utf-8");
            return JSON.parse(content);
        } catch (error) {
            return null;
        }
    }
}