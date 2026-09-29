import type { TToolEffect } from "../domains/tool";

export type TPermissionMode =
    | "strict"
    | "standard"
    | "yolo";

export type TPermissionDecision =
    | "allow"
    | "ask"
    | "deny";

export interface IPermissionRequest {
    readonly name: string;
    readonly effect: TToolEffect;
}

export interface IDecisionResult {
    ok: boolean;
    error?: string;
}

export interface IPermissionPolicy {
    check(request: IPermissionRequest): TPermissionDecision;
}

/** What the user sees before approving: the tool AND the exact arguments it will run with. */
export interface IPermissionPrompt {
    readonly toolName: string;
    readonly input: unknown;
}

export interface IPermissionPrompter {
    confirm(prompt: IPermissionPrompt, signal: AbortSignal): Promise<boolean>;
}
