import { Command } from "commander";
import { mkdir, readFile } from "node:fs/promises";
import { BuildRequestSchema, ConflictRequestSchema, ContextRequestSchema, CreateEvaluationPlanRequestSchema, CreateKnowledgeBatchRequestSchema, CreateKnowledgeRequestSchema, EvidenceTypeSchema, FeedbackRequestSchema, MergeKnowledgeRequestSchema, RecordEvaluationObservationRequestSchema, ResolveConflictRequestSchema, ReviewRequestSchema, RollbackKnowledgeRequestSchema, VerificationRequestSchema } from "@testknowledge/model";
import { KnowledgeEngine } from "@testknowledge/core";
import { createDefaultEngine, MultiFrameworkProjectScanner, resolveDataRoot, resolveInvocationPath } from "@testknowledge/adapters";

function engine(): KnowledgeEngine {
  return createDefaultEngine();
}

const program = new Command().name("testknowledge").description("Evidence-backed test knowledge engine");
const readJson = async (path: string): Promise<unknown> => JSON.parse(await readFile(resolveInvocationPath(path), "utf8"));
const resolveInputRepositoryPaths = (value: unknown): unknown => {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return value;
  const input = { ...(value as Record<string, unknown>) };
  if (typeof input.repo === "string") input.repo = resolveInvocationPath(input.repo);
  if (input.merged !== null && typeof input.merged === "object" && !Array.isArray(input.merged)) {
    const merged = { ...(input.merged as Record<string, unknown>) };
    if (typeof merged.repo === "string") merged.repo = resolveInvocationPath(merged.repo);
    input.merged = merged;
  }
  return input;
};
const parseSource = (value: string) => {
  const separator = value.indexOf(":");
  if (separator <= 0 || separator === value.length - 1) throw new Error(`Invalid source '${value}'; expected <type>:<repo-relative-path>`);
  return { type: EvidenceTypeSchema.parse(value.slice(0, separator)), path: value.slice(separator + 1) };
};
program.command("init").action(async () => {
  const dataRoot = resolveDataRoot(process.env.TESTKNOWLEDGE_DATA_ROOT);
  await mkdir(dataRoot, { recursive: true });
  console.log(JSON.stringify({ status: "ready", dataRoot }, null, 2));
});

program.command("build")
  .requiredOption("--repo <path>")
  .option("--file <path...>", "explicit source files; omit to scan supported test frameworks")
  .option("--source <source...>", "additional typed source as <type>:<repo-relative-path>")
  .option("--llm", "use configured semantic candidate extractor")
  .action(async (options: { repo: string; file?: string[]; source?: string[]; llm?: boolean }) => {
    const body = BuildRequestSchema.parse({ repo: resolveInvocationPath(options.repo), files: options.file?.map((path) => ({ path, type: path.includes("test") ? "test_code" : path.endsWith(".md") ? "project_document" : "production_code" })), additionalFiles: options.source?.map(parseSource), useLlm: Boolean(options.llm) });
    console.log(JSON.stringify(await engine().buildFromRepository(body, new MultiFrameworkProjectScanner()), null, 2));
  });

program.command("query")
  .requiredOption("--repo <path>")
  .requiredOption("--task <text>")
  .option("--revision <revision>")
  .option("--changed-file <path...>", "changed files")
  .option("--symbol <name...>", "target symbols")
  .option("--include-candidates")
  .option("--format <format>", "json")
  .action(async (options: { repo: string; task: string; revision?: string; changedFile?: string[]; symbol?: string[]; includeCandidates?: boolean; format: string }) => {
    const request = ContextRequestSchema.parse({ repo: resolveInvocationPath(options.repo), revision: options.revision, task: options.task, changedFiles: options.changedFile ?? [], targetSymbols: options.symbol ?? [], includeCandidates: Boolean(options.includeCandidates) });
    const result = await engine().query(request);
    console.log(options.format === "markdown" ? result.knowledge.map((card) => `## ${card.title}\n\n${card.statement}\n\n来源：${card.evidenceIds.join(", ")}`).join("\n\n") : JSON.stringify(result, null, 2));
  });

program.command("review")
  .argument("<id>")
  .requiredOption("--status <status>")
  .requiredOption("--reviewer <reviewer>")
  .requiredOption("--note <note>")
  .action(async (id: string, options: { status: string; reviewer: string; note: string }) => {
    console.log(JSON.stringify(await engine().review(id, ReviewRequestSchema.parse(options)), null, 2));
  });

program.command("list-clusters")
  .option("--repo <path>")
  .action(async (options: { repo?: string }) => {
    console.log(JSON.stringify(await engine().listClusters(options.repo ? resolveInvocationPath(options.repo) : undefined), null, 2));
  });

program.command("review-cluster")
  .argument("<id>")
  .requiredOption("--status <status>")
  .requiredOption("--reviewer <reviewer>")
  .requiredOption("--note <note>")
  .action(async (id: string, options: { status: string; reviewer: string; note: string }) => {
    console.log(JSON.stringify(await engine().reviewCluster(id, ReviewRequestSchema.parse(options)), null, 2));
  });

program.command("add-knowledge")
  .requiredOption("--input <json>", "evidence-bound knowledge card JSON")
  .action(async (options: { input: string }) => {
    console.log(JSON.stringify(await engine().createKnowledge(CreateKnowledgeRequestSchema.parse(resolveInputRepositoryPaths(await readJson(options.input)))), null, 2));
  });

program.command("import-knowledge")
  .requiredOption("--input <json>", "validated evidence-bound candidate knowledge pack JSON")
  .action(async (options: { input: string }) => {
    console.log(JSON.stringify(await engine().createKnowledgeBatch(CreateKnowledgeBatchRequestSchema.parse(resolveInputRepositoryPaths(await readJson(options.input)))), null, 2));
  });

program.command("merge-knowledge")
  .requiredOption("--input <json>", "merge decision and merged candidate JSON")
  .action(async (options: { input: string }) => {
    console.log(JSON.stringify(await engine().mergeKnowledge(MergeKnowledgeRequestSchema.parse(resolveInputRepositoryPaths(await readJson(options.input)))), null, 2));
  });

program.command("history")
  .option("--id <knowledge-id>")
  .action(async (options: { id?: string }) => {
    console.log(JSON.stringify(await engine().listKnowledgeChanges(options.id), null, 2));
  });

program.command("rollback")
  .argument("<id>")
  .requiredOption("--input <json>", "rollback decision JSON")
  .action(async (id: string, options: { input: string }) => {
    console.log(JSON.stringify(await engine().rollbackKnowledge(id, RollbackKnowledgeRequestSchema.parse(await readJson(options.input))), null, 2));
  });

program.command("create-evaluation")
  .requiredOption("--input <json>", "frozen A/B/C evaluation plan JSON")
  .action(async (options: { input: string }) => {
    console.log(JSON.stringify(await engine().createEvaluationPlan(CreateEvaluationPlanRequestSchema.parse(resolveInputRepositoryPaths(await readJson(options.input)))), null, 2));
  });

program.command("list-evaluations")
  .action(async () => {
    console.log(JSON.stringify(await engine().listEvaluationPlans(), null, 2));
  });

program.command("evaluation-manifest")
  .argument("<plan-id>")
  .requiredOption("--run-set <id>", "stable identifier for this A/B/C run set")
  .action(async (planId: string, options: { runSet: string }) => {
    console.log(JSON.stringify(await engine().evaluationRunManifest(planId, options.runSet), null, 2));
  });

program.command("list-project-maps")
  .option("--repo <path>")
  .action(async (options: { repo?: string }) => {
    console.log(JSON.stringify(await engine().listProjectMaps(options.repo ? resolveInvocationPath(options.repo) : undefined), null, 2));
  });

program.command("list-evaluation-observations")
  .option("--plan <plan-id>")
  .option("--run-set <id>")
  .action(async (options: { plan?: string; runSet?: string }) => {
    console.log(JSON.stringify(await engine().listEvaluationObservations(options.plan, options.runSet), null, 2));
  });

program.command("record-evaluation")
  .requiredOption("--input <json>", "evidence-backed evaluation observation JSON")
  .action(async (options: { input: string }) => {
    console.log(JSON.stringify(await engine().recordEvaluationObservation(RecordEvaluationObservationRequestSchema.parse(await readJson(options.input))), null, 2));
  });

program.command("evaluation-report")
  .argument("<plan-id>")
  .option("--run-set <id>", "select one A/B/C run set; required when a plan has multiple run sets")
  .action(async (planId: string, options: { runSet?: string }) => {
    console.log(JSON.stringify(await engine().evaluationReport(planId, options.runSet), null, 2));
  });

program.command("record-conflict")
  .requiredOption("--input <json>", "conflict review JSON")
  .action(async (options: { input: string }) => {
    console.log(JSON.stringify(await engine().recordConflict(ConflictRequestSchema.parse(await readJson(options.input))), null, 2));
  });

program.command("resolve-conflict")
  .argument("<id>")
  .requiredOption("--input <json>", "conflict resolution JSON")
  .action(async (id: string, options: { input: string }) => {
    console.log(JSON.stringify(await engine().resolveConflict(id, ResolveConflictRequestSchema.parse(await readJson(options.input))), null, 2));
  });

program.command("record-feedback")
  .requiredOption("--input <json>", "external execution result JSON")
  .action(async (options: { input: string }) => {
    console.log(JSON.stringify(await engine().recordFeedback(FeedbackRequestSchema.parse(resolveInputRepositoryPaths(await readJson(options.input)))), null, 2));
  });

program.command("verify")
  .argument("<id>")
  .requiredOption("--input <json>", "verification decision JSON")
  .action(async (id: string, options: { input: string }) => {
    console.log(JSON.stringify(await engine().verify(id, VerificationRequestSchema.parse(await readJson(options.input))), null, 2));
  });

program.command("export").option("--format <format>", "memory-md").action(async () => console.log(await engine().exportMemory()));
await program.parseAsync();
