import { appendFile, mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { IRunLogger } from ".";

export class Logger implements IRunLogger {
    private readonly filePath: string;
    constructor(private readonly rootPath: string, private readonly runId: string) {
        this.filePath = join(rootPath, `${runId}.jsonl`);
        console.log(this.filePath);
    }

    async start(task: unknown) {
        return this.write({
            type: "run_started",
            runId: this.runId,
            task,
            timestamp: new Date().toISOString()
        });
    }
    async event(event: unknown) {
        return this.write({
            type: "event",
            event,
            timestamp: new Date().toISOString()
        });
    }
    async done() {
        return this.write({
            type: "run_finished",
            runId: this.runId,
            timestamp: new Date().toISOString()
        });
    }

    async write(data: unknown) {
        await mkdir(dirname(this.filePath), { recursive: true });
        return await appendFile(this.filePath, JSON.stringify(data) + "\n", "utf-8");
    }
}