import { Command } from "commander";
import { resolve, join } from "node:path";
import { mkdir } from "node:fs/promises";
import { BuildRequestSchema, ContextRequestSchema, ReviewRequestSchema } from "@testknowledge/model";
import { KnowledgeEngine } from "@testknowledge/core";
import { JsonlRepository, MarkdownAdapter, PythonPytestAdapter, RuleCandidateExtractor, SqliteBm25fIndex } from "@testknowledge/adapters";
// import { LlmKnowledgeExtractor } from "@testknowledge/adapters";   // 暂时停用

function engine(): KnowledgeEngine {
  const root = resolve(process.cwd(), ".testknowledge");
  // LLM 抽取暂时停用；行为级卡片以后再加回来。
  // const baseUrl = process.env.TESTKNOWLEDGE_LLM_BASE_URL;
  // const apiKey = process.env.TESTKNOWLEDGE_LLM_API_KEY;
  // const model = process.env.TESTKNOWLEDGE_LLM_MODEL;
  // const llm = baseUrl && apiKey && model ? new LlmKnowledgeExtractor({ baseUrl, apiKey, model }) : undefined;
  return new KnowledgeEngine(
    new JsonlRepository(root),
    new SqliteBm25fIndex(join(root, "index.sqlite3")),
    [new PythonPytestAdapter(), new MarkdownAdapter()],
    new RuleCandidateExtractor(),
    // llm,
  );
}

const program = new Command().name("testknowledge").description("Evidence-backed test knowledge engine");
program.command("init").action(async () => {
  await mkdir(resolve(process.cwd(), ".testknowledge"), { recursive: true });
  console.log(JSON.stringify({ status: "ready", dataRoot: resolve(process.cwd(), ".testknowledge") }, null, 2));
});

program.command("build")
  .requiredOption("--repo <path>")
  .requiredOption("--file <path...>")
  // .option("--llm")   // 暂时停用
  .action(async (options: { repo: string; file: string[] }) => {
    const body = BuildRequestSchema.parse({ repo: resolve(options.repo), files: options.file.map((path) => ({ path, type: path.includes("test") ? "test_code" : path.endsWith(".md") ? "project_document" : "production_code" })), useLlm: false /* Boolean(options.llm) */ });
    const files = await KnowledgeEngine.readFiles(body.repo, body.files);
    console.log(JSON.stringify(await engine().build({ repo: body.repo, files, useLlm: body.useLlm }), null, 2));
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
    const request = ContextRequestSchema.parse({ repo: resolve(options.repo), revision: options.revision, task: options.task, changedFiles: options.changedFile ?? [], targetSymbols: options.symbol ?? [], includeCandidates: Boolean(options.includeCandidates) });
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

program.command("export").option("--format <format>", "memory-md").action(async () => console.log(await engine().exportMemory()));
await program.parseAsync();
