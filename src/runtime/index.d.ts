import type { IToolResult } from "../domains/tool";

export type TAgentEvent =
    | { type: "text"; delta: string; }
    | { type: "tool_start"; toolName: string; }
    | { type: "tool_result"; toolName: string; result: IToolResult; }
    | { type: "done"; };


export interface IAgentDefinition {
    readonly name: string;
    readonly model: string;
    readonly description: string;
    readonly instructions: string;
}

export interface IAgentExecution {
    readonly id: string;
    readonly task: string;
    readonly config: TAgentConfig;
    readonly tools: ToolSet;
    readonly availableSkills: string;
    readonly agent: IAgentDefinition;
}

export type TExecutionStatus =
    | "running"
    | "paused"
    | "completed"
    | "failed"
    | "cancelled";

export interface IExecutionCheckpoint {
    readonly executionId: string;
    readonly agent: { readonly name: string; readonly version?: string; };
    readonly task: string;
    readonly iteration: number;
    readonly status: TExecutionStatus;
    readonly messages: IModelMessage[];
    readonly updatedAt: string;
}

export interface IExecutionMemory {
    save(checkpoint: IExecutionCheckpoint): Promise<void>;
    load(executionId: string): Promise<IExecutionCheckpoint | null>;
}
