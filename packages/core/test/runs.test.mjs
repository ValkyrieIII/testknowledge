import assert from "node:assert/strict";
import { resolve } from "node:path";
import { test } from "node:test";
import { KnowledgeEngine } from "../dist/engine.js";

/** Repository that also accepts the run ledger, so tests can inspect what a build recorded. */
class LedgerRepository {
  evidence = [];
  knowledge = [];
  runs = [];
  items = [];

  async readEvidence() {
    return this.evidence.map((item) => ({ ...item }));
  }

  async readKnowledge() {
    return this.knowledge.map((item) => ({ ...item }));
  }

  async writeBuild(evidence, cards) {
    this.evidence = evidence.map((item) => ({ ...item }));
    this.knowledge = cards.map((item) => ({ ...item }));
  }

  async appendReview() {}

  async appendRun(record) {
    this.runs.push(record);
  }

  async appendRunItems(records) {
    this.items.push(...records);
  }

  async readRuns() {
    return this.runs.map((record) => ({ ...record }));
  }

  async readRunItems(runId) {
    const items = this.items.map((record) => ({ ...record }));
    return runId ? items.filter((item) => item.runId === runId) : items;
  }
}

const noopIndex = { rebuild: async () => {}, search: async () => [] };

class StubAdapter {
  id = "stub-adapter";

  supports() {
    return true;
  }

  async collect(file, scope) {
    return [{
      id: `ev_${file.path}`,
      sourceType: file.type,
      sourceRef: file.path,
      repo: scope.repo,
      revision: scope.revision,
      path: file.path,
      symbol: file.path,
      lineStart: 1,
      lineEnd: 1,
      contentHash: `hash:${file.text}`,
      payload: { text: file.text },
    }];
  }
}

const stubExtractor = (id) => ({
  id,
  extract: async (evidence) => evidence.map((item) => ({
    kind: "behavior",
    title: `知识 ${item.path}`,
    statement: `内容：${item.payload.text}`,
    trigger: "总是",
    expectedBehavior: "行为",
    oracle: "断言",
    risk: "",
    path: item.path,
    symbol: item.symbol,
    evidenceIds: [item.id],
    confidence: 0.5,
  })),
});

const fileA = (text) => ({ path: "a.py", type: "test_code", text });

test("a failing provider is recorded as a failed item without failing the stage", async () => {
  const repository = new LedgerRepository();
  const provider = {
    id: "provider.git-history.v1",
    collect: async () => {
      throw new Error("git unavailable");
    },
  };
  const engine = new KnowledgeEngine(repository, noopIndex, [new StubAdapter()], stubExtractor("rule"), undefined, undefined, [provider]);
  const result = await engine.build({ repo: "/repo", files: [fileA("A1")], useLlm: false });

  assert.deepEqual(result.warnings, ["provider.git-history.v1:failed"]);
  assert.equal(result.evidenceCount, 1, "a failing provider must not abort the build");

  const item = repository.items.find((entry) => entry.itemKey === "provider.git-history.v1");
  assert.ok(item, "the failing provider must leave a durable item record");
  assert.equal(item.disposition, "failed");
  assert.match(item.errorMessage, /git unavailable/);

  const stage = repository.runs.find((run) => run.stage === "project_evidence");
  assert.ok(stage);
  assert.equal(stage.disposition, "done", "the stage completed; only one item failed");
  assert.deepEqual(stage.warnings, ["provider.git-history.v1:failed"]);
});

test("a failing stage leaves a record before the error propagates", async () => {
  const repository = new LedgerRepository();
  const unreachable = {
    id: "llm",
    extract: async () => {
      throw new Error("LLM request failed: 503");
    },
  };
  const engine = new KnowledgeEngine(repository, noopIndex, [new StubAdapter()], stubExtractor("rule"), unreachable);
  const result = await engine.build({ repo: "/repo", files: [fileA("A1")], useLlm: true });

  assert.deepEqual(result.extractor, ["rule"], "extraction falls back to rules");

  const failed = repository.runs.find((run) => run.stage === "knowledge_extraction");
  assert.ok(failed, "the failed attempt must leave a durable row");
  assert.equal(failed.disposition, "failed");
  assert.equal(failed.errorCode, "http_5xx");
  assert.match(failed.errorMessage, /503/);

  const fallback = repository.runs.find((run) => run.stage === "rule_extraction");
  assert.equal(fallback?.disposition, "done");
});

test("every stage of one build leaves a record sharing one fingerprint", async () => {
  const repository = new LedgerRepository();
  const engine = new KnowledgeEngine(repository, noopIndex, [new StubAdapter()], stubExtractor("rule"));
  await engine.build({ repo: "/repo", files: [fileA("A1")], useLlm: false });

  assert.deepEqual(repository.runs.map((run) => run.stage), [
    "source_evidence",
    "project_evidence",
    "rule_extraction",
    "cluster_materialization",
    "card_materialization",
    "relations",
    "index_rebuild",
  ]);
  assert.ok(repository.runs.every((run) => run.disposition === "done"));
  assert.deepEqual([...new Set(repository.runs.map((run) => run.fingerprint))], [repository.runs[0].fingerprint]);
});

test("run records stay queryable by repo, id and run", async () => {
  const repository = new LedgerRepository();
  const engine = new KnowledgeEngine(repository, noopIndex, [new StubAdapter()], stubExtractor("rule"));
  await engine.build({ repo: "/repo", files: [fileA("A1")], useLlm: false });
  await engine.build({ repo: "/other", files: [fileA("A1")], useLlm: false });

  // build() resolves the repo path, so queries must use the resolved form.
  assert.equal((await engine.listExtractionRuns(resolve("/repo"))).length, 7);
  assert.equal((await engine.listExtractionRuns(resolve("/other"))).length, 7);
  assert.equal((await engine.listExtractionRuns()).length, 14);

  const [first] = await engine.listExtractionRuns(resolve("/repo"));
  assert.deepEqual(await engine.getExtractionRun(first.id), first);
  assert.equal(await engine.getExtractionRun("run_missing"), null);
  assert.ok((await engine.listRunItems(first.id)).length > 0);
  assert.deepEqual(await engine.listRunItems("run_missing"), []);
});
