import assert from "node:assert/strict";
import { test } from "node:test";
import { KnowledgeEngine, citationIssues, contentHashOf, evidenceId } from "../dist/index.js";

const noopIndex = { rebuild: async () => {}, search: async () => [] };

class LedgerRepository {
  evidence = [];
  knowledge = [];
  runs = [];
  items = [];

  async readEvidence() { return this.evidence.map((item) => ({ ...item })); }
  async readKnowledge() { return this.knowledge.map((item) => ({ ...item })); }
  async writeBuild(evidence, cards) {
    this.evidence = evidence.map((item) => ({ ...item }));
    this.knowledge = cards.map((item) => ({ ...item }));
  }
  async appendReview() {}
  async appendRun(record) { this.runs.push(record); }
  async appendRunItems(records) { this.items.push(...records); }
}

class StubAdapter {
  id = "stub-adapter";
  supports() { return true; }
  async collect(file, scope) {
    const contentHash = `hash:${file.text}`;
    return [{
      id: `ev_base_${file.path}_${contentHash}`,
      sourceType: file.type, sourceRef: file.path, repo: scope.repo, revision: scope.revision,
      path: file.path, symbol: file.path, lineStart: 1, lineEnd: 1, contentHash,
      extractedAt: "2026-09-15T00:00:00.000Z", extractor: this.id, content: file.text, confidence: 0.5,
      payload: { text: file.text },
    }];
  }
}

/** A tool runtime over an in-memory file map, minting evidence exactly like a real adapter would. */
class FakeRuntime {
  id = "tool.fake.v1";
  constructor(files) { this.files = files; }
  async read(tool, scope) {
    const content = this.files[tool.target] ?? "";
    const contentHash = contentHashOf(content);
    return [{
      id: evidenceId(scope.repo, tool.target, contentHash),
      sourceType: "test_code", sourceRef: tool.target, repo: scope.repo, revision: scope.revision,
      path: tool.target, symbol: "", lineStart: 1, lineEnd: Math.max(1, content.split("\n").length),
      contentHash, extractedAt: "2026-09-15T00:00:00.000Z", extractor: this.id, content, confidence: 1,
      payload: { toolRead: true },
    }];
  }
}

/**
 * Stands in for a tool-using model: it asks for the reads it was scripted with, then answers,
 * citing the ids that came back in the tool results.
 */
class FakeAgenticExtractor {
  id = "llm.fake";
  constructor(reads, baseIds) {
    this.reads = reads;
    this.baseIds = baseIds;
    this.steps = 0;
  }

  async extract() { return { drafts: [], clusters: [] }; }
  async extractShard(shard, evidence) { return this.finishShard(shard, evidence, JSON.stringify(this.answer([]))); }
  beginShard() { return [{ role: "system", content: "extract" }, { role: "user", content: "evidence" }]; }

  async step(messages) {
    this.steps += 1;
    if (this.steps <= this.reads.length) return { toolCalls: [this.reads[this.steps - 1]] };
    const cited = messages.flatMap((message) => {
      try {
        return (JSON.parse(message.content).toolResults ?? []).map((result) => result.id);
      } catch {
        return [];
      }
    });
    return { content: JSON.stringify(this.answer(cited)) };
  }

  answer(cited) {
    return [{
      kind: "behavior", title: "发现的行为", statement: "行为", trigger: "触发", expectedBehavior: "预期",
      oracle: "断言", risk: "", path: "t.py", symbol: "",
      evidenceIds: [...new Set([...this.baseIds, ...cited])], confidence: 0.6,
    }];
  }

  finishShard(_shard, _evidence, content) { return { drafts: JSON.parse(content), clusters: [] }; }
}

const rule = { id: "rule", extract: async () => [] };
const fileA = (text) => ({ path: "t.py", type: "test_code", text });

function build(repository, reads, baseIds, files) {
  const runtime = new FakeRuntime(files ?? { "src/one.py": "def helper():\n    return 1\n" });
  const engine = new KnowledgeEngine(repository, noopIndex, [new StubAdapter()], rule, new FakeAgenticExtractor(reads, baseIds), undefined, [], runtime);
  return { engine, runtime };
}

test("a tool read becomes evidence the card can cite", async () => {
  const repository = new LedgerRepository();
  const { engine } = build(repository, [{ tool: "read", target: "src/one.py" }], []);

  const result = await engine.build({ repo: "/repo", files: [fileA("A1")], useLlm: true });

  assert.equal(result.knowledgeCount, 1);
  const toolEvidence = (await repository.readEvidence()).filter((item) => item.extractor === "tool.fake.v1");
  assert.equal(toolEvidence.length, 1, "the model's read is persisted as evidence");
  assert.equal(toolEvidence[0]?.path, "src/one.py");

  const card = (await repository.readKnowledge())[0];
  assert.ok(card.evidenceIds.includes(toolEvidence[0].id), "the card cites what the model actually read");

  const run = repository.runs.find((entry) => entry.stage === "knowledge_extraction");
  assert.equal(run?.counts.toolReads, 1, "the read is counted in the ledger");
});

test("a model-directed build folds the read log into its revision", async () => {
  const withRead = new LedgerRepository();
  const withoutRead = new LedgerRepository();
  const files = { "src/one.py": "def helper():\n    return 1\n" };

  const readBuild = build(withRead, [{ tool: "read", target: "src/one.py" }], [], files);
  const noReadBuild = build(withoutRead, [], [], files);
  const readResult = await readBuild.engine.build({ repo: "/repo", files: [fileA("A1")], useLlm: true });
  const noReadResult = await noReadBuild.engine.build({ repo: "/repo", files: [fileA("A1")], useLlm: true });

  assert.notEqual(readResult.revision, noReadResult.revision, "what the model read changes the build identity");

  const other = new LedgerRepository();
  const otherBuild = build(other, [{ tool: "read", target: "src/two.py" }], [], files);
  const otherResult = await otherBuild.engine.build({ repo: "/repo", files: [fileA("A1")], useLlm: true });
  assert.notEqual(readResult.revision, otherResult.revision, "a different read sequence is a different build");
});

test("tool evidence keeps one identity across revisions", async () => {
  const files = { "src/one.py": "def helper():\n    return 1\n" };
  const first = new LedgerRepository();
  const second = new LedgerRepository();

  const firstBuild = build(first, [{ tool: "read", target: "src/one.py" }], [], files);
  const secondBuild = build(second, [{ tool: "read", target: "src/one.py" }], [], files);
  await firstBuild.engine.build({ repo: "/repo", files: [fileA("A1")], useLlm: true });
  await secondBuild.engine.build({ repo: "/repo", files: [fileA("A2")], useLlm: true });

  const firstId = (await first.readEvidence()).find((item) => item.extractor === "tool.fake.v1")?.id;
  const secondId = (await second.readEvidence()).find((item) => item.extractor === "tool.fake.v1")?.id;
  assert.ok(firstId);
  assert.equal(firstId, secondId, "the same bytes keep one evidence identity regardless of revision");
});

test("citation checking rejects an anchor whose line range is not cited", () => {
  const cited = [{
    id: "ev_1", sourceType: "test_code", sourceRef: "t.py:1", repo: "/repo", revision: "rev",
    path: "t.py", symbol: "test_x", lineStart: 1, lineEnd: 3, contentHash: "h",
    extractedAt: "2026-09-15T00:00:00.000Z", extractor: "stub", content: "assert x == 1", confidence: 0.5, payload: {},
  }];
  const base = { kind: "behavior", title: "t", statement: "s", trigger: "g", expectedBehavior: "e", risk: "", path: "t.py", symbol: "", evidenceIds: ["ev_1"], confidence: 0.5 };

  assert.deepEqual(citationIssues({ ...base, oracle: "assert x == 1" }, cited), []);

  const misplaced = citationIssues({ ...base, oracle: "见 `t.py:40-60`" }, cited);
  assert.deepEqual(misplaced, [{ anchor: "t.py:40-60", reason: "line_out_of_range" }]);

  const missing = citationIssues({ ...base, oracle: "见 `t.py:1-3`" }, [undefined]);
  assert.deepEqual(missing, [{ anchor: "", reason: "missing_evidence_reference" }]);
});
