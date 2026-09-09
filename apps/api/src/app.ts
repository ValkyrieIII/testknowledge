import Fastify, { type FastifyInstance } from "fastify";
import { join, resolve } from "node:path";
import { BuildRequestSchema, ContextRequestSchema, ReviewRequestSchema } from "@testknowledge/model";
import { KnowledgeEngine } from "@testknowledge/core";
import { PytestProjectScanner } from "@testknowledge/adapters";
import { JsonlRepository, MarkdownAdapter, PythonPytestAdapter, RuleCandidateExtractor, SqliteBm25fIndex } from "@testknowledge/adapters";
// import { LlmKnowledgeExtractor } from "@testknowledge/adapters";   // 暂时停用

export function createEngine(dataRoot = resolve(process.cwd(), ".testknowledge")): KnowledgeEngine {
  const repository = new JsonlRepository(dataRoot);
  const ruleExtractor = new RuleCandidateExtractor();
  // LLM 抽取暂时停用；行为级卡片以后再加回来。
  // const baseUrl = process.env.TESTKNOWLEDGE_LLM_BASE_URL;
  // const apiKey = process.env.TESTKNOWLEDGE_LLM_API_KEY;
  // const model = process.env.TESTKNOWLEDGE_LLM_MODEL;
  // const llmExtractor = baseUrl && apiKey && model ? new LlmKnowledgeExtractor({ baseUrl, apiKey, model }) : undefined;
  return new KnowledgeEngine(
    repository,
    new SqliteBm25fIndex(join(dataRoot, "index.sqlite3")),
    [new PythonPytestAdapter(), new MarkdownAdapter()],
    ruleExtractor,
    // llmExtractor,
  );
}

export function createApp(engine = createEngine()): FastifyInstance {
  const app = Fastify({ logger: true });
  const scanner = new PytestProjectScanner();
  let writing = false;
  app.get("/api/health", async () => ({ status: "ok", version: "0.1.0" }));
  app.get("/api/knowledge", async () => engine.listKnowledge());
  app.get<{ Params: { id: string } }>("/api/knowledge/:id", async (request, reply) => {
    try {
      return await engine.getKnowledge(request.params.id);
    } catch (error) {
      return reply.code(404).send({ error: error instanceof Error ? error.message : "Unknown knowledge card" });
    }
  });
  app.get<{ Params: { id: string } }>("/api/evidence/:id", async (request, reply) => {
    try {
      return await engine.getEvidence(request.params.id);
    } catch (error) {
      return reply.code(404).send({ error: error instanceof Error ? error.message : "Unknown evidence" });
    }
  });
  app.post("/api/context", async (request, reply) => {
    try {
      return await engine.query(ContextRequestSchema.parse(request.body));
    } catch (error) {
      return reply.code(400).send({ error: error instanceof Error ? error.message : "Invalid context request" });
    }
  });
  app.post("/api/build", async (request, reply) => {
    if (writing) return reply.code(409).send({ error: "构建或审核正在进行，请完成后重试。" });
    writing = true;
    try {
      const body = BuildRequestSchema.parse(request.body);
      return await engine.buildFromRepository(body, scanner);
    } catch (error) {
      return reply.code(400).send({ error: error instanceof Error ? error.message : "Build failed" });
    } finally {
      writing = false;
    }
  });
  app.patch<{ Params: { id: string } }>("/api/knowledge/:id", async (request, reply) => {
    if (writing) return reply.code(409).send({ error: "构建或审核正在进行，请完成后重试。" });
    writing = true;
    try {
      return await engine.review(request.params.id, ReviewRequestSchema.parse(request.body));
    } catch (error) {
      return reply.code(400).send({ error: error instanceof Error ? error.message : "Review failed" });
    } finally {
      writing = false;
    }
  });
  app.get("/api/export/memory", async (_request, reply) => reply.type("text/markdown").send(await engine.exportMemory()));
  return app;
}
