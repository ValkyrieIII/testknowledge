import type {
  Evidence,
  EvidenceCluster,
  EvidenceType,
  KnowledgeCard,
  KnowledgeChange,
  KnowledgeKind,
  KnowledgeStatus,
  KnowledgeRelation,
  TestTechnique,
  Applicability,
  ScanSummary,
  ContextRequest,
  EvaluationPlan,
  EvaluationObservation,
  ExecutionRun,
  RunItem,
  ProjectMap,
  ObservedFacts,
} from "@testknowledge/model";

export type SourceFile = {
  path: string;
  type: EvidenceType;
  text: string;
};

export type SourceSpec = Omit<SourceFile, "text">;

export type ProjectScan = { files: SourceSpec[]; summary: ScanSummary };
export type { ScanSummary } from "@testknowledge/model";

export interface ProjectScanner {
  scan(repo: string): Promise<ProjectScan>;
}

export type ProjectScope = {
  repo: string;
  revision: string;
};

export type KnowledgeDraft = {
  kind: KnowledgeKind;
  title: string;
  statement: string;
  trigger: string;
  expectedBehavior: string;
  oracle: string;
  risk: string;
  path: string;
  symbol: string;
  targetSymbols?: string[];
  partitions?: string[];
  preconditions?: string[];
  dependencies?: string[];
  techniques?: TestTechnique[];
  applicability?: Applicability;
  evidenceIds: string[];
  observed?: ObservedFacts;
  confidence: number;
  clusterId?: string;
  clusterEvidenceIds?: string[];
  clusterSubject?: string;
  clusterShape?: string;
};

export type EvidenceClusterDraft = Pick<EvidenceCluster, "subject" | "shape" | "evidenceIds" | "confidence" | "extractor">;
export type CandidateExtractionResult = KnowledgeDraft[] | { drafts: KnowledgeDraft[]; clusters: EvidenceClusterDraft[] };

export type ReviewRecord = {
  knowledgeId: string;
  status: Extract<KnowledgeStatus, "reviewed" | "verified" | "rejected">;
  reviewer: string;
  note: string;
  createdAt: string;
};

export type ClusterReviewRecord = {
  clusterId: string;
  status: "reviewed" | "rejected";
  reviewer: string;
  note: string;
  createdAt: string;
};

export interface SourceAdapter {
  readonly id: string;
  prepare?(repo: string): Promise<void>;
  supports(file: SourceFile): boolean;
  collect(file: SourceFile, scope: ProjectScope): Promise<Evidence[]>;
}

export interface ProjectEvidenceProvider {
  readonly id: string;
  collect(scope: ProjectScope): Promise<Evidence[]>;
}

export interface CandidateExtractor {
  readonly id: string;
  extract(evidence: Evidence[], scope: ProjectScope): Promise<CandidateExtractionResult>;
}

/** One unit of extraction work: a bounded slice of evidence plus the budget it may spend. */
export type ExtractionShard = {
  id: string;
  kind: KnowledgeKind;
  subject: string;
  evidenceIds: string[];
  maxOutputTokens: number;
  estimatedInputTokens: number;
};

/**
 * An extractor that can be driven one shard at a time. Sharded extractors receive only the
 * evidence in the shard and a kind-specific instruction set, so one oversized prompt can no
 * longer crowd out the rest of the repository.
 */
export interface ShardedCandidateExtractor extends CandidateExtractor {
  extractShard(shard: ExtractionShard, evidence: Evidence[], scope: ProjectScope, signal?: AbortSignal): Promise<CandidateExtractionResult>;
}

export type StructuralContext = {
  relatedPaths: string[];
  targetSymbols: string[];
  source: "codegraph";
  warnings: string[];
};

export interface StructuralContextProvider {
  analyze(request: ContextRequest): Promise<StructuralContext>;
}

/** A repository read the model asked for. */
export type ToolRead = {
  tool: "read" | "glob" | "grep" | "list_dir";
  target: string;
  options?: { limit?: number; pattern?: string };
};

/** One captured read, recorded so a model-directed build stays reproducible. */
export type ReadLogEntry = {
  tool: ToolRead["tool"];
  target: string;
  contentHash: string;
  evidenceId: string;
};

/**
 * Turns a tool request into evidence.
 *
 * `ProjectEvidenceProvider` takes no input channel, so a tool result had nowhere to go. This
 * port is that channel: every read returns Evidence records, which is what lets a model-chosen
 * read still be cited and verified like any other fact.
 */
export interface EvidenceToolRuntime {
  readonly id: string;
  read(tool: ToolRead, scope: ProjectScope): Promise<Evidence[]>;
}

export type AgenticMessage = { role: string; content: string };
export type AgenticStepResult = { toolCalls?: ToolRead[]; content?: string };

/**
 * A finished tool-using run, cached so a re-run can restore the reads as well as the answer.
 *
 * Caching only the answer would be a trap: the read log feeds the build revision, so a replay
 * with no reads would land on a different revision than the run it came from.
 */
export type CachedAgenticRun = {
  content: string;
  readLog: ReadLogEntry[];
  evidence: Evidence[];
};

/**
 * A sharded extractor that can also use repository tools.
 *
 * The engine owns the loop and the read log, so a model-directed build stays auditable; the
 * extractor only renders the opening prompt, takes one step, and parses the final answer.
 */
export interface AgenticShardExtractor extends ShardedCandidateExtractor {
  beginShard(shard: ExtractionShard, evidence: Evidence[]): AgenticMessage[];
  step(messages: AgenticMessage[]): Promise<AgenticStepResult>;
  finishShard(shard: ExtractionShard, evidence: Evidence[], content: string): CandidateExtractionResult;
  /** Replays a cached run for this shard, including what it read. */
  loadRun?(shard: ExtractionShard, evidence: Evidence[]): Promise<CachedAgenticRun | undefined>;
  saveRun?(shard: ExtractionShard, evidence: Evidence[], run: CachedAgenticRun): Promise<void>;
}

export function isAgenticShardExtractor(extractor: CandidateExtractor): extractor is AgenticShardExtractor {
  const candidate = extractor as Partial<AgenticShardExtractor>;
  return typeof candidate.beginShard === "function" && typeof candidate.step === "function" && typeof candidate.finishShard === "function";
}

export interface KnowledgeRepository {
  readEvidence(): Promise<Evidence[]>;
  readKnowledge(): Promise<KnowledgeCard[]>;
  readClusters?(): Promise<EvidenceCluster[]>;
  readRelations?(): Promise<KnowledgeRelation[]>;
  readKnowledgeChanges?(): Promise<KnowledgeChange[]>;
  writeBuild(evidence: Evidence[], cards: KnowledgeCard[], relations?: KnowledgeRelation[], clusters?: EvidenceCluster[]): Promise<void>;
  appendReview(record: ReviewRecord): Promise<void>;
  appendClusterReview?(record: ClusterReviewRecord): Promise<void>;
  appendKnowledgeChanges?(records: KnowledgeChange[]): Promise<void>;
  readEvaluationPlans?(): Promise<EvaluationPlan[]>;
  writeEvaluationPlans?(plans: EvaluationPlan[]): Promise<void>;
  readEvaluationObservations?(): Promise<EvaluationObservation[]>;
  appendEvaluationObservation?(observation: EvaluationObservation): Promise<void>;
  readRuns?(): Promise<ExecutionRun[]>;
  appendRun?(record: ExecutionRun): Promise<void>;
  readRunItems?(runId?: string): Promise<RunItem[]>;
  appendRunItems?(records: RunItem[]): Promise<void>;
  readProjectMaps?(): Promise<ProjectMap[]>;
  writeProjectMaps?(maps: ProjectMap[]): Promise<void>;
}

export type RetrievalHit = {
  id: string;
  channels: Array<"exact" | "bm25f" | "dense">;
  matchedFields: string[];
  score: number;
};

export interface SearchIndex {
  rebuild(cards: KnowledgeCard[]): Promise<void>;
  search(query: string, options: {
    repo: string;
    revision?: string;
    changedFiles: string[];
    targetSymbols: string[];
    includeCandidates: boolean;
    limit: number;
  }): Promise<RetrievalHit[]>;
}
