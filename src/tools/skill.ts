import { z } from "zod";
import type { ISkillLoader } from "../configs/skill";
import type { IToolContext, IToolDefinition, IToolResult, TToolEffect } from "../domains/tool";

export const openSkillInputSchema = z.object({
    name: z.string().min(1).describe("The literal shell command to execute within the workspace root. Example: 'npm test', 'git status'")
});

type TOpenSkillInput = z.infer<typeof openSkillInputSchema>;

export class OpenSkill implements IToolDefinition<TOpenSkillInput> {
    readonly name;
    readonly description;
    schema: z.ZodType<TOpenSkillInput>;
    effect: TToolEffect;
    constructor(private readonly skillLoader: ISkillLoader) {
        this.name = "open_skill";
        this.description = "Load the full instructions for an available skill.\n Use this when a task requires the detailed guidance provided by a specific skill.\n";
        this.schema = openSkillInputSchema;
        this.effect = "meta";
    }

    async handler(input: TOpenSkillInput, _: IToolContext): Promise<IToolResult> {
        try {
            const skill = this.skillLoader.open(input.name);
            return {
                ok: true,
                content: skill.instructions
            };
        } catch (error) {
            return {
                ok: false,
                error: error instanceof Error ? error.message : String(error),
                content: ""
            };
        }
    }
}