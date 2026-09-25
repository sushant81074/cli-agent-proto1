export interface ISkillMeta {
    readonly name: string;
    readonly description: string;
    readonly path: string;
}

export interface ISkill {
    readonly meta: ISkillMeta;
    readonly instructions: string;
}

export interface ISkillFrontMatter {
    readonly name: unknown;
    readonly description: unknown;
}

export interface ISkillToml {
    readonly name?: unknown;
    readonly description?: unknown;
    readonly instructions?: unknown;
}

export interface ISkillLoader {
    readonly skills: Map<string, ISkill>;
    discover(): Promise<void>;
    open(name: string): ISkill;
    list(): ISkill[];
}