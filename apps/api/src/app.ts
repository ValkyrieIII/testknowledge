import Fastify, { type FastifyInstance } from "fastify";
import { BuildRequestSchema, ConflictRequestSchema, ContextRequestSchema, CreateKnowledgeBatchRequestSchema, CreateKnowledgeRequestSchema, FeedbackRequestSchema, KnowledgeStatusSchema, MergeKnowledgeRequestSchema, ResolveConflictRequestSchema, ReviewRequestSchema, RollbackKnowledgeRequestSchema, SettingsPatchSchema, VerificationRequestSchema } from "@testknowledge/model";
import { KnowledgeEngine } from "@testknowledge/core";
import { SettingsStore, createDefaultEngine, MultiFrameworkProjectScanner, resolveDataRoot, settingsFilePath } from "@testknowledge/adapters";

export function createEngine(dataRoot = resolveDataRoot(process.env.TESTKNOWLEDGE_DATA_ROOT), settings?: SettingsStore): KnowledgeEngine {
  return createDefaultEngine(settings ? { dataRoot, settings } : { dataRoot });
}

export function createApp(engine?: KnowledgeEngine, settings?: SettingsStore): FastifyInstance {
  const app = Fastify({ logger: true });
  const store = settings ?? new SettingsStore(settingsFilePath(resolveDataRoot(process.env.TESTKNOWLEDGE_DATA_ROOT)));
  const instance = engine ?? createEngine(undefined, store);
  const scanner = new MultiFrameworkProjectScanner();
  let writing = false;
  app.get("/api/health", async () => ({ status: "ok", version: "0.1.0" }));
  app.get("/api/settings", async () => store.view());
  app.patch("/api/settings", async (request, reply) => {
    try {
      store.update(SettingsPatchSchema.parse(request.body));
      return store.view();
    } catch (error) {
      return reply.code(400).send({ error: error instanceof Error ? error.message : "Settings update failed" });
    }
  });
  app.get<{ Querystring: { repo?: string } }>("/api/project-maps", async (request) => instance.listProjectMaps(request.query.repo));
  app.get("/api/knowledge", async () => instance.listKnowledge());
  app.get<{ Querystring: { repo?: string; status?: string; offset?: string; limit?: string } }>("/api/knowledge/page", async (request, reply) => {
    const status = request.query.status === "active"
      ? { success: true as const, data: "active" as const }
      : request.query.status ? KnowledgeStatusSchema.safeParse(request.query.status) : { success: true as const, data: undefined };
    if (!status.success) return reply.code(400).send({ error: "Invalid knowledge status" });
    return instance.listKnowledgePage({ repo: request.query.repo, status: status.data, offset: Number(request.query.offset ?? 0), limit: Number(request.query.limit ?? 12) });
  });
  app.get<{ Querystring: { knowledgeId?: string } }>("/api/knowledge-changes", async (request) => instance.listKnowledgeChanges(request.query.knowledgeId));
  app.get<{ Querystring: { repo?: string; offset?: string; limit?: string } }>("/api/knowledge-changes/page", async (request) => instance.listKnowledgeChangePage({ repo: request.query.repo, offset: Number(request.query.offset ?? 0), limit: Number(request.query.limit ?? 20) }));
  app.get<{ Querystring: { repo?: string; revision?: string } }>("/api/runs", async (request) => instance.listExtractionRuns(request.query.repo, request.query.revision));
  app.get<{ Params: { id: string } }>("/api/runs/:id/items", async (request) => instance.listRunItems(request.params.id));
  app.get<{ Querystring: { repo?: string } }>("/api/clusters", async (request) => instance.listClusters(request.query.repo));
  app.post("/api/knowledge", async (request, reply) => {
    if (writing) return reply.code(409).send({ error: "构建或审核正在进行，请完成后重试。" });
    writing = true;
    try {
      return await instance.createKnowledge(CreateKnowledgeRequestSchema.parse(request.body));
    } catch (error) {
      return reply.code(400).send({ error: error instanceof Error ? error.message : "Knowledge creation failed" });
    } finally {
      writing = false;
    }
  });
  app.post("/api/knowledge/import", async (request, reply) => {
    if (writing) return reply.code(409).send({ error: "构建或审核正在进行，请完成后重试。" });
    writing = true;
    try {
      return await instance.createKnowledgeBatch(CreateKnowledgeBatchRequestSchema.parse(request.body));
    } catch (error) {
      return reply.code(400).send({ error: error instanceof Error ? error.message : "Knowledge pack import failed" });
    } finally {
      writing = false;
    }
  });
  app.post("/api/knowledge/merge", async (request, reply) => {
    if (writing) return reply.code(409).send({ error: "构建或审核正在进行，请完成后重试。" });
    writing = true;
    try {
      return await instance.mergeKnowledge(MergeKnowledgeRequestSchema.parse(request.body));
    } catch (error) {
      return reply.code(400).send({ error: error instanceof Error ? error.message : "Knowledge merge failed" });
    } finally {
      writing = false;
    }
  });
  app.get("/api/relations", async () => instance.listRelations());
  app.post("/api/conflicts", async (request, reply) => {
    if (writing) return reply.code(409).send({ error: "构建或审核正在进行，请完成后重试。" });
    writing = true;
    try {
      return await instance.recordConflict(ConflictRequestSchema.parse(request.body));
    } catch (error) {
      return reply.code(400).send({ error: error instanceof Error ? error.message : "Conflict recording failed" });
    } finally {
      writing = false;
    }
  });
  app.post<{ Params: { id: string } }>("/api/conflicts/:id/resolve", async (request, reply) => {
    if (writing) return reply.code(409).send({ error: "构建或审核正在进行，请完成后重试。" });
    writing = true;
    try {
      return await instance.resolveConflict(request.params.id, ResolveConflictRequestSchema.parse(request.body));
    } catch (error) {
      return reply.code(400).send({ error: error instanceof Error ? error.message : "Conflict resolution failed" });
    } finally {
      writing = false;
    }
  });
  app.get<{ Params: { id: string } }>("/api/knowledge/:id", async (request, reply) => {
    try {
      return await instance.getKnowledge(request.params.id);
    } catch (error) {
      return reply.code(404).send({ error: error instanceof Error ? error.message : "Unknown knowledge card" });
    }
  });
  app.get<{ Params: { id: string } }>("/api/evidence/:id", async (request, reply) => {
    try {
      return await instance.getEvidence(request.params.id);
    } catch (error) {
      return reply.code(404).send({ error: error instanceof Error ? error.message : "Unknown evidence" });
    }
  });
  app.post("/api/context", async (request, reply) => {
    try {
      return await instance.query(ContextRequestSchema.parse(request.body));
    } catch (error) {
      return reply.code(400).send({ error: error instanceof Error ? error.message : "Invalid context request" });
    }
  });
  app.post("/api/feedback", async (request, reply) => {
    if (writing) return reply.code(409).send({ error: "构建或审核正在进行，请完成后重试。" });
    writing = true;
    try {
      return await instance.recordFeedback(FeedbackRequestSchema.parse(request.body));
    } catch (error) {
      return reply.code(400).send({ error: error instanceof Error ? error.message : "Feedback failed" });
    } finally {
      writing = false;
    }
  });
  app.post("/api/build", async (request, reply) => {
    if (writing) return reply.code(409).send({ error: "构建或审核正在进行，请完成后重试。" });
    writing = true;
    try {
      const body = BuildRequestSchema.parse(request.body);
      return await instance.buildFromRepository(body, scanner);
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
      return await instance.review(request.params.id, ReviewRequestSchema.parse(request.body));
    } catch (error) {
      return reply.code(400).send({ error: error instanceof Error ? error.message : "Review failed" });
    } finally {
      writing = false;
    }
  });
  app.patch<{ Params: { id: string } }>("/api/clusters/:id", async (request, reply) => {
    if (writing) return reply.code(409).send({ error: "构建或审核正在进行，请完成后重试。" });
    writing = true;
    try {
      return await instance.reviewCluster(request.params.id, ReviewRequestSchema.parse(request.body));
    } catch (error) {
      return reply.code(400).send({ error: error instanceof Error ? error.message : "Cluster review failed" });
    } finally {
      writing = false;
    }
  });
  app.post<{ Params: { id: string } }>("/api/knowledge/:id/verify", async (request, reply) => {
    if (writing) return reply.code(409).send({ error: "构建或审核正在进行，请完成后重试。" });
    writing = true;
    try {
      return await instance.verify(request.params.id, VerificationRequestSchema.parse(request.body));
    } catch (error) {
      return reply.code(400).send({ error: error instanceof Error ? error.message : "Verification failed" });
    } finally {
      writing = false;
    }
  });
  app.post<{ Params: { id: string } }>("/api/knowledge/:id/rollback", async (request, reply) => {
    if (writing) return reply.code(409).send({ error: "构建或审核正在进行，请完成后重试。" });
    writing = true;
    try {
      return await instance.rollbackKnowledge(request.params.id, RollbackKnowledgeRequestSchema.parse(request.body));
    } catch (error) {
      return reply.code(400).send({ error: error instanceof Error ? error.message : "Knowledge rollback failed" });
    } finally {
      writing = false;
    }
  });
  app.get("/api/export/memory", async (_request, reply) => reply.type("text/markdown").send(await instance.exportMemory()));
  return app;
}
