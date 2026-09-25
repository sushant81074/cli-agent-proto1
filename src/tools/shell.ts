
import { exec } from "node:child_process";
import { promisify } from "node:util";
import { z } from "zod";
import type { IToolContext, IToolDefinition, IToolResult, TToolEffect } from "../domains/tool";

export const shellExecInputSchema = z.object({
    command: z.string().min(1).describe("The literal shell command to execute within the workspace root. Example: 'npm test', 'git status'")
});

type TShellExecInput = z.infer<typeof shellExecInputSchema>;

export class ShellExec implements IToolDefinition<TShellExecInput> {
    name: string;
    description: string;
    schema: z.ZodType<TShellExecInput>;
    effect: TToolEffect;
    private exec;

    constructor() {
        this.name = "shell_exec";
        this.description = "Execute a non-interactive shell command inside the workspace root. Commands must exit completely within 15 seconds.";
        this.schema = shellExecInputSchema;
        this.effect = "exec";
        this.exec = promisify(exec);
    }

    async handler(input: TShellExecInput, context: IToolContext): Promise<IToolResult> {
        try {
            const cmd = input.command.trim();
            const { stdout, stderr } = await this.exec(cmd,
                {
                    maxBuffer: Number(process.env.MAX_OUTPUT_BYTES) || 30_000,
                    cwd: context.workspaceRoot,
                    timeout: 15_000
                });
            const output = [
                stdout.trim(),
                stderr.trim()
                    ? `STDERR:\n${stderr.trim()}`
                    : ""
            ]
                .filter(Boolean)
                .join("\n\n");
            return {
                ok: true,
                content: `Successfully ran cmd: ${input.command}, output:${output}`
            };
        } catch (error) {
            return { ok: false, error: error instanceof Error ? error?.message : "", content: "" };
        }
    }
}