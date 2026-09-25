export type TPermissionMode = "strict" | "standard" | "yolo";

export type TAgentConfig = {
    model: string;
    maxIterations: number;
    maxCostUsd: number;
    permissionMode: TPermissionMode;
};

export class Loader {
    agentConfig(): TAgentConfig {
        return {
            model: process.env.MODEL as string,
            maxIterations: Number(process.env.maxIterations) || 10,
            maxCostUsd: Number(process.env.maxCostUsd) || 1,
            permissionMode: (process.env.permissionMode || "standard") as TPermissionMode,
        };
    }
}