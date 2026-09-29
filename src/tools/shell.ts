
import { spawn } from "node:child_process";
import { z } from "zod";
import type { IToolContext, IToolDefinition, IToolResult, TToolEffect } from "../domains/tool";

export const shellExecInputSchema = z.object({
    command: z.string().min(1).describe("The program to run, on its own. Example: 'npm', 'git', 'npx'"),
    args: z.array(z.string()).default([]).describe("Arguments for the program, one per item. Example: ['test'] or ['status', '--short']. There is no shell, so pipes, &&, redirects, globs and $VARS don't work.")
});

type TShellExecInput = z.infer<typeof shellExecInputSchema>;

const TIMEOUT_MS = 60_000;
const MAX_OUTPUT_BYTES = Number(process.env.MAX_OUTPUT_BYTES) || 30_000;
// Stop collecting past this even before truncation, so a runaway program can't eat all memory.
const MAX_COLLECTED_BYTES = 10 * 1024 * 1024;

export class ShellExec implements IToolDefinition<TShellExecInput> {
    name: string;
    description: string;
    schema: z.ZodType<TShellExecInput>;
    effect: TToolEffect;

    constructor() {
        this.name = "shell_exec";
        this.description = "Run a program (without a shell) from the workspace root, for example tests, type checks or git status. Returns the exit code, stdout and stderr, including when the program fails. Stops after 60 seconds.";
        this.schema = shellExecInputSchema;
        this.effect = "exec";
    }

    handler(input: TShellExecInput, context: IToolContext): Promise<IToolResult> {
        return new Promise(resolve => {
            // No shell: the command can't chain other commands, expand globs or `cd` elsewhere.
            // This is NOT a sandbox: `cat /etc/hosts` still works. The permission prompt, which now
            // shows the full command, is what actually protects you.
            const child = spawn(input.command, input.args, {
                cwd: context.workspaceRoot,
                shell: false,
                stdio: ["ignore", "pipe", "pipe"],
                // Own process group, so we can kill the program AND whatever it started (npm → node → ...).
                detached: true,
            });

            const stdout = new OutputCollector();
            const stderr = new OutputCollector();
            child.stdout.on("data", (chunk: Buffer) => stdout.push(chunk));
            child.stderr.on("data", (chunk: Buffer) => stderr.push(chunk));

            let timedOut = false;
            const killGroup = () => {
                if (child.pid === undefined) return;
                try { process.kill(-child.pid, "SIGKILL"); } catch { /* already exited */ }
            };
            const timer = setTimeout(() => { timedOut = true; killGroup(); }, TIMEOUT_MS);
            context.signal.addEventListener("abort", killGroup, { once: true });
            const cleanup = () => {
                clearTimeout(timer);
                context.signal.removeEventListener("abort", killGroup);
            };

            child.on("error", error => {
                cleanup();
                resolve({ ok: false, error: `Could not start "${input.command}": ${error.message}`, content: "" });
            });

            child.on("close", (code, signal) => {
                cleanup();
                const status = timedOut ? `timed out after ${TIMEOUT_MS / 1000}s and was killed`
                    : context.signal.aborted ? "cancelled by the user"
                        : signal ? `killed by ${signal}`
                            : `exit code ${code}`;

                // Always return the output. A failing test run is exactly when the model needs stdout.
                const content = [
                    `$ ${[input.command, ...input.args].join(" ")}`,
                    `(${status})`,
                    stdout.text() && `STDOUT:\n${stdout.text()}`,
                    stderr.text() && `STDERR:\n${stderr.text()}`,
                ].filter(Boolean).join("\n\n");

                if (code === 0) resolve({ ok: true, content });
                else resolve({ ok: false, error: status, content });
            });
        });
    }
}

class OutputCollector {
    private readonly chunks: Buffer[] = [];
    private collected = 0;
    private dropped = 0;

    push(chunk: Buffer) {
        if (this.collected >= MAX_COLLECTED_BYTES) { this.dropped += chunk.length; return; }
        this.chunks.push(chunk);
        this.collected += chunk.length;
    }

    /** Cut from the middle: the start shows what ran, the end usually holds the error or test summary. */
    text(): string {
        const all = Buffer.concat(this.chunks);
        const total = all.length + this.dropped;
        if (total <= MAX_OUTPUT_BYTES) return all.toString("utf8").trim();

        const half = Math.floor(MAX_OUTPUT_BYTES / 2);
        const head = all.subarray(0, half).toString("utf8");
        const tail = all.subarray(all.length - half).toString("utf8");
        return `${head}\n\n...[truncated ${total - 2 * half} bytes]...\n\n${tail}`.trim();
    }
}