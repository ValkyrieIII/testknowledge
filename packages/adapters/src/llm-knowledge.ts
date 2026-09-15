import { createHash } from "node:crypto";
import { TEST_TECHNIQUES, type Evidence, type KnowledgeKind, type TestTechnique } from "@testknowledge/model";
import {
  bisectShard,
  excerptLimit,
  kindOfEvidence,
  LlmTruncationError,
  type AgenticMessage,
  type AgenticShardExtractor,
  type AgenticStepResult,
  type CandidateExtractionResult,
  type EvidenceClusterDraft,
  type ExtractionShard,
  type KnowledgeDraft,
  type ProjectScope,
  type ToolRead,
} from "@testknowledge/core";
import type { LlmResponseCache } from "./llm-response-cache.js";
import { systemPromptFor } from "./llm-prompts.js";

/**
 * Behaviour-level knowledge cards produced by an OpenAI-compatible model.
 *
 * The model only ever sees deterministic evidence. It proposes explicit clusters and wording;
 * the core validates every cluster before persistence. Model output is constrained to the
 * canonical technique vocabulary.
 *
 * Extraction runs one shard at a time: a shard carries a bounded slice of evidence and its own
 * output budget, so a single oversized prompt can no longer swallow the whole repository.
 */

type FetchLike = typeof fetch;

export type LlmKnowledgeConfig = {
  baseUrl: string;
  apiKey: string;
  model: string;
  fetch?: FetchLike;
  cache?: LlmResponseCache;
};

const KINDS = ["fixture", "mock", "boundary", "assertion", "behavior", "execution_recipe", "historical_bug", "environment"] as const;

/** Excerpt allowance for the legacy whole-corpus entry point. */
const GENERIC_EXCERPT_CHARS = 4000;

/** Output allowance for one agentic turn (a tool request is small; the final answer is not). */
const AGENTIC_STEP_TOKENS = 2000;

const TOOL_PROTOCOL = [
  "You may read the repository before answering.",
  'To read, reply with JSON only: {"toolCalls":[{"tool":"read"|"glob"|"grep"|"list_dir","target":"<repository-relative path or pattern>"}]}.',
  "Each read returns results carrying their evidence ids.",
  "When you have enough, reply with the final JSON described above and cite only evidence ids you were given.",
].join(" ");

function parseToolRequest(content: string): ToolRead[] | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch {
    return null;
  }
  if (parsed === null || typeof parsed !== "object") return null;
  const raw = (parsed as { toolCalls?: unknown }).toolCalls;
  if (!Array.isArray(raw)) return null;
  const calls = raw.flatMap((entry): ToolRead[] => {
    if (entry === null || typeof entry !== "object") return [];
    const record = entry as Record<string, unknown>;
    if (record.tool !== "read" && record.tool !== "glob" && record.tool !== "grep" && record.tool !== "list_dir") return [];
    if (typeof record.target !== "string" || record.target.trim() === "") return [];
    const options = record.options !== null && typeof record.options === "object" ? record.options as ToolRead["options"] : undefined;
    return [{ tool: record.tool, target: record.target, ...(options ? { options } : {}) }];
  });
  return calls.length > 0 ? calls : null;
}

function stringList(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

function objectList(value: unknown): Array<Record<string, unknown>> {
  return Array.isArray(value) ? value.filter((item): item is Record<string, unknown> => item !== null && typeof item === "object") : [];
}

function textList(value: unknown): string[] {
  return objectList(value).flatMap((item) => (typeof item.text === "string" ? [item.text] : []));
}

/** Compact, deterministic view of an evidence item for the prompt. */
function factsOf(evidence: Evidence, excerptChars: number): Record<string, unknown> {
  const payload = evidence.payload;
  const content = typeof evidence.content === "string" ? evidence.content : "";
  const exceptions = [
    ...objectList(payload.withBlocks).filter((item) => typeof item.call === "string" && /raises/u.test(item.call)).flatMap((item) => stringList(item.args)),
    ...objectList(payload.tryHandlers).flatMap((item) => stringList(item.exceptionTypes)),
    ...stringList(payload.expectedExceptions),
  ];
  return {
    sourceExcerpt: content.slice(0, excerptChars),
    assertions: textList(payload.assertions),
    expectedExceptions: [...new Set(exceptions)],
    language: typeof payload.language === "string" ? payload.language : "",
    framework: typeof payload.framework === "string" ? payload.framework : "",
    decorators: objectList(payload.decorators).flatMap((item) => (typeof item.text === "string" ? [item.text] : [])),
    parameters: objectList(payload.parameters).flatMap((item) => (typeof item.name === "string" ? [`${item.name}${typeof item.default === "string" ? `=${item.default}` : ""}`] : [])),
    mocks: stringList(payload.mocks),
    factories: stringList(payload.factories),
    calls: objectList(payload.calls).flatMap((item) => (typeof item.name === "string" ? [item.name] : [])),
    parametrize: stringList(payload.parametrize),
  };
}

type RawCard = Record<string, unknown>;

function mergeResults(results: CandidateExtractionResult[]): CandidateExtractionResult {
  const drafts: KnowledgeDraft[] = [];
  const clusters: EvidenceClusterDraft[] = [];
  for (const result of results) {
    const parts = Array.isArray(result) ? { drafts: result, clusters: [] } : result;
    drafts.push(...parts.drafts);
    clusters.push(...parts.clusters);
  }
  return { drafts, clusters };
}

export class LlmKnowledgeExtractor implements AgenticShardExtractor {
  readonly id = "extractor.llm.behavior-v2";

  private readonly fetchImpl: FetchLike;
  private readonly stepTokens = AGENTIC_STEP_TOKENS;

  constructor(private readonly config: LlmKnowledgeConfig) {
    this.fetchImpl = config.fetch ?? fetch;
  }

  /**
   * Opens an agentic turn: the usual per-kind prompt plus the tool protocol, so the model may
   * read the repository before it answers. Everything it reads comes back as evidence.
   */
  beginShard(shard: ExtractionShard, evidence: Evidence[]): AgenticMessage[] {
    const messages = this.buildMessages(evidence, shard.kind);
    const system = messages[0];
    if (system) system.content = `${system.content} ${TOOL_PROTOCOL}`;
    return messages;
  }

  async step(messages: AgenticMessage[]): Promise<AgenticStepResult> {
    const content = await this.call(messages, this.stepTokens, undefined);
    const request = parseToolRequest(content);
    return request === null ? { content } : { toolCalls: request };
  }

  finishShard(_shard: ExtractionShard, evidence: Evidence[], content: string): CandidateExtractionResult {
    return this.toResult(this.parse(content), evidence);
  }

  /**
   * Legacy entry point: one call over the whole corpus with the kind-agnostic instruction set.
   * Prefer `extractShard`, which is what the engine drives.
   */
  async extract(evidence: Evidence[], scope: ProjectScope): Promise<CandidateExtractionResult> {
    if (evidence.length === 0) return { drafts: [], clusters: [] };
    const shard: ExtractionShard = {
      id: `sh_all_${createHash("sha256").update(JSON.stringify({ repo: scope.repo, evidenceIds: evidence.map((item) => item.id) })).digest("hex").slice(0, 24)}`,
      kind: kindOfEvidence(evidence[0] as Evidence),
      subject: "",
      evidenceIds: evidence.map((item) => item.id),
      maxOutputTokens: 4000,
      estimatedInputTokens: 0,
    };
    return await this.runShard(shard, evidence, scope, undefined, null, 0);
  }

  async extractShard(shard: ExtractionShard, evidence: Evidence[], scope: ProjectScope, signal?: AbortSignal): Promise<CandidateExtractionResult> {
    return await this.runShard(shard, evidence, scope, signal, shard.kind, 0);
  }

  /**
   * A response cut off by the output budget is bisected once rather than retried unchanged:
   * the same shard would be truncated again, but half of it fits.
   */
  private async runShard(
    shard: ExtractionShard,
    evidence: Evidence[],
    scope: ProjectScope,
    signal: AbortSignal | undefined,
    promptKind: KnowledgeKind | null,
    depth: number,
  ): Promise<CandidateExtractionResult> {
    if (evidence.length === 0) return { drafts: [], clusters: [] };
    try {
      return await this.callShard(shard, evidence, scope, signal, promptKind);
    } catch (error) {
      if (!(error instanceof LlmTruncationError) || depth > 0 || evidence.length < 2) throw error;
      const halves = bisectShard(shard, evidence);
      const results: CandidateExtractionResult[] = [];
      for (const half of halves) {
        results.push(...[await this.runShard(half.shard, half.evidence, scope, signal, promptKind, depth + 1)]);
      }
      return mergeResults(results);
    }
  }

  private excerptCharsFor(promptKind: KnowledgeKind | null): number {
    return promptKind === null ? GENERIC_EXCERPT_CHARS : excerptLimit(promptKind);
  }

  private async callShard(
    shard: ExtractionShard,
    evidence: Evidence[],
    _scope: ProjectScope,
    signal: AbortSignal | undefined,
    promptKind: KnowledgeKind | null,
  ): Promise<CandidateExtractionResult> {
    const messages = this.buildMessages(evidence, promptKind);
    const cacheKey = createHash("sha256").update(JSON.stringify({
      extractor: this.id,
      endpoint: this.config.baseUrl.replace(/\/$/u, ""),
      model: this.config.model,
      temperature: 0,
      maxTokens: shard.maxOutputTokens,
      // The tool reads of phase 4 are deliberately absent: a cached response must not be
      // keyed on what the model happened to read, only on what it was asked.
      shard: { id: shard.id, kind: shard.kind, subject: shard.subject, evidenceIds: shard.evidenceIds },
      responseFormat: "json_object",
      messages,
    })).digest("hex");

    const cached = await this.config.cache?.get(cacheKey);
    if (cached !== undefined) {
      try {
        return this.toResult(this.parse(cached), evidence);
      } catch {
        // A corrupted or stale cache entry falls through to a fresh call.
      }
    }
    const content = await this.call(messages, shard.maxOutputTokens, signal);
    const parsed = this.parse(content);
    await this.config.cache?.set(cacheKey, content);
    return this.toResult(parsed, evidence);
  }

  private toResult(parsed: { clusters: RawCard[]; cards: RawCard[] }, evidence: Evidence[]): CandidateExtractionResult {
    const byId = new Map(evidence.map((item) => [item.id, item]));
    const clusters: EvidenceClusterDraft[] = [];
    const drafts: KnowledgeDraft[] = parsed.cards.flatMap((card) => this.toDraft(card, byId));
    for (const proposal of parsed.clusters) {
      const evidenceIds = [...new Set(stringList(proposal.evidenceIds))];
      if (evidenceIds.length < 2 || evidenceIds.some((id) => !byId.has(id))) continue;
      if (typeof proposal.subject !== "string" || !proposal.subject.trim() || typeof proposal.shape !== "string" || !proposal.shape.trim()) continue;
      const confidence = typeof proposal.confidence === "number" ? Math.max(0, Math.min(1, proposal.confidence)) : 0.5;
      clusters.push({ subject: proposal.subject, shape: proposal.shape, evidenceIds, confidence, extractor: this.id });
      if (proposal.card !== null && typeof proposal.card === "object" && !Array.isArray(proposal.card)) {
        drafts.push(...this.toDraft({ ...(proposal.card as RawCard), evidenceIds }, byId, evidenceIds, proposal.subject, proposal.shape));
      }
    }
    return { drafts, clusters };
  }

  private buildMessages(evidence: Evidence[], promptKind: KnowledgeKind | null): Array<{ role: string; content: string }> {
    const excerptChars = this.excerptCharsFor(promptKind);
    const system = [
      systemPromptFor(promptKind),
      `Techniques MUST be selected only from: ${TEST_TECHNIQUES.join(", ")}.`,
    ].join(" ");
    const user = JSON.stringify({
      evidence: evidence.map((item) => ({
        id: item.id,
        path: item.path,
        symbol: item.symbol,
        sourceType: item.sourceType,
        facts: factsOf(item, excerptChars),
      })),
    });
    return [
      { role: "system", content: system },
      { role: "user", content: user },
    ];
  }

  private async call(messages: Array<{ role: string; content: string }>, maxTokens: number, signal: AbortSignal | undefined): Promise<string> {
    const response = await this.fetchImpl(`${this.config.baseUrl.replace(/\/$/u, "")}/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${this.config.apiKey}` },
      body: JSON.stringify({
        model: this.config.model,
        temperature: 0,
        max_tokens: maxTokens,
        response_format: { type: "json_object" },
        messages,
      }),
      ...(signal ? { signal } : {}),
    });
    if (!response.ok) throw new Error(`LLM request failed: ${response.status}`);
    const body = (await response.json()) as { choices?: Array<{ message?: { content?: string } }> };
    const choice = body.choices?.[0] as { message?: { content?: string }; finish_reason?: string } | undefined;
    if (choice?.finish_reason === "length") throw new LlmTruncationError("LLM response was cut off by the output budget");
    const content = choice?.message?.content;
    if (!content) throw new Error("LLM response did not contain content");
    return content;
  }

  private parse(content: string): { clusters: RawCard[]; cards: RawCard[] } {
    try {
      const parsed = JSON.parse(content) as { clusters?: unknown; cards?: unknown };
      const objects = (value: unknown): RawCard[] => Array.isArray(value) ? value.filter((item): item is RawCard => item !== null && typeof item === "object" && !Array.isArray(item)) : [];
      return { clusters: objects(parsed.clusters), cards: objects(parsed.cards) };
    } catch (error) {
      // A truncated response is invalid JSON. Report it as truncation so the caller can bisect
      // instead of retrying the identical oversized request.
      throw error instanceof SyntaxError ? new LlmTruncationError(`LLM response was not valid JSON: ${error.message}`) : error;
    }
  }

  private toDraft(card: RawCard, byId: Map<string, Evidence>, clusterEvidenceIds?: string[], clusterSubject?: string, clusterShape?: string): KnowledgeDraft[] {
    const evidenceIds = [...new Set(clusterEvidenceIds ?? stringList(card.evidenceIds))];
    if (evidenceIds.length === 0 || evidenceIds.some((id) => !byId.has(id))) return [];
    for (const field of ["title", "statement", "trigger", "expectedBehavior", "oracle"] as const) {
      if (typeof card[field] !== "string" || !(card[field] as string).trim()) return [];
    }
    const source = byId.get(evidenceIds[0] as string);
    if (!source) return [];
    const cited = evidenceIds.map((id) => byId.get(id)!).filter(Boolean);
    const languages = [...new Set(cited.flatMap((item) => typeof item.payload.language === "string" && item.payload.language ? [item.payload.language] : stringList(item.payload.languages)))];
    const frameworks = [...new Set(cited.flatMap((item) => typeof item.payload.framework === "string" && item.payload.framework ? [item.payload.framework] : stringList(item.payload.frameworks)))];
    const kind = typeof card.kind === "string" && (KINDS as readonly string[]).includes(card.kind) ? (card.kind as KnowledgeDraft["kind"]) : "behavior";
    const rawTechniques = stringList(card.techniques);
    if (rawTechniques.some((technique) => !(TEST_TECHNIQUES as readonly string[]).includes(technique))) return [];
    const techniques = rawTechniques as TestTechnique[];
    const confidence = typeof card.confidence === "number" ? Math.max(0, Math.min(1, card.confidence)) : 0.5;
    return [
      {
        kind,
        title: card.title as string,
        statement: card.statement as string,
        trigger: card.trigger as string,
        expectedBehavior: card.expectedBehavior as string,
        oracle: card.oracle as string,
        risk: typeof card.risk === "string" && card.risk.trim() ? card.risk : "模型候选，需要人工审核",
        path: source.path,
        symbol: source.symbol,
        targetSymbols: stringList(card.targetSymbols),
        partitions: stringList(card.partitions),
        preconditions: stringList(card.preconditions),
        dependencies: stringList(card.dependencies),
        techniques,
        applicability: { languages, frameworks, paths: stringList(card.applicablePaths), symbols: stringList(card.targetSymbols), revision: source.revision },
        evidenceIds,
        confidence,
        ...(clusterEvidenceIds && clusterSubject && clusterShape ? { clusterEvidenceIds, clusterSubject, clusterShape } : {}),
      },
    ];
  }
}
