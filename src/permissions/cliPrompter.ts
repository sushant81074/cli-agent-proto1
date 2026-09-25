import { createInterface } from "node:readline/promises";
import { stdin, stdout } from "node:process";
import type { IPermissionPrompter } from ".";

export class CliPermissionPrompter implements IPermissionPrompter {

    async confirm(toolName: string): Promise<boolean> {
        const readline = createInterface({ input: stdin, output: stdout });
        try {

            const ans = await readline.question(`\nPermission required for '${toolName}'. Allow? [y/N] `);
            return ["y", "yes"].includes(ans.trim().toLowerCase());

        } catch (error) {
            console.error(error, "error occured");
            return false;
        } finally {
            readline.close();
        }
    }

}