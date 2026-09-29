import type { IContentBlock, IModelMessage } from "../providers";

const INTERRUPTED = "Interrupted: the previous run stopped before this tool call finished. It may or may not have taken effect, so check before retrying.";

/**
 * Makes a saved conversation safe to send again before resuming it.
 *
 * A run can stop in the middle of a tool batch (crash, Ctrl-C, kill). The provider APIs reject any
 * tool_use that has no matching tool_result, so every resume of such a checkpoint used to fail.
 * Missing results are filled in with an error the model can reason about.
 */
export function repairHistory(messages: IModelMessage[]): IModelMessage[] {
    // Providers also reject messages with no content at all.
    const repaired = messages.filter(m => m.content.length > 0);

    const lastAssistant = repaired.findLastIndex(m => m.role === "assistant");
    if (lastAssistant === -1) return repaired;

    const toolUseIds = blocks(repaired[lastAssistant]!).flatMap(b => b.type === "tool_use" ? [b.id] : []);
    const answered = new Set(
        repaired.slice(lastAssistant + 1).flatMap(blocks).flatMap(b => b.type === "tool_result" ? [b.toolUseId] : [])
    );
    const missing = toolUseIds.filter(id => !answered.has(id));
    if (missing.length === 0) return repaired;

    repaired.push({
        role: "user",
        content: missing.map(toolUseId => ({ type: "tool_result", toolUseId, content: INTERRUPTED, isError: true })),
    });
    return repaired;
}

function blocks(message: IModelMessage): IContentBlock[] {
    return typeof message.content === "string" ? [] : message.content;
}
