import type { AgenticMessage, AgenticStepResult, EvidenceToolRuntime, ProjectScope, ReadLogEntry, ToolRead } from "./ports.js";
import type { Evidence } from "@testknowledge/model";

/**
 * Tool-using extraction.
 *
 * The model may ask to read the repository; every result is captured as evidence and echoed back.
 * Because the model now influences *what* is read, the build is no longer determined by the
 * repository alone — the returned read log is what makes it reproducible, and it is deliberately
 * kept out of the response cache key so a cached answer is never keyed on a stray read.
 */

export type AgenticStep = (messages: AgenticMessage[]) => Promise<AgenticStepResult>;

export type AgenticExtractionRun = {
  content: string;
  /** Evidence discovered by tool reads, to be merged into the build. */
  evidence: Evidence[];
  readLog: ReadLogEntry[];
  toolCalls: number;
};

export const MAX_TOOL_CALLS_PER_SHARD = 8;
export const READ_EXCERPT_CHARS = 4000;

export async function runAgenticExtraction(options: {
  runtime: EvidenceToolRuntime;
  step: AgenticStep;
  scope: ProjectScope;
  messages: AgenticMessage[];
  maxToolCalls?: number;
}): Promise<AgenticExtractionRun> {
  const maxToolCalls = options.maxToolCalls ?? MAX_TOOL_CALLS_PER_SHARD;
  const messages = [...options.messages];
  const evidence: Evidence[] = [];
  const readLog: ReadLogEntry[] = [];
  const seen = new Set<string>();
  let toolCalls = 0;

  const record = (call: ToolRead, found: Evidence[]): void => {
    for (const item of found) {
      readLog.push({ tool: call.tool, target: call.target, contentHash: item.contentHash, evidenceId: item.id });
      if (seen.has(item.id)) continue;
      seen.add(item.id);
      evidence.push(item);
    }
  };

  for (;;) {
    const response = await options.step(messages);
    const requested = response.toolCalls ?? [];
    if (requested.length === 0) return { content: response.content ?? "", evidence, readLog, toolCalls };

    if (toolCalls >= maxToolCalls) {
      messages.push({ role: "user", content: "The repository read budget is exhausted. Answer now with the final JSON and cite only the evidence you were given." });
      const final = await options.step(messages);
      return { content: final.content ?? "", evidence, readLog, toolCalls };
    }

    for (const call of requested) {
      if (toolCalls >= maxToolCalls) break;
      toolCalls += 1;
      let found: Evidence[] = [];
      try {
        found = await options.runtime.read(call, options.scope);
      } catch (error) {
        messages.push({ role: "user", content: JSON.stringify({ toolError: { tool: call.tool, target: call.target, message: error instanceof Error ? error.message : String(error) } }) });
        continue;
      }
      record(call, found);
      messages.push({ role: "assistant", content: JSON.stringify({ toolCall: call }) });
      messages.push({
        role: "user",
        content: JSON.stringify({
          toolResults: found.map((item) => ({ id: item.id, path: item.path, sourceRef: item.sourceRef, content: item.content.slice(0, READ_EXCERPT_CHARS) })),
        }),
      });
    }
  }
}
