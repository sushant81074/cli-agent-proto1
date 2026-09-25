import type { TAgentEvent } from "../runtime";

export interface IRunLogger {
    start(task: string): Promise<void>;
    event(event: TAgentEvent): Promise<void>;
    done(): Promise<void>;
}