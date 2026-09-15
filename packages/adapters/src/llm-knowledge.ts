import { createHash } from "node:crypto";
import { TEST_TECHNIQUES, type Evidence, type KnowledgeKind, type TestTechnique } from "@testknowledge/model";
import {
  bisectShard,
  excerptLimit,
  kindOfEvidence,
  LlmResponseFormatError,
  LlmTruncationError,
  type AgenticMessage,
  type AgenticShardExtractor,
  type AgenticStepResult,
  type CachedAgenticRun,
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
  const record = parsed as Record<string, unknown>;
  // The protocol asks for a `toolCalls` array, but a model may answer with a single `toolCall`
  // object. Recognise both: mistaking a read request for a final answer ends the loop and
  // silently reports an empty shard.
  const raw = Array.isArray(record.toolCalls) ? record.toolCalls : record.toolCall !== undefined ? [record.toolCall] : [];
  const calls = raw.flatMap((entry): ToolRead[] => {
    if (entry === null || typeof entry !== "object") return [];
    const call = entry as Record<string, unknown>;
    if (call.tool !== "read" && call.tool !== "glob" && call.tool !== "grep" && call.tool !== "list_dir") return [];
    if (typeof call.target !== "string" || call.target.trim() === "") return [];
    const options = call.options !== null && typeof call.options === "object" ? call.options as ToolRead["options"] : undefined;
    return [{ tool: call.tool, target: call.target, ...(options ? { options } : {}) }];
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
  private activeStepTokens = AGENTIC_STEP_TOKENS;

  constructor(private readonly config: LlmKnowledgeConfig) {
    this.fetchImpl = config.fetch ?? fetch;
  }

  /**
   * Opens an agentic turn: the usual per-kind prompt plus the tool protocol, so the model may
   * read the repository before it answers. Everything it reads comes back as evidence.
   */
  beginShard(shard: ExtractionShard, evidence: Evidence[]): AgenticMessage[] {
    // The last turn produces the answer, so it gets the shard's own budget rather than a small
    // fixed cap: a reasoning model spends part of that budget before emitting any JSON.
    // Shards are driven sequentially, so tracking the active budget on the instance is safe.
    this.activeStepTokens = shard.maxOutputTokens;
    const messages = this.buildMessages(evidence, shard.kind);
    const system = messages[0];
    if (system) system.content = `${system.content} ${TOOL_PROTOCOL}`;
    return messages;
  }

  async step(messages: AgenticMessage[]): Promise<AgenticStepResult> {
    const content = await this.call(messages, this.activeStepTokens, undefined);
    const request = parseToolRequest(content);
    return request === null ? { content } : { toolCalls: request };
  }

  finishShard(_shard: ExtractionShard, evidence: Evidence[], content: string): CandidateExtractionResult {
    return this.toResult(this.parse(content), evidence);
  }

  /**
   * Replay a completed tool-using run for this shard.
   *
   * The read log is cached alongside the answer on purpose. The log feeds the build revision, so
   * restoring only the answer would land a replayed build on a different revision than the run
   * it came from.
   */
  async loadRun(shard: ExtractionShard, evidence: Evidence[]): Promise<CachedAgenticRun | undefined> {
    const cached = await this.config.cache?.get(this.runCacheKey(shard, evidence));
    if (cached === undefined) return undefined;
    try {
      const parsed = JSON.parse(cached) as Partial<CachedAgenticRun>;
      if (typeof parsed.content !== "string" || !Array.isArray(parsed.readLog) || !Array.isArray(parsed.evidence)) return undefined;
      return { content: parsed.content, readLog: parsed.readLog, evidence: parsed.evidence };
    } catch {
      return undefined;
    }
  }

  async saveRun(shard: ExtractionShard, evidence: Evidence[], run: CachedAgenticRun): Promise<void> {
    await this.config.cache?.set(this.runCacheKey(shard, evidence), JSON.stringify(run));
  }

  /**
   * Keyed on the exact prompt the model is shown, and never on what the model chose to read.
   *
   * Using the source file's hash instead would miss a change in how an adapter *summarises*
   * evidence: the file is unchanged, the question is different, and a stale answer would be
   * replayed. Keying on the prompt covers both, while still excluding the read log — the prompt
   * is the opening state, before any read happened.
   */
  private runCacheKey(shard: ExtractionShard, evidence: Evidence[]): string {
    return createHash("sha256").update(JSON.stringify({
      extractor: this.id,
      endpoint: this.config.baseUrl.replace(/\/$/u, ""),
      model: this.config.model,
      temperature: 0,
      purpose: "agentic-run",
      shard: { id: shard.id, kind: shard.kind, subject: shard.subject },
      prompt: this.buildMessages(evidence, shard.kind),
    })).digest("hex");
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
      // Only a response that produced text is worth bisecting: then half the input genuinely fits.
      // A response that produced nothing spent the budget elsewhere — a reasoning model's hidden
      // tokens — and splitting the shard would pay that same cost twice for the same nothing.
      const bisectable = error instanceof LlmTruncationError && error.contentPresent;
      if (!bisectable || depth > 0 || evidence.length < 2) throw error;
      const results: CandidateExtractionResult[] = [];
      const failures: unknown[] = [];
      for (const half of bisectShard(shard, evidence)) {
        try {
          results.push(await this.runShard(half.shard, half.evidence, scope, signal, promptKind, depth + 1));
        } catch (halfError) {
          failures.push(halfError);
        }
      }
      // Keep whatever the halves did produce. Throwing away a sibling's cards because the other
      // half failed would discard work that no ledger row accounts for.
      if (failures.length > 0 && results.length === 0) throw failures[0];
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
    const content = choice?.message?.content;
    if (choice?.finish_reason === "length") {
      // Distinguish "ran out mid-answer" from "spent the whole budget before producing anything".
      // Only the first can be fixed by sending less input.
      throw new LlmTruncationError("LLM response was cut off by the output budget", (content ?? "").trim().length > 0);
    }
    if (!content) throw new Error("LLM response did not contain content");
    return content;
  }

  private parse(content: string): { clusters: RawCard[]; cards: RawCard[] } {
    let parsed: unknown;
    try {
      parsed = JSON.parse(content);
    } catch (error) {
      if (!(error instanceof SyntaxError)) throw error;
      // A body that never looked like JSON is a gateway or proxy answer, not a truncated one.
      // Retry it as a transport failure; bisecting would pay for the same failure twice.
      const trimmed = content.trim();
      if (!trimmed.startsWith("{") && !trimmed.startsWith("[")) {
        throw new LlmResponseFormatError(`LLM response was not JSON: ${trimmed.slice(0, 120)}`);
      }
      // A truncated response is invalid JSON. Report it as truncation so the caller can decide
      // between sending less input and asking for more room.
      throw new LlmTruncationError(`LLM response was not valid JSON: ${error.message}`);
    }
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new LlmResponseFormatError(`LLM response was not an object: ${content.trim().slice(0, 120)}`);
    }
    const record = parsed as { clusters?: unknown; cards?: unknown };
    // A JSON object carrying neither key is not an extraction result — most often a tool request
    // in a shape that was not recognised. Failing loudly beats reporting a shard that produced
    // nothing while the ledger calls it a success.
    if (!("cards" in record) && !("clusters" in record)) {
      throw new LlmResponseFormatError(`LLM response carried neither cards nor clusters: ${content.trim().slice(0, 120)}`);
    }
    const objects = (value: unknown): RawCard[] => Array.isArray(value) ? value.filter((item): item is RawCard => item !== null && typeof item === "object" && !Array.isArray(item)) : [];
    return { clusters: objects(record.clusters), cards: objects(record.cards) };
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
