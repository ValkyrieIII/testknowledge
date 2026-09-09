import { z } from "zod";

export const EvidenceTypeSchema = z.enum([
  "test_code",
  "production_code",
  "project_document",
  "test_configuration",
  "bug_history",
]);

export const KnowledgeKindSchema = z.enum([
  "fixture",
  "mock",
  "boundary",
  "assertion",
  "behavior",
  "execution_recipe",
  "historical_bug",
]);

export const KnowledgeStatusSchema = z.enum([
  "candidate",
  "verified",
  "rejected",
  "stale",
]);

export const EvidenceSchema = z.object({
  id: z.string().min(1),
  sourceType: EvidenceTypeSchema,
  sourceRef: z.string().min(1),
  repo: z.string().min(1),
  revision: z.string().min(1),
  path: z.string().min(1),
  symbol: z.string().default(""),
  lineStart: z.number().int().positive(),
  lineEnd: z.number().int().positive(),
  contentHash: z.string().min(1),
  payload: z.record(z.unknown()),
});

export const ObservedFactsSchema = z.object({
  assertions: z.array(z.string()).default([]),
  expectedExceptions: z.array(z.string()).default([]),
  mocks: z.array(z.string()).default([]),
  dependencies: z.array(z.string()).default([]),
  parametrize: z.array(z.string()).default([]),
});

const EMPTY_OBSERVED = { assertions: [], expectedExceptions: [], mocks: [], dependencies: [], parametrize: [] };

export const KnowledgeCardSchema = z.object({
  id: z.string().min(1),
  kind: KnowledgeKindSchema,
  title: z.string().min(1),
  statement: z.string().min(1),
  trigger: z.string().min(1),
  expectedBehavior: z.string().min(1),
  oracle: z.string().min(1),
  risk: z.string().default(""),
  repo: z.string().min(1),
  revision: z.string().min(1),
  path: z.string().min(1),
  symbol: z.string().default(""),
  evidenceIds: z.array(z.string().min(1)).min(1),
  observed: ObservedFactsSchema.default(EMPTY_OBSERVED),
  confidence: z.number().min(0).max(1),
  status: KnowledgeStatusSchema,
  sourceHash: z.string().min(1),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
});

export const ContextRequestSchema = z.object({
  repo: z.string().min(1),
  revision: z.string().optional(),
  task: z.string().min(1),
  changedFiles: z.array(z.string()).default([]),
  targetSymbols: z.array(z.string()).default([]),
  includeCandidates: z.boolean().default(false),
  limit: z.number().int().min(1).max(30).default(8),
});

export const ContextPackSchema = z.object({
  mode: z.enum(["evidence_augmented", "ordinary_agent"]),
  reason: z.string().nullable(),
  request: ContextRequestSchema,
  knowledge: z.array(KnowledgeCardSchema),
  evidence: z.array(EvidenceSchema),
  suggestedCommands: z.array(z.array(z.string())),
  retrieval: z.array(
    z.object({
      id: z.string(),
      channels: z.array(z.enum(["exact", "bm25f", "dense"])),
      matchedFields: z.array(z.string()),
      score: z.number(),
    }),
  ),
});

export const ReviewRequestSchema = z.object({
  status: z.enum(["verified", "rejected"]),
  reviewer: z.string().min(1),
  note: z.string().min(1),
});

export const BuildRequestSchema = z.object({
  repo: z.string().min(1),
  files: z.array(
    z.object({
      path: z.string().min(1),
      type: EvidenceTypeSchema,
    }),
  ).min(1).optional(),
  useLlm: z.boolean().default(false),
});

export type ScanSummary = {
  mode: "auto" | "explicit";
  fileCount: number;
  testDirectories: string[];
  configFiles: string[];
  warnings: string[];
};

export type BuildResult = {
  repo: string;
  revision: string;
  evidenceCount: number;
  knowledgeCount: number;
  extractor: string[];
  warnings: string[];
  scan?: ScanSummary;
};

export type Evidence = z.infer<typeof EvidenceSchema>;
export type ObservedFacts = z.infer<typeof ObservedFactsSchema>;
export type KnowledgeCard = z.infer<typeof KnowledgeCardSchema>;
export type ContextRequest = z.infer<typeof ContextRequestSchema>;
export type ContextPack = z.infer<typeof ContextPackSchema>;
export type ReviewRequest = z.infer<typeof ReviewRequestSchema>;
export type BuildRequest = z.infer<typeof BuildRequestSchema>;
export type EvidenceType = z.infer<typeof EvidenceTypeSchema>;
export type KnowledgeKind = z.infer<typeof KnowledgeKindSchema>;
export type KnowledgeStatus = z.infer<typeof KnowledgeStatusSchema>;
