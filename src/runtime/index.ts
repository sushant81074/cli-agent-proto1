import type { TAgentConfig } from "../configs/loadConfig";
import type { IToolResult } from "../domains/tool";
import type { IModelMessage } from "../providers";
import type { ToolSet } from "../tools/toolSet";

/** Why a run stopped. "failed" isn't here: a failed run throws instead of finishing. */
export type TRunOutcome =
    | "completed"
    | "max_iterations"
    | "budget_exceeded"
    | "cancelled";

export interface IRunUsage {
    inputTokens: number;
    outputTokens: number;
    costUsd: number;
}

export type TAgentEvent =
    | { type: "text"; delta: string; }
    | { type: "tool_start"; toolName: string; }
    | { type: "tool_result"; toolName: string; result: IToolResult; }
    | { type: "done"; outcome: TRunOutcome; iterations: number; usage: IRunUsage; };


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
