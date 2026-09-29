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
import { AgentDefinition } from '../runtime/agent';
import type { TRunOutcome } from '../runtime';

config({ path: ".env" });

// From the build guide: 0 done, 1 failed, 4 over budget, 130 interrupted.
const EXIT_CODES: Record<TRunOutcome, number> = {
    completed: 0,
    max_iterations: 1,
    budget_exceeded: 4,
    cancelled: 130,
};

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

        // The agent file is loaded first because the config falls back to its model.
        const agent = new AgentDefinition(join(process.cwd(), "agents"));
        await agent.load();
        const agentConfig = loader.agentConfig(agent);
        console.log(`model: ${agentConfig.model} (from ${agentConfig.modelSource}) · permissions: ${agentConfig.permissionMode}`);

        const execution = new AgentExecution(executionId ?? crypto.randomUUID(), task, agentConfig, toolset, availableSkills, agent);
        const provider = new OpenRouterProvider();
        // Before, this was hardcoded to "standard" and permissionMode from .env was ignored.
        const permissionPolicy = new PermissionPolicy(agentConfig.permissionMode);
        const permissionPrompter = new CliPermissionPrompter();

        const agentloop = new AgentLoop(provider, execution, { workspaceRoot: process.cwd() }, permissionPolicy, permissionPrompter, memory, logger);

        // Before, this controller existed but nothing ever called abort(), so Ctrl-C just killed the
        // process mid-write. First Ctrl-C cancels cleanly (the checkpoint is saved); a second one force-quits.
        const abort = new AbortController();
        const onSigint = () => {
            if (abort.signal.aborted) {
                console.log("\nForce quit.");
                process.exit(130);
            }
            console.log("\nCancelling... (press Ctrl-C again to force quit)");
            abort.abort();
        };
        process.on("SIGINT", onSigint);

        try {
            for await (const event of agentloop.run(abort.signal)) {
                switch (event.type) {
                    case "text": process.stdout.write(event.delta); break;
                    case "tool_start": console.log(`\n[tool] ${event.toolName}`); break;
                    case "tool_result": console.log(`[tool result] ${event.result.ok ? "success" : event.result.error}`); break;
                    case "done": {
                        const { outcome, iterations, usage } = event;
                        const tokens = usage.inputTokens + usage.outputTokens;
                        console.log(`\n[${outcome}] ${iterations} iterations · ${tokens} tokens · $${usage.costUsd.toFixed(4)} · execution ${execution.id}`);
                        process.exitCode = EXIT_CODES[outcome];
                    } break;
                    default: break;
                }
            }
        } finally {
            process.off("SIGINT", onSigint);
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