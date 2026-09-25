import type { IPermissionPolicy, IPermissionRequest, TPermissionDecision, TPermissionMode } from ".";
import type { TToolEffect } from "../domains/tool";

export class PermissionPolicy implements IPermissionPolicy {
    readonly mode: TPermissionMode;
    constructor(mode: TPermissionMode) {
        this.mode = mode;
    }

    check(request: IPermissionRequest): TPermissionDecision {
        switch (this.mode) {
            case "standard": return this.checkStandard(request.effect);
            case "strict": return this.checkStrict(request.effect);
            case "yolo": return "allow";
            default: return this.checkStrict(request.effect);
        }
    }

    checkStrict(effect: TToolEffect): TPermissionDecision {
        switch (effect) {
            case "read": return "allow";
            case "meta":
            case "exec":
            case "write": return "deny";
            default: return "deny";
        }
    }
    checkStandard(effect: TToolEffect): TPermissionDecision {
        switch (effect) {
            case "meta":
            case "read": return "allow";
            case "write":
            case "exec": return "ask";
            default: return "ask";
        }
    }
}