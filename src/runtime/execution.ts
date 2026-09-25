import type { IAgentDefinition, IAgentExecution } from ".";
import type { TAgentConfig } from "../configs/loadConfig";
import type { ToolSet } from "../tools/toolSet";

export class AgentExecution implements IAgentExecution {
    id: string;
    agent: IAgentDefinition;
    task: string;
    config: TAgentConfig;
    tools: ToolSet;
    availableSkills: string;

    constructor(id: string,
        task: string,
        config: TAgentConfig,
        tools: ToolSet,
        availableSkills: string,
        agent: IAgentDefinition
    ) {
        this.id = id;
        this.task = task;
        this.config = config;
        this.tools = tools;
        this.availableSkills = availableSkills;
        this.agent = agent;
    }
}