import { readFile, glob, writeFile, mkdir, access } from "node:fs/promises";
import nodepath from "node:path";
import { z } from "zod";

import type { IToolContext, IToolDefinition, IToolResult, TResolvedPathResult, TToolEffect } from "../domains/tool";

const readInputSchema = z.object({
    path: z.string().min(1).describe("Workspace-relative path of the file to read, for example package.json, readme.md, etc")
});
const globInputSchema = z.object({
    pattern: z.string().min(1).describe("Workspace-relative glob pattern, for example skills/**/SKILL.toml")
});
export const writeInputSchema = z.object({
    filePath: z.string().min(1).regex(/^(?!\*)/, "File path cannot contain glob wildcards").describe("Exact workspace-relative file path. Example: 'skills/researcher/skill.toml'"),
    content: z.string().describe("The exact text content to write into the file"),
    overwrite: z.boolean().default(false).describe("Set to true to explicitly overwrite an existing file. Defaults to false for data safety.")
});
export const mkdirInputSchema = z.object({
    dirPath: z.string().min(1).regex(/^(?!\*)/, "Directory path cannot contain glob wildcards").describe("Exact workspace-relative folder path. Example: 'skills/researcher/'"),
});


type TReadInput = z.infer<typeof readInputSchema>;
type TGlobInput = z.infer<typeof globInputSchema>;
type TWriteInput = z.infer<typeof writeInputSchema>;
type TMkdirInput = z.infer<typeof mkdirInputSchema>;

const MAX_OUTPUT_BYTES = Number(process.env.MAX_OUTPUT_BYTES) || 30_000;

export class FileResolver {

    resolveFilePath(workspaceRoot: string, requestedPath: string): TResolvedPathResult {
        const rootDir = nodepath.resolve(workspaceRoot);
        const requestedFile = nodepath.resolve(rootDir, requestedPath);
        const relativePath = nodepath.relative(rootDir, requestedFile);

        if (relativePath === "" || (!relativePath.startsWith("..") && !nodepath.isAbsolute(relativePath)))
            return { ok: true, path: requestedFile };

        return { ok: false, error: "Path is outside the workspace" };
    }

    truncateOutput(content: string) {
        const bytes = Buffer.byteLength(content, "utf8");
        if (bytes <= MAX_OUTPUT_BYTES) return content;

        const truncated = Buffer.from(content, "utf8").subarray(0, MAX_OUTPUT_BYTES);

        return (truncated.toString("utf8") + `\n\n...[truncated ${bytes - MAX_OUTPUT_BYTES} bytes]...`);
    }

}

export class FsRead implements IToolDefinition<TReadInput> {
    name: string;
    description: string;
    schema: z.ZodType<TReadInput>;
    effect: TToolEffect;
    private fileResolver: FileResolver;

    constructor() {
        this.name = "fs_read";
        this.description = "Read a UTF-8 text file inside the workspace. Use this when you need to inspect the contents of a specific file before answering or modifying the repository.";
        this.schema = readInputSchema;
        this.effect = "read";
        this.fileResolver = new FileResolver();
    }

    async handler(input: TReadInput, context: IToolContext): Promise<IToolResult> {
        try {
            const path = this.fileResolver.resolveFilePath(context.workspaceRoot, input.path);
            if (!path.ok) return { ok: false, error: path.error, content: "" };

            const content = await readFile(path.path, "utf-8");
            return { ok: true, content: this.fileResolver.truncateOutput(content) };
        } catch (error) {
            return { ok: false, error: error instanceof Error ? error?.message : "", content: "" };
        }
    }
}

export class FsGlob implements IToolDefinition<TGlobInput> {
    name: string;
    description: string;
    schema: z.ZodType<TGlobInput>;
    effect: TToolEffect;

    constructor() {
        this.name = "fs_glob";
        this.description = "Find files inside the workspace using a glob pattern. Use this when you need to discover files or directories before reading specific files.";
        this.schema = globInputSchema;
        this.effect = "read";
    }

    async handler(input: TGlobInput, context: IToolContext): Promise<IToolResult> {
        try {
            const matches: string[] = [];
            for await (const match of glob(input.pattern, { cwd: context.workspaceRoot })) {
                matches.push(match);
            }
            return {
                ok: true,
                content: matches.join("\n")
            };
        } catch (error) {
            return { ok: false, error: error instanceof Error ? error?.message : "", content: "" };
        }
    }
}


export class FsWrite implements IToolDefinition<TWriteInput> {
    name: string;
    description: string;
    schema: z.ZodType<TWriteInput>;
    effect: TToolEffect;
    private fileResolver: FileResolver;

    constructor() {
        this.name = "fs_write";
        this.description = "Write exact text content to a specific file within the workspace. Automatically generates any missing parent directories natively.";
        this.schema = writeInputSchema;
        this.effect = "write";
        this.fileResolver = new FileResolver();
    }

    async handler(input: TWriteInput, context: IToolContext): Promise<IToolResult> {
        try {
            const path = this.fileResolver.resolveFilePath(context.workspaceRoot, input.filePath);
            if (!path.ok) return { ok: false, error: path.error, content: "" };

            if (!input.overwrite) {
                try {
                    await access(path.path);
                    return {
                        ok: false,
                        error: `File protection fault: '${input.filePath}' already exists. Set 'overwrite: true' if changes are intended.`,
                        content: ""
                    };
                } catch {
                    // Safe pathway: File does not exist
                }
            }

            const parentDir = nodepath.dirname(path.path);
            await mkdir(parentDir, { recursive: true });
            await writeFile(path.path, input.content, "utf-8");

            return {
                ok: true,
                content: `Successfully wrote ${Buffer.byteLength(input.content)} bytes to ${input.filePath}`
            };
        } catch (error) {
            return { ok: false, error: error instanceof Error ? error?.message : "", content: "" };
        }
    }
}

export class FsMkdir implements IToolDefinition<TMkdirInput> {
    name: string;
    description: string;
    schema: z.ZodType<TMkdirInput>;
    effect: TToolEffect;
    private fileResolver: FileResolver;

    constructor() {
        this.name = "fs_mkdir";
        this.description = "Explicitly create a new directory tree path within the workspace.";
        this.schema = mkdirInputSchema;
        this.effect = "write";
        this.fileResolver = new FileResolver();
    }

    async handler(input: TMkdirInput, context: IToolContext): Promise<IToolResult> {
        try {
            const path = this.fileResolver.resolveFilePath(context.workspaceRoot, input.dirPath);
            if (!path.ok) return { ok: false, error: path.error, content: "" };

            await mkdir(path.path, { recursive: true });

            return {
                ok: true,
                content: `Successfully created dir: ${path.path}`
            };
        } catch (error) {
            return { ok: false, error: error instanceof Error ? error?.message : "", content: "" };
        }
    }
}

