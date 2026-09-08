import type {
  Evidence,
  EvidenceType,
  KnowledgeCard,
  KnowledgeKind,
  KnowledgeStatus,
} from "@testknowledge/model";

export type SourceFile = {
  path: string;
  type: EvidenceType;
  text: string;
};

export type SourceSpec = Omit<SourceFile, "text">;

export type ProjectScope = {
  repo: string;
  revision: string;
};

export type ObservedFacts = {
  assertions: string[];
  expectedExceptions: string[];
  mocks: string[];
  dependencies: string[];
  parametrize: string[];
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
  evidenceIds: string[];
  observed?: ObservedFacts;
  confidence: number;
};

export type ReviewRecord = {
  knowledgeId: string;
  status: Extract<KnowledgeStatus, "verified" | "rejected">;
  reviewer: string;
  note: string;
  createdAt: string;
};

export interface SourceAdapter {
  readonly id: string;
  supports(file: SourceFile): boolean;
  collect(file: SourceFile, scope: ProjectScope): Promise<Evidence[]>;
}

export interface CandidateExtractor {
  readonly id: string;
  extract(evidence: Evidence[], scope: ProjectScope): Promise<KnowledgeDraft[]>;
}

export interface KnowledgeRepository {
  readEvidence(): Promise<Evidence[]>;
  readKnowledge(): Promise<KnowledgeCard[]>;
  writeBuild(evidence: Evidence[], cards: KnowledgeCard[]): Promise<void>;
  appendReview(record: ReviewRecord): Promise<void>;
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
