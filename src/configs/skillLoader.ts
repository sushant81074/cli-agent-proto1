import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import type { ISkill, ISkillLoader } from "./skill";
import { parseSkillToml } from "./formatter";

export class SkillLoader implements ISkillLoader {
    readonly skills: Map<string, ISkill>;
    constructor(
        private readonly skillsRoot: string
    ) {
        this.skills = new Map();
    }

    async discover(): Promise<void> {
        this.skills.clear();

        const entries = await readdir(this.skillsRoot, { withFileTypes: true });

        for (const entry of entries) {
            if (!entry.isDirectory()) continue;

            const skillPath = join(this.skillsRoot, entry.name, "SKILL.toml");
            const fileData = await readFile(skillPath, "utf-8");
            const skillData = parseSkillToml(fileData, skillPath);
            if (entry.name !== skillData.meta.name) throw new Error(`Skill name mismatch: directory "${entry.name}" ` + `contains skill "${skillData.meta.name}".`);

            this.skills.set(skillData.meta.name, skillData);
        }
        // console.log(this.skills);
        return;
    }

    open(name: string): ISkill {
        const skill = this.skills.get(name);
        if (!skill) throw new Error(`Skill not found`);
        return skill;
    }

    list(): ISkill[] {
        return Array.from(this.skills.values());
    }

    formatAvailableSkills(skills: ISkill[]): string {
        if (skills.length === 0) return "No skills are currently available.";
        return skills.map((skill) => `- ${skill.meta.name}: ${skill.meta.description}`).join("\n");
    }

}

