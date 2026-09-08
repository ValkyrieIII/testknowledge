import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import {
  ContextRequestSchema,
  type ContextPack,
  type ContextRequest,
  type Evidence,
  type KnowledgeCard,
  ReviewRequestSchema,
  type ReviewRequest,
} from "@testknowledge/model";
import type {
  CandidateExtractor,
  KnowledgeDraft,
  KnowledgeRepository,
  ProjectScope,
  SearchIndex,
  SourceAdapter,
  SourceFile,
  SourceSpec,
} from "./ports.js";

const isoNow = (): string => new Date().toISOString();

function digest(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

/**
 * Identity of a card is its own semantic content plus the repository.
 * `revision`, `evidenceIds` and `confidence` are deliberately excluded:
 * a line shift or a project-wide rebuild must not invalidate a reviewed card.
 */
function cardKey(draft: KnowledgeDraft, repo: string): string {
  return JSON.stringify({
    repo,
    kind: draft.kind,
    title: draft.title,
    statement: draft.statement,
    trigger: draft.trigger,
    expectedBehavior: draft.expectedBehavior,
    oracle: draft.oracle,
    risk: draft.risk,
    path: draft.path,
    symbol: draft.symbol,
  });
}

function stableCardId(draft: KnowledgeDraft, repo: string): string {
  return `kc_${digest(cardKey(draft, repo)).slice(0, 24)}`;
}

function toCard(draft: KnowledgeDraft, scope: ProjectScope, previous?: KnowledgeCard): KnowledgeCard {
  const now = isoNow();
  const sourceHash = digest(cardKey(draft, scope.repo));
  return {
    id: stableCardId(draft, scope.repo),
    kind: draft.kind,
    title: draft.title,
    statement: draft.statement,
    trigger: draft.trigger,
    expectedBehavior: draft.expectedBehavior,
    oracle: draft.oracle,
    risk: draft.risk,
    repo: scope.repo,
    revision: scope.revision,
    path: draft.path,
    symbol: draft.symbol,
    evidenceIds: draft.evidenceIds,
    confidence: draft.confidence,
    status: previous?.sourceHash === sourceHash ? previous.status : "candidate",
    sourceHash,
    createdAt: previous?.createdAt ?? now,
    updatedAt: previous?.sourceHash === sourceHash ? previous.updatedAt : now,
  };
}

export class KnowledgeEngine {
  constructor(
    private readonly repository: KnowledgeRepository,
    private readonly index: SearchIndex,
    private readonly sourceAdapters: SourceAdapter[],
    private readonly ruleExtractor: CandidateExtractor,
    private readonly llmExtractor?: CandidateExtractor,
  ) {}

  async build(input: {
    repo: string;
    files: SourceFile[];
    useLlm: boolean;
  }): Promise<{ repo: string; revision: string; evidenceCount: number; knowledgeCount: number; extractor: string[]; warnings: string[] }> {
    const revision = digest(input.files.map((file) => `${file.path}:${digest(file.text)}`).sort().join("\n"));
    const scope: ProjectScope = { repo: input.repo, revision };
    const evidence: Evidence[] = [];
    for (const file of input.files) {
      const adapter = this.sourceAdapters.find((item) => item.supports(file));
      if (!adapter) continue;
      evidence.push(...await adapter.collect(file, scope));
    }
    const drafts = await this.ruleExtractor.extract(evidence, scope);
    const extractors = [this.ruleExtractor.id];
    const warnings: string[] = [];
    if (input.useLlm) {
      if (!this.llmExtractor) {
        warnings.push("llm:unconfigured");
      } else {
        try {
          drafts.push(...await this.llmExtractor.extract(evidence, scope));
          extractors.push(this.llmExtractor.id);
        } catch {
          warnings.push(`${this.llmExtractor.id}:failed`);
        }
      }
    }
    const previous = await this.repository.readKnowledge();
    const previousById = new Map(previous.map((card) => [card.id, card]));
    const cards = [
      ...previous.filter((card) => card.repo !== input.repo),
      ...drafts.map((draft) => {
        const id = stableCardId(draft, input.repo);
        return toCard(draft, scope, previousById.get(id));
      }),
    ];
    const currentIds = new Set(cards.map((card) => card.id));
    for (const old of previous) {
      if (old.repo === input.repo && !currentIds.has(old.id) && old.status !== "rejected") {
        cards.push({ ...old, status: "stale", updatedAt: isoNow() });
      }
    }
    await this.repository.writeBuild(evidence, cards);
    await this.index.rebuild(cards);
    return { repo: input.repo, revision, evidenceCount: evidence.length, knowledgeCount: cards.length, extractor: extractors, warnings };
  }

  async query(raw: ContextRequest): Promise<ContextPack> {
    const request = ContextRequestSchema.parse(raw);
    const retrievalQuery = [request.task, ...request.changedFiles, ...request.targetSymbols].filter(Boolean).join(" ");
    const hits = await this.index.search(retrievalQuery, {
      repo: request.repo,
      ...(request.revision ? { revision: request.revision } : {}),
      changedFiles: request.changedFiles,
      targetSymbols: request.targetSymbols,
      includeCandidates: request.includeCandidates,
      limit: request.limit,
    });
    const cards = await this.repository.readKnowledge();
    const evidence = await this.repository.readEvidence();
    const byId = new Map(cards.map((card) => [card.id, card]));
    const selected = hits.map((hit) => byId.get(hit.id)).filter((card): card is KnowledgeCard => Boolean(card));
    const evidenceIds = new Set(selected.flatMap((card) => card.evidenceIds));
    const selectedEvidence = evidence.filter((item) => evidenceIds.has(item.id));
    const retrieval = hits.map((hit) => ({ id: hit.id, channels: hit.channels, matchedFields: hit.matchedFields, score: hit.score }));
    const knowledge = selected.filter((card) => card.status === "verified" || (request.includeCandidates && card.status === "candidate"));
    const usableHits = retrieval.filter((hit) => knowledge.some((card) => card.id === hit.id));
    const mode = knowledge.length > 0 ? "evidence_augmented" : "ordinary_agent";
    return {
      mode,
      reason: mode === "ordinary_agent" ? (request.includeCandidates ? "no_matching_knowledge" : "no_applicable_verified_knowledge") : null,
      request,
      knowledge,
      evidence: selectedEvidence,
      suggestedCommands: selectedEvidence.filter((item) => item.sourceType === "test_code").map((item) => ["pytest", item.path]),
      retrieval: usableHits,
    };
  }

  async review(id: string, raw: ReviewRequest): Promise<KnowledgeCard> {
    const request = ReviewRequestSchema.parse(raw);
    const cards = await this.repository.readKnowledge();
    const current = cards.find((card) => card.id === id);
    if (!current) throw new Error(`Unknown knowledge card: ${id}`);
    const next = { ...current, status: request.status, updatedAt: isoNow() };
    await this.repository.writeBuild(await this.repository.readEvidence(), cards.map((card) => card.id === id ? next : card));
    await this.repository.appendReview({ knowledgeId: id, ...request, createdAt: isoNow() });
    await this.index.rebuild(cards.map((card) => card.id === id ? next : card));
    return next;
  }

  async listKnowledge(): Promise<KnowledgeCard[]> {
    return this.repository.readKnowledge();
  }

  async getKnowledge(id: string): Promise<KnowledgeCard> {
    const card = (await this.repository.readKnowledge()).find((item) => item.id === id);
    if (!card) throw new Error(`Unknown knowledge card: ${id}`);
    return card;
  }

  async getEvidence(id: string): Promise<Evidence> {
    const evidence = (await this.repository.readEvidence()).find((item) => item.id === id);
    if (!evidence) throw new Error(`Unknown evidence: ${id}`);
    return evidence;
  }

  async exportMemory(): Promise<string> {
    const cards = (await this.repository.readKnowledge()).filter((card) => card.status === "verified");
    return cards.map((card) => `## ${card.title}\n\n- 适用：${card.trigger}\n- 规则：${card.statement}\n- 预期：${card.expectedBehavior}\n- 断言：${card.oracle}\n- 来源：${card.evidenceIds.join(", ")}\n`).join("\n");
  }

  static async readFiles(repo: string, files: SourceSpec[]): Promise<SourceFile[]> {
    return Promise.all(files.map(async (file) => ({ ...file, text: await readFile(`${repo}/${file.path}`, "utf8") })));
  }
}
