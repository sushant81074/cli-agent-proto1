import { ConfigError } from "../domains/error";
import type { TPermissionMode } from "../permissions";
import type { IAgentDefinition } from "../runtime";

export type TAgentConfig = {
    model: string;
    /** Where `model` came from, printed at startup so the choice is never a surprise. */
    modelSource: "MODEL in .env" | "agent file";
    maxIterations: number;
    maxCostUsd: number;
    permissionMode: TPermissionMode;
    /** Prices for providers that don't report cost themselves (Anthropic). OpenRouter reports it. */
    inputUsdPerMTok: number;
    outputUsdPerMTok: number;
};

const PERMISSION_MODES: readonly string[] = ["strict", "standard", "yolo"] satisfies TPermissionMode[];

export class Loader {
    agentConfig(agent: IAgentDefinition): TAgentConfig {
        // MODEL in .env overrides the agent file; otherwise the agent file's model is used.
        // Before, only MODEL was read and the agent file's model was silently ignored.
        const envModel = process.env.MODEL?.trim();
        const model = envModel || agent.model;
        if (!model) throw new ConfigError('No model configured: set `model` in the agent file or MODEL in .env.');

        // Before, any string was cast to the type without a check (and the CLI ignored it anyway).
        const permissionMode = process.env.permissionMode || "standard";
        if (!this.isPermissionMode(permissionMode))
            throw new ConfigError(`Invalid permissionMode "${permissionMode}". Use one of: ${PERMISSION_MODES.join(", ")}.`);

        return {
            model,
            modelSource: envModel ? "MODEL in .env" : "agent file",
            maxIterations: Number(process.env.maxIterations) || 10,
            maxCostUsd: Number(process.env.maxCostUsd) || 1,
            permissionMode,
            inputUsdPerMTok: Number(process.env.inputUsdPerMTok) || 0,
            outputUsdPerMTok: Number(process.env.outputUsdPerMTok) || 0,
        };
    }

    isPermissionMode(value: string): value is TPermissionMode {
        return PERMISSION_MODES.includes(value);
    }
}