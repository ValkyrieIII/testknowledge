import Fastify, { type FastifyInstance } from "fastify";
import { BuildRequestSchema, ConflictRequestSchema, ContextRequestSchema, CreateEvaluationPlanRequestSchema, CreateKnowledgeBatchRequestSchema, CreateKnowledgeRequestSchema, FeedbackRequestSchema, MergeKnowledgeRequestSchema, RecordEvaluationObservationRequestSchema, ResolveConflictRequestSchema, ReviewRequestSchema, RollbackKnowledgeRequestSchema, VerificationRequestSchema } from "@testknowledge/model";
import { KnowledgeEngine } from "@testknowledge/core";
import { createDefaultEngine, MultiFrameworkProjectScanner, resolveDataRoot } from "@testknowledge/adapters";

export function createEngine(dataRoot = resolveDataRoot(process.env.TESTKNOWLEDGE_DATA_ROOT)): KnowledgeEngine {
  return createDefaultEngine({ dataRoot });
}

export function createApp(engine = createEngine()): FastifyInstance {
  const app = Fastify({ logger: true });
  const scanner = new MultiFrameworkProjectScanner();
  let writing = false;
  app.get("/api/health", async () => ({ status: "ok", version: "0.1.0" }));
  app.get("/api/evaluations", async () => engine.listEvaluationPlans());
  app.get<{ Params: { id: string }; Querystring: { runSetId?: string } }>("/api/evaluations/:id/manifest", async (request, reply) => {
    try {
      return await engine.evaluationRunManifest(request.params.id, request.query.runSetId ?? "");
    } catch (error) {
      return reply.code(400).send({ error: error instanceof Error ? error.message : "Evaluation manifest creation failed" });
    }
  });
  app.get<{ Querystring: { repo?: string } }>("/api/project-maps", async (request) => engine.listProjectMaps(request.query.repo));
  app.get<{ Querystring: { planId?: string; runSetId?: string } }>("/api/evaluation-observations", async (request) => engine.listEvaluationObservations(request.query.planId, request.query.runSetId));
  app.get<{ Params: { id: string }; Querystring: { runSetId?: string } }>("/api/evaluations/:id/report", async (request, reply) => {
    try {
      return await engine.evaluationReport(request.params.id, request.query.runSetId ?? "");
    } catch (error) {
      return reply.code(404).send({ error: error instanceof Error ? error.message : "Unknown evaluation plan" });
    }
  });
  app.post("/api/evaluations", async (request, reply) => {
    if (writing) return reply.code(409).send({ error: "构建或审核正在进行，请完成后重试。" });
    writing = true;
    try {
      return await engine.createEvaluationPlan(CreateEvaluationPlanRequestSchema.parse(request.body));
    } catch (error) {
      return reply.code(400).send({ error: error instanceof Error ? error.message : "Evaluation plan creation failed" });
    } finally {
      writing = false;
    }
  });
  app.post("/api/evaluation-observations", async (request, reply) => {
    if (writing) return reply.code(409).send({ error: "构建或审核正在进行，请完成后重试。" });
    writing = true;
    try {
      return await engine.recordEvaluationObservation(RecordEvaluationObservationRequestSchema.parse(request.body));
    } catch (error) {
      return reply.code(400).send({ error: error instanceof Error ? error.message : "Evaluation observation failed" });
    } finally {
      writing = false;
    }
  });
  app.get("/api/knowledge", async () => engine.listKnowledge());
  app.get<{ Querystring: { knowledgeId?: string } }>("/api/knowledge-changes", async (request) => engine.listKnowledgeChanges(request.query.knowledgeId));
  app.get<{ Querystring: { repo?: string } }>("/api/clusters", async (request) => engine.listClusters(request.query.repo));
  app.post("/api/knowledge", async (request, reply) => {
    if (writing) return reply.code(409).send({ error: "构建或审核正在进行，请完成后重试。" });
    writing = true;
    try {
      return await engine.createKnowledge(CreateKnowledgeRequestSchema.parse(request.body));
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
      return await engine.createKnowledgeBatch(CreateKnowledgeBatchRequestSchema.parse(request.body));
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
      return await engine.mergeKnowledge(MergeKnowledgeRequestSchema.parse(request.body));
    } catch (error) {
      return reply.code(400).send({ error: error instanceof Error ? error.message : "Knowledge merge failed" });
    } finally {
      writing = false;
    }
  });
  app.get("/api/relations", async () => engine.listRelations());
  app.post("/api/conflicts", async (request, reply) => {
    if (writing) return reply.code(409).send({ error: "构建或审核正在进行，请完成后重试。" });
    writing = true;
    try {
      return await engine.recordConflict(ConflictRequestSchema.parse(request.body));
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
      return await engine.resolveConflict(request.params.id, ResolveConflictRequestSchema.parse(request.body));
    } catch (error) {
      return reply.code(400).send({ error: error instanceof Error ? error.message : "Conflict resolution failed" });
    } finally {
      writing = false;
    }
  });
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
  app.post("/api/feedback", async (request, reply) => {
    if (writing) return reply.code(409).send({ error: "构建或审核正在进行，请完成后重试。" });
    writing = true;
    try {
      return await engine.recordFeedback(FeedbackRequestSchema.parse(request.body));
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
  app.patch<{ Params: { id: string } }>("/api/clusters/:id", async (request, reply) => {
    if (writing) return reply.code(409).send({ error: "构建或审核正在进行，请完成后重试。" });
    writing = true;
    try {
      return await engine.reviewCluster(request.params.id, ReviewRequestSchema.parse(request.body));
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
      return await engine.verify(request.params.id, VerificationRequestSchema.parse(request.body));
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
      return await engine.rollbackKnowledge(request.params.id, RollbackKnowledgeRequestSchema.parse(request.body));
    } catch (error) {
      return reply.code(400).send({ error: error instanceof Error ? error.message : "Knowledge rollback failed" });
    } finally {
      writing = false;
    }
  });
  app.get("/api/export/memory", async (_request, reply) => reply.type("text/markdown").send(await engine.exportMemory()));
  return app;
}
