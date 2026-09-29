import { createInterface } from "node:readline/promises";
import { stdin, stdout } from "node:process";
import type { IPermissionPrompt, IPermissionPrompter } from ".";

const MAX_PREVIEW_CHARS = 2_000;

export class CliPermissionPrompter implements IPermissionPrompter {

    async confirm(prompt: IPermissionPrompt, signal: AbortSignal): Promise<boolean> {
        const readline = createInterface({ input: stdin, output: stdout });
        // While readline owns the terminal it swallows Ctrl-C. Pass it on so the run still gets cancelled.
        readline.on("SIGINT", () => { process.emit("SIGINT", "SIGINT"); });
        try {
            // Before, the prompt only named the tool, so you approved shell_exec without seeing the command.
            const ans = await readline.question(
                `\nPermission required for '${prompt.toolName}' with:\n${this.preview(prompt.input)}\nAllow? [y/N] `,
                { signal }
            );
            return ["y", "yes"].includes(ans.trim().toLowerCase());

        } catch (error) {
            if (signal.aborted) return false;
            console.error(error, "error occured");
            return false;
        } finally {
            readline.close();
        }
    }

    preview(input: unknown): string {
        const text = JSON.stringify(input, null, 2) ?? String(input);
        if (text.length <= MAX_PREVIEW_CHARS) return text;
        return `${text.slice(0, MAX_PREVIEW_CHARS)}\n...[${text.length - MAX_PREVIEW_CHARS} more characters]`;
    }
}