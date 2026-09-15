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

export type StructuralContext = {
  relatedPaths: string[];
  targetSymbols: string[];
  source: "codegraph";
  warnings: string[];
};

export interface StructuralContextProvider {
  analyze(request: ContextRequest): Promise<StructuralContext>;
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
