import { z } from "zod";

export const EvidenceTypeSchema = z.enum([
  "test_code",
  "production_code",
  "project_document",
  "test_configuration",
  "issue",
  "bug_history",
  "execution_result",
  "conversation",
]);

export const KnowledgeKindSchema = z.enum([
  "fixture",
  "mock",
  "boundary",
  "assertion",
  "behavior",
  "execution_recipe",
  "historical_bug",
  "environment",
]);

export const KnowledgeStatusSchema = z.enum([
  "candidate",
  "reviewed",
  "verified",
  "rejected",
  "stale",
]);

export const EvidenceClusterStatusSchema = z.enum(["candidate", "reviewed", "rejected", "stale"]);

export const TEST_TECHNIQUES = [
  "boundary_value",
  "equivalence_partition",
  "parameterized_input",
  "exception_path",
  "error_handling",
  "dependency_isolation",
  "fixture_injection",
  "round_trip",
  "state_transition",
  "ordering",
  "idempotence",
  "property_based",
  "snapshot_regression",
  "concurrency",
  "equivalence_assertion",
] as const;

export const TestTechniqueSchema = z.enum(TEST_TECHNIQUES);

export const RelationTypeSchema = z.enum([
  "COVERS", "VERIFIES", "VERIFIED_BY", "INVALIDATED_BY", "USES_FIXTURE", "REGRESSION_OF", "IMPACTS", "SUPPORTED_BY", "CONFLICTS_WITH", "MERGED_FROM",
]);

export const RelationNodeSchema = z.object({
  kind: z.enum(["knowledge", "evidence", "production_symbol"]),
  id: z.string().min(1),
});

export const KnowledgeRelationSchema = z.object({
  id: z.string().min(1),
  type: RelationTypeSchema,
  from: RelationNodeSchema,
  to: RelationNodeSchema,
  repo: z.string().min(1),
  revision: z.string().min(1),
  evidenceIds: z.array(z.string().min(1)),
  confidence: z.number().min(0).max(1),
  source: z.string().min(1),
  actor: z.string().optional(),
  note: z.string().optional(),
  resolution: z.enum(["keep_left", "keep_right", "reject_both", "dismiss"]).optional(),
  resolvedAt: z.string().datetime().optional(),
  createdAt: z.string().datetime(),
});

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
  extractedAt: z.string().datetime(),
  extractor: z.string().min(1),
  content: z.string(),
  confidence: z.number().min(0).max(1),
  payload: z.record(z.unknown()),
});

export const EvidenceClusterSchema = z.object({
  id: z.string().min(1),
  subject: z.string().min(1),
  shape: z.string().min(1),
  evidenceIds: z.array(z.string().min(1)).min(2),
  sharedSignals: z.array(z.string().min(1)).min(1),
  repo: z.string().min(1),
  revision: z.string().min(1),
  confidence: z.number().min(0).max(1),
  status: EvidenceClusterStatusSchema,
  extractor: z.string().min(1),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
});

export const ObservedFactsSchema = z.object({
  assertions: z.array(z.string()).default([]),
  expectedExceptions: z.array(z.string()).default([]),
  mocks: z.array(z.string()).default([]),
  factories: z.array(z.string()).default([]),
  dependencies: z.array(z.string()).default([]),
  parametrize: z.array(z.string()).default([]),
});

const EMPTY_OBSERVED = { assertions: [], expectedExceptions: [], mocks: [], factories: [], dependencies: [], parametrize: [] };

export const ApplicabilitySchema = z.object({
  languages: z.array(z.string()).default([]),
  frameworks: z.array(z.string()).default([]),
  paths: z.array(z.string()).default([]),
  symbols: z.array(z.string()).default([]),
  revision: z.string().optional(),
});

const EMPTY_APPLICABILITY = { languages: [], frameworks: [], paths: [], symbols: [] };

export const ProposalProvenanceSchema = z.object({
  source: z.enum(["deterministic_extractor", "llm_extractor", "human", "agent", "unknown"]),
  actor: z.string().min(1),
  note: z.string().min(1),
});

const UNKNOWN_PROPOSAL_PROVENANCE = { source: "unknown" as const, actor: "unknown", note: "Legacy or unspecified proposal provenance" };

export const KnowledgeCardSchema = z.object({
  id: z.string().min(1),
  origin: z.enum(["extracted", "manual"]).default("extracted"),
  proposalProvenance: ProposalProvenanceSchema.default(UNKNOWN_PROPOSAL_PROVENANCE),
  clusterId: z.string().min(1).optional(),
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
  targetSymbols: z.array(z.string()).default([]),
  partitions: z.array(z.string()).default([]),
  preconditions: z.array(z.string()).default([]),
  dependencies: z.array(z.string()).default([]),
  techniques: z.array(TestTechniqueSchema).default([]),
  applicability: ApplicabilitySchema.default(EMPTY_APPLICABILITY),
  validationEvidenceIds: z.array(z.string()).default([]),
  evidenceIds: z.array(z.string().min(1)).min(1),
  observed: ObservedFactsSchema.default(EMPTY_OBSERVED),
  confidence: z.number().min(0).max(1),
  status: KnowledgeStatusSchema,
  sourceHash: z.string().min(1),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
});

export const KnowledgeChangeSchema = z.object({
  id: z.string().min(1),
  operationId: z.string().min(1),
  knowledgeId: z.string().min(1),
  action: z.enum(["build", "create", "review", "verify", "merge", "rollback", "conflict_resolution", "cluster_rejection", "feedback_invalidation"]),
  actor: z.string().min(1),
  note: z.string().min(1),
  before: KnowledgeCardSchema.nullable(),
  after: KnowledgeCardSchema.nullable(),
  sourceKnowledgeIds: z.array(z.string().min(1)).default([]),
  createdAt: z.string().datetime(),
});

export const RunInstructionSchema = z.object({
  command: z.array(z.string()).optional(),
  commandText: z.string().optional(),
  sourceRef: z.string(),
  workingDirectory: z.string().optional(),
  confidence: z.number().min(0).max(1),
  verified: z.boolean(),
}).refine((item) => item.command !== undefined || item.commandText !== undefined, "command or commandText is required");

export const ExecutionDetailsSchema = z.object({
  durationMs: z.number().nonnegative().nullable().default(null),
  testCounts: z.object({
    total: z.number().int().nonnegative().nullable().default(null),
    passed: z.number().int().nonnegative().nullable().default(null),
    failed: z.number().int().nonnegative().nullable().default(null),
    skipped: z.number().int().nonnegative().nullable().default(null),
    errors: z.number().int().nonnegative().nullable().default(null),
  }).default({}),
  coverage: z.object({
    linesPercent: z.number().min(0).max(100).nullable().default(null),
    branchesPercent: z.number().min(0).max(100).nullable().default(null),
    coveredFiles: z.array(z.string()).default([]),
  }).nullable().default(null),
  mutation: z.object({
    scorePercent: z.number().min(0).max(100).nullable().default(null),
    killed: z.number().int().nonnegative().nullable().default(null),
    survived: z.number().int().nonnegative().nullable().default(null),
    timedOut: z.number().int().nonnegative().nullable().default(null),
    noCoverage: z.number().int().nonnegative().nullable().default(null),
  }).nullable().default(null),
  failures: z.array(z.object({
    testId: z.string().min(1),
    message: z.string().min(1),
    path: z.string().default(""),
    line: z.number().int().positive().nullable().default(null),
  })).max(100).default([]),
});

export const ExecutionSignalSchema = ExecutionDetailsSchema.extend({
  evidenceId: z.string().min(1),
  sourceRef: z.string().min(1),
  outcome: z.enum(["passed", "failed", "error"]),
  command: z.array(z.string()).min(1),
  observed: z.string().min(1),
});

export const ProjectMapSchema = z.object({
  id: z.string().min(1),
  repo: z.string().min(1),
  revision: z.string().min(1),
  languages: z.array(z.string()),
  frameworks: z.array(z.string()),
  productionFiles: z.array(z.string()),
  testFiles: z.array(z.string()),
  testDirectories: z.array(z.string()),
  configFiles: z.array(z.string()),
  environmentFiles: z.array(z.string()),
  productionSymbols: z.array(z.string()),
  testSymbols: z.array(z.string()),
  fixtureSymbols: z.array(z.string()),
  setupSymbols: z.array(z.string()).default([]),
  runInstructions: z.array(RunInstructionSchema),
  warnings: z.array(z.string()),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
});

export const ContextRequestSchema = z.object({
  repo: z.string().min(1),
  revision: z.string().optional(),
  languages: z.array(z.string()).default([]),
  frameworks: z.array(z.string()).default([]),
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
  projectMap: ProjectMapSchema.nullable(),
  knowledge: z.array(KnowledgeCardSchema),
  evidence: z.array(EvidenceSchema),
  evidenceClusters: z.array(EvidenceClusterSchema),
  relations: z.array(KnowledgeRelationSchema),
  impactSummary: z.object({
    changedFiles: z.array(z.string()),
    targetSymbols: z.array(z.string()),
    targetSymbolSource: z.enum(["request", "codegraph", "unavailable"]),
    relatedPaths: z.array(z.string()),
    source: z.enum(["codegraph", "request_and_retrieval", "unavailable"]),
  }),
  existingTests: z.array(z.object({
    path: z.string(),
    symbol: z.string(),
    sourceRef: z.string(),
    evidenceId: z.string(),
  })),
  testDesignKnowledge: z.array(KnowledgeCardSchema),
  fixturesAndMocks: z.object({
    fixtures: z.array(z.string()),
    factories: z.array(z.string()),
    mocks: z.array(z.string()),
  }),
  oracles: z.array(z.object({
    knowledgeId: z.string(),
    oracle: z.string(),
    evidenceIds: z.array(z.string()),
  })),
  historicalRegressions: z.array(KnowledgeCardSchema),
  historicalRegressionEvidence: z.array(EvidenceSchema),
  environmentProfiles: z.array(z.object({
    sourceRef: z.string(),
    runCommands: z.array(z.string()),
    workingDirectories: z.array(z.string()),
    environmentVariableNames: z.array(z.string()),
    serviceImages: z.array(z.string()),
  })),
  executionSignals: z.array(ExecutionSignalSchema),
  runInstructions: z.array(RunInstructionSchema),
  evidenceAndConfidence: z.array(z.object({
    knowledgeId: z.string(),
    evidenceIds: z.array(z.string()),
    confidence: z.number().min(0).max(1),
    status: KnowledgeStatusSchema,
  })),
  abstentions: z.array(z.string()),
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
  status: z.enum(["reviewed", "rejected"]),
  reviewer: z.string().min(1),
  note: z.string().min(1),
});

export const CreateKnowledgeRequestSchema = z.object({
  repo: z.string().min(1),
  revision: z.string().min(1),
  kind: KnowledgeKindSchema,
  title: z.string().min(1),
  statement: z.string().min(1),
  trigger: z.string().min(1),
  expectedBehavior: z.string().min(1),
  oracle: z.string().min(1),
  risk: z.string().default(""),
  path: z.string().min(1),
  symbol: z.string().default(""),
  targetSymbols: z.array(z.string()).default([]),
  partitions: z.array(z.string()).default([]),
  preconditions: z.array(z.string()).default([]),
  dependencies: z.array(z.string()).default([]),
  techniques: z.array(TestTechniqueSchema).default([]),
  applicability: ApplicabilitySchema.default(EMPTY_APPLICABILITY),
  evidenceIds: z.array(z.string().min(1)).min(1),
  observed: ObservedFactsSchema.default(EMPTY_OBSERVED),
  confidence: z.number().min(0).max(1),
  proposalProvenance: ProposalProvenanceSchema.default(UNKNOWN_PROPOSAL_PROVENANCE),
});

export const CreateKnowledgeBatchRequestSchema = z.object({
  repo: z.string().min(1),
  revision: z.string().min(1),
  cards: z.array(CreateKnowledgeRequestSchema.omit({ repo: true, revision: true, proposalProvenance: true })).min(1).max(100),
  proposalProvenance: ProposalProvenanceSchema.default(UNKNOWN_PROPOSAL_PROVENANCE),
  reviewer: z.string().min(1),
  note: z.string().min(1),
});

export const MergeKnowledgeRequestSchema = z.object({
  sourceKnowledgeIds: z.array(z.string().min(1)).min(2),
  merged: CreateKnowledgeRequestSchema,
  reviewer: z.string().min(1),
  note: z.string().min(1),
});

export const RollbackKnowledgeRequestSchema = z.object({
  changeId: z.string().min(1),
  reviewer: z.string().min(1),
  note: z.string().min(1),
});

export const EvaluationVariantSchema = z.enum(["A_ordinary_agent", "B_codegraph", "C_codegraph_testknowledge"]);
export const EvaluationRunSetIdSchema = z.string().trim().regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,99}$/u, "runSetId must be a portable identifier");

export const EvaluationVariantToolsSchema = z.object({
  A_ordinary_agent: z.array(z.string().min(1)),
  B_codegraph: z.array(z.string().min(1)),
  C_codegraph_testknowledge: z.array(z.string().min(1)),
});

export const EvaluationTaskSchema = z.object({
  id: z.string().min(1),
  prompt: z.string().min(1),
  targetSymbols: z.array(z.string()).default([]),
  changedFiles: z.array(z.string()).default([]),
  criticalBoundaryIds: z.array(z.string().min(1)).default([]),
  seededBugIds: z.array(z.string().min(1)).default([]),
  requiredOracleIds: z.array(z.string().min(1)).default([]),
  fixtureMockCriteria: z.array(z.string().min(1)).default([]),
  duplicateCriteria: z.array(z.string().min(1)).default([]),
  brittlenessCriteria: z.array(z.string().min(1)).default([]),
});

export const CreateEvaluationPlanRequestSchema = z.object({
  repo: z.string().min(1),
  revision: z.string().min(1),
  model: z.string().min(1),
  promptTemplate: z.string().min(1),
  tools: z.array(z.string().min(1)),
  variantTools: EvaluationVariantToolsSchema.optional(),
  budget: z.object({
    maxTokens: z.number().int().positive(),
    maxToolCalls: z.number().int().nonnegative(),
    maxDurationMs: z.number().int().positive(),
  }),
  tasks: z.array(EvaluationTaskSchema).min(1),
  acceptance: z.object({
    minimumCompleteTasks: z.number().int().positive().default(3),
    minimumTaskWinRate: z.number().min(0).max(1).default(0.67),
    maximumTaskLossRate: z.number().min(0).max(1).default(0),
    maximumTokenIncreaseRatio: z.number().nonnegative().default(0.5),
    maximumToolCallIncreaseRatio: z.number().nonnegative().default(0.5),
    maximumDurationIncreaseRatio: z.number().nonnegative().default(0.5),
  }).default({}),
});

export const EvaluationPlanSchema = CreateEvaluationPlanRequestSchema.extend({
  id: z.string().min(1),
  promptHash: z.string().min(1),
  toolPolicyHash: z.string().min(1),
  protocolVersion: z.enum(["evaluation.v1", "evaluation.v2"]).default("evaluation.v1"),
  status: z.literal("frozen"),
  createdAt: z.string().datetime(),
});

export const RecordEvaluationObservationRequestSchema = z.object({
  planId: z.string().min(1),
  runSetId: EvaluationRunSetIdSchema,
  taskId: z.string().min(1),
  variant: EvaluationVariantSchema,
  runId: z.string().min(1),
  model: z.string().min(1),
  promptHash: z.string().min(1),
  toolPolicyHash: z.string().min(1),
  runSpecHash: z.string().min(1),
  usedTools: z.array(z.string().min(1)),
  executionPassed: z.boolean(),
  coveredBoundaryIds: z.array(z.string().min(1)).default([]),
  detectedSeededBugIds: z.array(z.string().min(1)).default([]),
  effectiveOracleIds: z.array(z.string().min(1)).default([]),
  fixtureMockCorrect: z.boolean().nullable().default(null),
  invalidAssertionCount: z.number().int().nonnegative().default(0),
  duplicateTestCount: z.number().int().nonnegative(),
  brittleTestCount: z.number().int().nonnegative(),
  tokenUsage: z.number().int().nonnegative(),
  toolCalls: z.number().int().nonnegative(),
  durationMs: z.number().int().nonnegative(),
  evidenceIds: z.array(z.string().min(1)).min(1),
  recordedBy: z.string().min(1),
  note: z.string().default(""),
});

export const EvaluationObservationSchema = RecordEvaluationObservationRequestSchema.extend({
  id: z.string().min(1),
  recordedAt: z.string().datetime(),
});

export const ConflictRequestSchema = z.object({
  leftKnowledgeId: z.string().min(1),
  rightKnowledgeId: z.string().min(1),
  evidenceIds: z.array(z.string().min(1)).default([]),
  reviewer: z.string().min(1),
  note: z.string().min(1),
});

export const ResolveConflictRequestSchema = z.object({
  resolution: z.enum(["keep_left", "keep_right", "reject_both", "dismiss"]),
  reviewer: z.string().min(1),
  note: z.string().min(1),
});

export const FeedbackRequestSchema = z.object({
  repo: z.string().min(1),
  revision: z.string().min(1),
  knowledgeId: z.string().min(1).optional(),
  sourceRef: z.string().min(1),
  command: z.array(z.string()).min(1),
  outcome: z.enum(["passed", "failed", "error"]),
  observed: z.string().min(1),
  confidence: z.number().min(0).max(1).default(1),
  execution: ExecutionDetailsSchema.optional(),
  evaluation: z.object({
    planId: z.string().min(1),
    runSetId: EvaluationRunSetIdSchema,
    taskId: z.string().min(1),
    variant: EvaluationVariantSchema,
    runId: z.string().min(1),
    runSpecHash: z.string().min(1),
    model: z.string().min(1),
    promptHash: z.string().min(1),
    toolPolicyHash: z.string().min(1),
    usedTools: z.array(z.string().min(1)),
    tokenUsage: z.number().int().nonnegative(),
    toolCalls: z.number().int().nonnegative(),
    durationMs: z.number().int().nonnegative(),
    duplicateTestCount: z.number().int().nonnegative(),
    brittleTestCount: z.number().int().nonnegative(),
  }).optional(),
  oracleAssessment: z.object({
    verdict: z.enum(["supported", "contradicted", "inconclusive"]),
    assessor: z.string().min(1),
    note: z.string().min(1),
  }).optional(),
}).superRefine((item, context) => {
  const verdict = item.oracleAssessment?.verdict;
  if (!verdict || verdict === "inconclusive") return;
  if (!item.knowledgeId) {
    context.addIssue({ code: "custom", path: ["knowledgeId"], message: "knowledgeId is required for an Oracle assessment" });
  }
  if (verdict === "supported" && item.outcome !== "passed") {
    context.addIssue({ code: "custom", path: ["outcome"], message: "A supported Oracle assessment requires a passed outcome" });
  }
  if (verdict === "contradicted" && item.outcome !== "failed") {
    context.addIssue({ code: "custom", path: ["outcome"], message: "A contradicted Oracle assessment requires a failed outcome" });
  }
});

export const VerificationRequestSchema = z.object({
  evidenceId: z.string().min(1),
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
  additionalFiles: z.array(
    z.object({
      path: z.string().min(1),
      type: EvidenceTypeSchema,
    }),
  ).default([]),
  useLlm: z.boolean().default(false),
});

export type ScanSummary = {
  mode: "auto" | "explicit";
  fileCount: number;
  testDirectories: string[];
  configFiles: string[];
  environmentFiles: string[];
  detectedLanguages?: string[];
  detectedFrameworks?: string[];
  warnings: string[];
};

export type BuildResult = {
  repo: string;
  revision: string;
  evidenceCount: number;
  knowledgeCount: number;
  relationCount: number;
  clusterCount: number;
  extractor: string[];
  warnings: string[];
  scan?: ScanSummary;
  projectMap?: ProjectMap;
};

export type Evidence = z.infer<typeof EvidenceSchema>;
export type EvidenceCluster = z.infer<typeof EvidenceClusterSchema>;
export type ObservedFacts = z.infer<typeof ObservedFactsSchema>;
export type Applicability = z.infer<typeof ApplicabilitySchema>;
export type KnowledgeCard = z.infer<typeof KnowledgeCardSchema>;
export type KnowledgeChange = z.infer<typeof KnowledgeChangeSchema>;
export type ProjectMap = z.infer<typeof ProjectMapSchema>;
export type ContextRequest = z.infer<typeof ContextRequestSchema>;
export type ContextPack = z.infer<typeof ContextPackSchema>;
export type ReviewRequest = z.infer<typeof ReviewRequestSchema>;
export type CreateKnowledgeRequest = z.infer<typeof CreateKnowledgeRequestSchema>;
export type CreateKnowledgeBatchRequest = z.infer<typeof CreateKnowledgeBatchRequestSchema>;
export type MergeKnowledgeRequest = z.infer<typeof MergeKnowledgeRequestSchema>;
export type RollbackKnowledgeRequest = z.infer<typeof RollbackKnowledgeRequestSchema>;
export type EvaluationVariant = z.infer<typeof EvaluationVariantSchema>;
export type EvaluationTask = z.infer<typeof EvaluationTaskSchema>;
export type CreateEvaluationPlanRequest = z.infer<typeof CreateEvaluationPlanRequestSchema>;
export type EvaluationPlan = z.infer<typeof EvaluationPlanSchema>;
export type RecordEvaluationObservationRequest = z.infer<typeof RecordEvaluationObservationRequestSchema>;
export type EvaluationObservation = z.infer<typeof EvaluationObservationSchema>;
export type EvaluationRunManifest = {
  protocolVersion: "evaluation.v2";
  planId: string;
  runSetId: string;
  repo: string;
  revision: string;
  promptHash: string;
  toolPolicyHash: string;
  runs: Array<{
    planId: string;
    runSetId: string;
    taskId: string;
    variant: EvaluationVariant;
    runId: string;
    runSpecHash: string;
    agentInput: {
      model: string;
      prompt: string;
      tools: string[];
      budget: EvaluationPlan["budget"];
      targetSymbols: string[];
      changedFiles: string[];
    };
    scoring: Pick<EvaluationTask, "criticalBoundaryIds" | "seededBugIds" | "requiredOracleIds" | "fixtureMockCriteria" | "duplicateCriteria" | "brittlenessCriteria">;
  }>;
};
export type EvaluationVariantSummary = {
  taskCount: number;
  executionPassRate: number;
  boundaryCoverageRate: number;
  seededBugDetectionRate: number;
  effectiveOracleRate: number;
  fixtureMockCorrectRate: number | null;
  invalidAssertionCount: number;
  duplicateTestCount: number;
  brittleTestCount: number;
  averageTokens: number;
  averageToolCalls: number;
  averageDurationMs: number;
};
export type EvaluationReport = {
  planId: string;
  runSetId: string | null;
  availableRunSetIds: string[];
  completeTaskCount: number;
  taskWins: number;
  taskLosses: number;
  taskTies: number;
  variants: Record<EvaluationVariant, EvaluationVariantSummary>;
  deltaCvsB: {
    boundaryCoverageRate: number;
    seededBugDetectionRate: number;
    effectiveOracleRate: number;
    fixtureMockCorrectRate: number | null;
    executionPassRate: number;
    invalidAssertionCount: number;
    duplicateTestCount: number;
    brittleTestCount: number;
    tokenIncreaseRatio: number;
    toolCallIncreaseRatio: number;
    durationIncreaseRatio: number;
  };
  verdict: "improved" | "not_demonstrated" | "insufficient_data";
  reasons: string[];
};
export type ConflictRequest = z.infer<typeof ConflictRequestSchema>;
export type ResolveConflictRequest = z.infer<typeof ResolveConflictRequestSchema>;
export type FeedbackRequest = z.infer<typeof FeedbackRequestSchema>;
export type ExecutionDetails = z.infer<typeof ExecutionDetailsSchema>;
export type ExecutionSignal = z.infer<typeof ExecutionSignalSchema>;
export type VerificationRequest = z.infer<typeof VerificationRequestSchema>;
export type BuildRequest = z.infer<typeof BuildRequestSchema>;
export type EvidenceType = z.infer<typeof EvidenceTypeSchema>;
export type KnowledgeKind = z.infer<typeof KnowledgeKindSchema>;
export type KnowledgeStatus = z.infer<typeof KnowledgeStatusSchema>;
export type EvidenceClusterStatus = z.infer<typeof EvidenceClusterStatusSchema>;
export type TestTechnique = z.infer<typeof TestTechniqueSchema>;
export type RelationType = z.infer<typeof RelationTypeSchema>;
export type RelationNode = z.infer<typeof RelationNodeSchema>;
export type KnowledgeRelation = z.infer<typeof KnowledgeRelationSchema>;
