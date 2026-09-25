import { config } from 'dotenv';
import { Loader } from '../configs/loadConfig';
import { AgentExecution } from '../runtime/execution';
import { AgentLoop } from '../runtime/loop';
import { ToolCatalog } from '../tools/catalog';
import { FsGlob, FsMkdir, FsRead, FsWrite } from '../tools/fs';
import { OpenRouterProvider } from '../providers/openrouter';
import { PermissionPolicy } from '../permissions/policy';
import { CliPermissionPrompter } from '../permissions/cliPrompter';
import { SkillLoader } from '../configs/skillLoader';
import { join } from 'node:path';
import { ShellExec } from '../tools/shell';
import { OpenSkill } from '../tools/skill';
import { Logger } from '../utils/logger';
import { ExecutionMemory } from '../runtime/executionMemory';
import { AgentDefination } from '../runtime/agent';

config({ path: ".env" });

export class CliAgent {
    constructor() {
        console.log("🤖 agent started 🤖");
    }

    async run() {
        const args = process.argv.slice(2);

        let executionId: string | undefined;
        let task: string;

        if (args[0] === "--resume") {
            executionId = args[1];
            if (!executionId) {
                console.error('Usage: cmd --resume "<execution-id>" "<new task>"');
                process.exit(2);
            }

            task = args.slice(2).join(" ").trim();
            if (!task) {
                console.error('Usage: cmd --resume "<execution-id>" "<new task>"');
                process.exit(2);
            }
        } else {
            task = args.join(" ").trim();
            if (!task) {
                console.error('Usage: cmd "<task>"');
                process.exit(2);
            }
        }

        const loader = new Loader();
        const catalog = new ToolCatalog();
        const skillLoader = new SkillLoader(join(process.cwd(), "skills"));
        await skillLoader.discover();

        console.dir(skillLoader.list().map(s => s.meta.name).join(", "), { depth: null });

        const availableSkills = skillLoader.formatAvailableSkills(skillLoader.list());

        catalog.set(new FsRead());
        catalog.set(new FsGlob());
        catalog.set(new FsWrite());
        catalog.set(new FsMkdir());
        catalog.set(new ShellExec());
        catalog.set(new OpenSkill(skillLoader));

        const toolset = catalog.createToolSet(["fs_read", "fs_glob", "fs_write", "fs_mkdir", "shell_exec", "open_skill"]);
        const logger = new Logger(join(process.cwd(), "logs"), crypto.randomUUID());

        const memory = new ExecutionMemory(join(process.cwd(), "memory"));

        const agentConfig = loader.agentConfig();
        const agent = new AgentDefination(join(process.cwd(), "agents"));
        await agent.load();

        const execution = new AgentExecution(executionId ?? crypto.randomUUID(), task, agentConfig, toolset, availableSkills, agent);
        const provider = new OpenRouterProvider();
        const permissionPolicy = new PermissionPolicy("standard");
        const permissionPrompter = new CliPermissionPrompter();

        const agentloop = new AgentLoop(provider, execution, { workspaceRoot: process.cwd() }, permissionPolicy, permissionPrompter, memory, logger);
        const abort = new AbortController();

        for await (const event of agentloop.run(abort.signal)) {
            switch (event.type) {
                case "text": process.stdout.write(event.delta); break;
                case "tool_start": console.log(`\n[tool] ${event.toolName}`); break;
                case "tool_result": console.log(`[tool result] ${event.result.ok ? "success" : event.result.error}`); break;
                case "done": console.log("\n[done]"); break;
                default: break;
            }
        }

    }
}

new CliAgent()
    .run()
    .then(() => console.log("🤖 agent done 🤖"))
    .catch(e => {
        console.error("error occured while starting agent", e);
        process.exit(1);
    });