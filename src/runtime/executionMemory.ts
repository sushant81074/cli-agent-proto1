import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import type { IExecutionCheckpoint, IExecutionMemory } from ".";
import { join } from "node:path";
import { EcoError } from "../domains/error";

export class ExecutionMemory implements IExecutionMemory {
    constructor(private readonly root: string) { }

    async save(checkpoint: IExecutionCheckpoint): Promise<void> {
        await mkdir(this.root, { recursive: true });
        const filePath = this.pathFor(checkpoint.executionId);
        // Write a temp file, then rename it over the real one. rename() is atomic on the same disk,
        // so a crash mid-save leaves the old checkpoint or the new one, never a half-written file.
        const tempPath = `${filePath}.${process.pid}.tmp`;
        await writeFile(tempPath, JSON.stringify(checkpoint), "utf-8");
        await rename(tempPath, filePath);
    }

    async load(executionId: string): Promise<IExecutionCheckpoint | null> {
        const filePath = this.pathFor(executionId);

        let content: string;
        try {
            content = await readFile(filePath, "utf-8");
        } catch (error) {
            // Only "file doesn't exist" means "no checkpoint". Any other read error is a real problem.
            if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
            throw error;
        }

        try {
            return JSON.parse(content) as IExecutionCheckpoint;
        } catch (error) {
            // Before, this returned null too, so --resume quietly started over and the history was lost.
            const reason = error instanceof Error ? error.message : String(error);
            throw new EcoError("CHECKPOINT_CORRUPT", `Checkpoint ${filePath} is corrupt (${reason}). Fix or delete it, or start a new run without --resume.`);
        }
    }

    private pathFor(executionId: string): string {
        return join(this.root, `${executionId}.json`);
    }
}