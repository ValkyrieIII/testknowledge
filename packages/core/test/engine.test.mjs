import assert from "node:assert/strict";
import { test } from "node:test";
import { KnowledgeEngine } from "../dist/engine.js";

class MemoryRepository {
  evidence = [];
  knowledge = [];
  reviews = [];

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

  async appendReview(record) {
    this.reviews.push(record);
  }
}

const noopIndex = { rebuild: async () => {}, search: async () => [] };

/** One evidence per file. The id is derived from a configurable salt, so tests can churn ids. */
class StubAdapter {
  id = "stub-adapter";
  salt = "1";

  supports() {
    return true;
  }

  async collect(file, scope) {
    const contentHash = `hash:${file.text}`;
    return [
      {
        id: `ev_${this.salt}_${file.path}_${contentHash}`,
        sourceType: file.type,
        sourceRef: file.path,
        repo: scope.repo,
        revision: scope.revision,
        path: file.path,
        symbol: file.path,
        lineStart: 1,
        lineEnd: 1,
        contentHash,
        extractedAt: "2026-09-15T00:00:00.000Z",
        extractor: "stub-adapter",
        content: file.text,
        confidence: 0.5,
        payload: { text: file.text },
      },
    ];
  }
}

/**
 * Stands in for the semantic knowledge producer. Deterministic rule output is an observation
 * of evidence and never becomes a knowledge card, so a stub that should yield cards must take
 * the LLM slot and builds must run with `useLlm: true`.
 */
class StubExtractor {
  id = "stub-extractor";

  async extract(evidence) {
    return evidence.map((item) => ({
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
    }));
  }
}

const noopExtractor = { id: "rule", extract: async () => [] };

function setup() {
  const repository = new MemoryRepository();
  const adapter = new StubAdapter();
  const engine = new KnowledgeEngine(repository, noopIndex, [adapter], noopExtractor, new StubExtractor());
  return { repository, adapter, engine };
}

const fileA = (text) => ({ path: "a.py", type: "test_code", text });
const fileB = (text) => ({ path: "b.py", type: "test_code", text });

test("rule extraction produces no knowledge cards", async () => {
  const repository = new MemoryRepository();
  const engine = new KnowledgeEngine(repository, noopIndex, [new StubAdapter()], new StubExtractor());
  const result = await engine.build({ repo: "/repo", files: [fileA("A1")], useLlm: false });

  assert.deepEqual(result.extractor, ["stub-extractor"]);
  assert.equal(result.knowledgeCount, 0, "the rule extractor no longer produces knowledge cards");
  assert.deepEqual(await engine.listKnowledge(), []);
});

test("changing one file preserves identity and review status of the others", async () => {
  const { repository, engine } = setup();
  await engine.build({ repo: "/repo", files: [fileA("A1"), fileB("B1")], useLlm: true });

  const before = await repository.readKnowledge();
  const cardA = before.find((card) => card.path === "a.py");
  assert.ok(cardA);
  await engine.review(cardA.id, { status: "reviewed", reviewer: "me", note: "ok" });

  await engine.build({ repo: "/repo", files: [fileA("A1"), fileB("B2")], useLlm: true });
  const after = await repository.readKnowledge();

  const aCards = after.filter((card) => card.path === "a.py");
  assert.equal(aCards.length, 1, "unchanged file must not spawn a stale duplicate");
  assert.equal(aCards[0]?.id, cardA.id, "unchanged card keeps its id");
  assert.equal(aCards[0]?.status, "reviewed", "unchanged card keeps its review status");

  const bCards = after.filter((card) => card.path === "b.py");
  assert.equal(bCards.filter((card) => card.status === "candidate").length, 1);
  assert.equal(bCards.filter((card) => card.status === "stale").length, 1);
  assert.equal(after.length, 3);
});

test("re-running build on identical input is idempotent", async () => {
  const { repository, engine } = setup();
  const files = [fileA("A1"), fileB("B1")];
  await engine.build({ repo: "/repo", files, useLlm: true });
  const first = await repository.readKnowledge();
  const cardA = first.find((card) => card.path === "a.py");
  assert.ok(cardA);
  await engine.review(cardA.id, { status: "reviewed", reviewer: "me", note: "ok" });
  const reviewedUpdatedAt = (await repository.readKnowledge()).find((card) => card.path === "a.py")?.updatedAt;

  await engine.build({ repo: "/repo", files, useLlm: true });
  const second = await repository.readKnowledge();
  const cardAAfter = second.find((card) => card.path === "a.py");

  assert.equal(second.length, 2, "no growth on identical rebuild");
  assert.equal(cardAAfter?.id, cardA.id);
  assert.equal(cardAAfter?.status, "reviewed");
  assert.equal(cardAAfter?.updatedAt, reviewedUpdatedAt, "unchanged rebuild must not churn updatedAt");
});

test("card identity ignores evidence id churn", async () => {
  const { repository, adapter, engine } = setup();
  await engine.build({ repo: "/repo", files: [fileA("A1")], useLlm: true });
  const card = (await repository.readKnowledge())[0];
  assert.ok(card);
  await engine.review(card.id, { status: "reviewed", reviewer: "me", note: "ok" });

  adapter.salt = "2";
  await engine.build({ repo: "/repo", files: [fileA("A1")], useLlm: true });
  const after = await repository.readKnowledge();

  assert.equal(after.length, 1, "same knowledge must not duplicate when only evidence ids change");
  assert.equal(after[0]?.id, card.id);
  assert.equal(after[0]?.status, "reviewed");
});

test("cards from different repositories do not collide", async () => {
  const { repository, engine } = setup();
  await engine.build({ repo: "/repo-one", files: [fileA("A1")], useLlm: true });
  await engine.build({ repo: "/repo-two", files: [fileA("A1")], useLlm: true });
  const cards = await repository.readKnowledge();
  assert.equal(cards.length, 2);
  assert.notEqual(cards[0]?.id, cards[1]?.id);
});

test("LLM extraction replaces rule cards when configured", async () => {
  const repository = new MemoryRepository();
  let ruleCalls = 0;
  const rule = {
    id: "rule",
    extract: async () => {
      ruleCalls += 1;
      return [];
    },
  };
  const llm = {
    id: "llm",
    extract: async (evidence) =>
      evidence.map((item) => ({
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
        confidence: 0.6,
      })),
  };
  const engine = new KnowledgeEngine(repository, noopIndex, [new StubAdapter()], rule, llm);
  const result = await engine.build({ repo: "/r", files: [fileA("A1")], useLlm: true });
  assert.equal(ruleCalls, 0);
  assert.deepEqual(result.extractor, ["llm"]);
  assert.equal(result.knowledgeCount, 1);
});

test("falling back to rule extraction yields observations, not cards", async () => {
  const repository = new MemoryRepository();
  const llm = {
    id: "llm",
    extract: async () => {
      throw new Error("boom");
    },
  };
  const engine = new KnowledgeEngine(repository, noopIndex, [new StubAdapter()], new StubExtractor(), llm);
  const result = await engine.build({ repo: "/r", files: [fileA("A1")], useLlm: true });

  assert.deepEqual(result.extractor, ["stub-extractor"]);
  assert.deepEqual(result.warnings, ["llm:failed"]);
  assert.equal(result.knowledgeCount, 0, "the fallback extractor is deterministic, so it emits no claims");
});

test("an extractor that reports itself unready is never asked to run", async () => {
  const repository = new MemoryRepository();
  let calls = 0;
  const llm = {
    id: "llm",
    isReady: () => false,
    extract: async () => {
      calls += 1;
      return [];
    },
  };
  const engine = new KnowledgeEngine(repository, noopIndex, [new StubAdapter()], new StubExtractor(), llm);
  const result = await engine.build({ repo: "/r", files: [fileA("A1")], useLlm: true });

  assert.equal(calls, 0);
  assert.deepEqual(result.extractor, ["stub-extractor"]);
  assert.deepEqual(result.warnings, ["llm:unconfigured"]);
});
