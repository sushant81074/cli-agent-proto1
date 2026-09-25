import { parse } from "smol-toml";
import type {
    ISkill,
    ISkillMeta,
    ISkillToml
} from "./skill";

export function parseSkillToml(source: string, path: string): ISkill {
    const document = parse(source) as ISkillToml;

    if (typeof document.name !== "string" || document.name.trim().length === 0)
        throw new Error('Invalid skill: "name" must be a non-empty string.');
    if (typeof document.description !== "string" || document.description.trim().length === 0)
        throw new Error(`Invalid skill "${document.name}": "description" must be a non-empty string.`);
    if (typeof document.instructions !== "string" || document.instructions.trim().length === 0)
        throw new Error(`Invalid skill "${document.name}": "instructions" must be a non-empty string.`);

    const meta: ISkillMeta = {
        name: document.name.trim(),
        description: document.description.trim(),
        path
    };

    return {
        meta,
        instructions: document.instructions.trim()
    };
}