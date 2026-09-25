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

export interface IPermissionPrompter {
    confirm(toolName: string): Promise<boolean>;
}