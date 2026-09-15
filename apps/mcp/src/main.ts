import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod/v3";
import {
  BuildRequestSchema,
  ConflictRequestSchema,
  ContextRequestSchema,
  CreateEvaluationPlanRequestSchema,
  CreateKnowledgeBatchRequestSchema,
  CreateKnowledgeRequestSchema,
  EvaluationRunSetIdSchema,
  FeedbackRequestSchema,
  MergeKnowledgeRequestSchema,
  RecordEvaluationObservationRequestSchema,
  ResolveConflictRequestSchema,
  ReviewRequestSchema,
  RollbackKnowledgeRequestSchema,
  VerificationRequestSchema,
} from "@testknowledge/model";
import {
  createDefaultEngine,
  MultiFrameworkProjectScanner,
} from "@testknowledge/adapters";

function result(value: unknown) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(value, null, 2) }],
    structuredContent: { result: value },
  };
}

const engine = createDefaultEngine();
const scanner = new MultiFrameworkProjectScanner();
const server = new McpServer(
  { name: "testknowledge", version: "0.1.0" },
  {
    instructions: "Call get_test_context first for test-design tasks. Treat candidate and stale cards as unverified; use evidence links and abstentions. build_test_knowledge performs static extraction only and never runs tests. Review and verification are separate: verify only with successful external execution evidence bound to the same repository. Human merges preserve all source evidence and restart at candidate; rollback also restarts at candidate. Evaluation tools freeze A/B/C conditions and import explicitly bound external execution evidence; they never execute tests. For v2 evaluation manifests, pass only each run's agentInput to the evaluated agent, keep scoring private to the evaluator, and preserve runSetId, runId, and runSpecHash when recording feedback and observations. Reports compare one run set at a time.",
  },
);
const readOnly = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false };
const writesLocal = { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false };
let writeQueue = Promise.resolve();

function serializeWrite<T>(operation: () => Promise<T>): Promise<T> {
  const current = writeQueue.then(operation, operation);
  writeQueue = current.then(() => undefined, () => undefined);
  return current;
}

server.registerTool("get_test_context", {
  title: "Get evidence-backed test context",
  description: "Compile task-specific test knowledge, evidence, impact, setup, oracles, history, and abstentions.",
  inputSchema: ContextRequestSchema,
  annotations: readOnly,
}, async (input) => result(await engine.query(input)));

server.registerTool("list_test_knowledge", {
  title: "List test knowledge",
  description: "List stored knowledge cards, optionally restricted to one repository.",
  inputSchema: z.object({ repo: z.string().optional() }),
  annotations: readOnly,
}, async ({ repo }) => result((await engine.listKnowledge()).filter((card) => !repo || card.repo === repo)));

server.registerTool("list_test_project_maps", {
  title: "List persisted test project maps",
  description: "Read repository structure, discovered tests, fixtures, configuration, environment files, and evidence-backed run instructions.",
  inputSchema: z.object({ repo: z.string().optional() }),
  annotations: readOnly,
}, async ({ repo }) => result(await engine.listProjectMaps(repo)));

server.registerTool("get_test_knowledge", {
  title: "Get one test knowledge card",
  inputSchema: z.object({ id: z.string().min(1) }),
  annotations: readOnly,
}, async ({ id }) => result(await engine.getKnowledge(id)));

server.registerTool("get_test_evidence", {
  title: "Get one evidence record",
  inputSchema: z.object({ id: z.string().min(1) }),
  annotations: readOnly,
}, async ({ id }) => result(await engine.getEvidence(id)));

server.registerTool("list_test_relations", {
  title: "List typed test-knowledge relations",
  inputSchema: z.object({ repo: z.string().optional() }),
  annotations: readOnly,
}, async ({ repo }) => result((await engine.listRelations()).filter((relation) => !repo || relation.repo === repo)));

server.registerTool("list_test_evidence_clusters", {
  title: "List proposed evidence clusters",
  description: "Inspect independently reviewable evidence-group proposals and their shared deterministic signals.",
  inputSchema: z.object({ repo: z.string().optional() }),
  annotations: readOnly,
}, async ({ repo }) => result(await engine.listClusters(repo)));

server.registerTool("list_extraction_runs", {
  title: "List extraction run records",
  description: "Read the durable per-stage execution ledger: which pipeline stage ran, how it ended (done/failed/skipped), and what it counted. Pass runId for the item-level ledger of one run.",
  inputSchema: z.object({ repo: z.string().optional(), revision: z.string().optional(), runId: z.string().optional() }),
  annotations: readOnly,
}, async ({ repo, revision, runId }) => result(runId ? await engine.listRunItems(runId) : await engine.listExtractionRuns(repo, revision)));

server.registerTool("build_test_knowledge", {
  title: "Build test knowledge from a repository",
  description: "Statically scan sources and update local evidence, cards, relations, and indexes. Does not execute tests.",
  inputSchema: BuildRequestSchema,
  annotations: writesLocal,
}, async (input) => result(await serializeWrite(() => engine.buildFromRepository(input, scanner))));

server.registerTool("add_test_knowledge", {
  title: "Add an evidence-bound candidate card",
  inputSchema: CreateKnowledgeRequestSchema,
  annotations: writesLocal,
}, async (input) => result(await serializeWrite(() => engine.createKnowledge(input))));

server.registerTool("import_test_knowledge_pack", {
  title: "Import an evidence-bound candidate knowledge pack",
  description: "Validate the whole pack, then import up to 100 candidate cards in one repository update.",
  inputSchema: CreateKnowledgeBatchRequestSchema,
  annotations: writesLocal,
}, async (input) => result(await serializeWrite(() => engine.createKnowledgeBatch(input))));

server.registerTool("merge_test_knowledge", {
  title: "Merge knowledge cards into a new candidate",
  description: "Human-governed merge that preserves all source evidence and rejects superseded source cards.",
  inputSchema: MergeKnowledgeRequestSchema,
  annotations: writesLocal,
}, async (input) => result(await serializeWrite(() => engine.mergeKnowledge(input))));

server.registerTool("list_test_knowledge_history", {
  title: "List auditable knowledge changes",
  inputSchema: z.object({ knowledgeId: z.string().optional() }),
  annotations: readOnly,
}, async ({ knowledgeId }) => result(await engine.listKnowledgeChanges(knowledgeId)));

server.registerTool("rollback_test_knowledge", {
  title: "Rollback a knowledge change",
  description: "Restore the whole audited operation with current evidence, resetting restored cards to candidate.",
  inputSchema: z.object({ id: z.string().min(1), rollback: RollbackKnowledgeRequestSchema }),
  annotations: writesLocal,
}, async ({ id, rollback }) => result(await serializeWrite(() => engine.rollbackKnowledge(id, rollback))));

server.registerTool("create_test_knowledge_evaluation", {
  title: "Freeze an A/B/C evaluation plan",
  description: "Freeze repository revision, model, prompt, tools, budgets, tasks, and acceptance thresholds. Does not execute tests.",
  inputSchema: CreateEvaluationPlanRequestSchema,
  annotations: writesLocal,
}, async (input) => result(await serializeWrite(() => engine.createEvaluationPlan(input))));

server.registerTool("list_test_knowledge_evaluations", {
  title: "List frozen A/B/C evaluation plans",
  inputSchema: z.object({}),
  annotations: readOnly,
}, async () => result(await engine.listEvaluationPlans()));

server.registerTool("get_test_knowledge_evaluation_manifest", {
  title: "Create an integrity-bound A/B/C run manifest",
  description: "Expand one v2 frozen plan into task and variant run specifications without executing tests. Pass only agentInput to evaluated agents and keep scoring private to the evaluator.",
  inputSchema: z.object({ planId: z.string().min(1), runSetId: EvaluationRunSetIdSchema }),
  annotations: readOnly,
}, async ({ planId, runSetId }) => result(await engine.evaluationRunManifest(planId, runSetId)));

server.registerTool("record_test_knowledge_evaluation", {
  title: "Record one evidence-backed evaluation observation",
  description: "Import externally executed quality and cost observations that match a frozen plan.",
  inputSchema: RecordEvaluationObservationRequestSchema,
  annotations: writesLocal,
}, async (input) => result(await serializeWrite(() => engine.recordEvaluationObservation(input))));

server.registerTool("get_test_knowledge_evaluation_report", {
  title: "Compare A/B/C evaluation results",
  description: "Compare observations from exactly one run set. Specify runSetId when a plan has multiple recorded run sets.",
  inputSchema: z.object({ planId: z.string().min(1), runSetId: EvaluationRunSetIdSchema.optional() }),
  annotations: readOnly,
}, async ({ planId, runSetId }) => result(await engine.evaluationReport(planId, runSetId)));

server.registerTool("record_test_feedback", {
  title: "Record external test execution evidence",
  description: "Store externally produced execution evidence without running tests or promoting knowledge.",
  inputSchema: FeedbackRequestSchema,
  annotations: writesLocal,
}, async (input) => result(await serializeWrite(() => engine.recordFeedback(input))));

server.registerTool("review_test_knowledge", {
  title: "Review a candidate knowledge card",
  inputSchema: z.object({ id: z.string().min(1), review: ReviewRequestSchema }),
  annotations: writesLocal,
}, async ({ id, review }) => result(await serializeWrite(() => engine.review(id, review))));

server.registerTool("review_test_evidence_cluster", {
  title: "Review an evidence cluster proposal",
  description: "Accept or reject the grouping separately from reviewing its generated knowledge card.",
  inputSchema: z.object({ id: z.string().min(1), review: ReviewRequestSchema }),
  annotations: writesLocal,
}, async ({ id, review }) => result(await serializeWrite(() => engine.reviewCluster(id, review))));

server.registerTool("verify_test_knowledge", {
  title: "Verify knowledge with bound execution evidence",
  inputSchema: z.object({ id: z.string().min(1), verification: VerificationRequestSchema }),
  annotations: writesLocal,
}, async ({ id, verification }) => result(await serializeWrite(() => engine.verify(id, verification))));

server.registerTool("record_test_knowledge_conflict", {
  title: "Record a knowledge conflict",
  inputSchema: ConflictRequestSchema,
  annotations: writesLocal,
}, async (input) => result(await serializeWrite(() => engine.recordConflict(input))));

server.registerTool("resolve_test_knowledge_conflict", {
  title: "Resolve a knowledge conflict",
  inputSchema: z.object({ id: z.string().min(1), resolution: ResolveConflictRequestSchema }),
  annotations: writesLocal,
}, async ({ id, resolution }) => result(await serializeWrite(() => engine.resolveConflict(id, resolution))));

await server.connect(new StdioServerTransport());
