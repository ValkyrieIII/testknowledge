import assert from "node:assert/strict";
import { test } from "node:test";
import { MAX_SHARD_INPUT_TOKENS, kindOfEvidence, outputBudget, planExtractionShards } from "../dist/index.js";

function item(overrides) {
  return {
    id: "ev_1",
    sourceType: "test_code",
    sourceRef: "t.py:1",
    repo: "/repo",
    revision: "rev",
    path: "tests/t.py",
    symbol: "test_x",
    lineStart: 1,
    lineEnd: 1,
    contentHash: "h",
    extractedAt: "2026-09-15T00:00:00.000Z",
    extractor: "stub",
    confidence: 0.5,
    content: "",
    payload: {},
    ...overrides,
  };
}

test("evidence is classified by the knowledge it can support", () => {
  assert.equal(kindOfEvidence(item({ payload: { isTest: true, assertions: [{ text: "a" }] } })), "behavior");
  assert.equal(kindOfEvidence(item({ payload: { isTest: true, mocks: ["patch"] } })), "mock");
  assert.equal(kindOfEvidence(item({ payload: { isTest: true, parametrize: ["[0, -1, None]"] } })), "boundary");
  assert.equal(kindOfEvidence(item({ payload: { isTest: true } })), "assertion");
  assert.equal(kindOfEvidence(item({ payload: { isFixture: true } })), "fixture");
  assert.equal(kindOfEvidence(item({ sourceType: "test_configuration", payload: {} })), "environment");
  assert.equal(kindOfEvidence(item({ sourceType: "issue", payload: {} })), "historical_bug");
});

test("shards group by kind and subject, and planning is deterministic", () => {
  const evidence = [
    item({ id: "ev_a", path: "tests/a.py", payload: { isTest: true, assertions: [{ text: "a" }] } }),
    item({ id: "ev_b", path: "tests/b.py", payload: { isTest: true, assertions: [{ text: "b" }] } }),
    item({ id: "ev_c", path: "src/c.py", payload: { isFixture: true } }),
  ];

  const first = planExtractionShards(evidence, { repo: "/repo" });
  const second = planExtractionShards(evidence, { repo: "/repo" });
  assert.deepEqual(first, second, "the same evidence plans the same shards");

  const keys = first.map((shard) => `${shard.kind}:${shard.subject}`);
  assert.deepEqual(keys, ["behavior:tests", "fixture:src"]);
  assert.deepEqual(first[0].evidenceIds, ["ev_a", "ev_b"]);
  assert.deepEqual(first[1].evidenceIds, ["ev_c"]);
});

test("a group larger than the input ceiling is split", () => {
  // Each item costs about one excerpt allowance, so the ceiling is reached by item count.
  const ids = Array.from({ length: 40 }, (_, index) => `ev_${index}`);
  const evidence = ids.map((id) => item({
    id,
    path: "tests/one.py",
    content: "x".repeat(40000),
    payload: { isTest: true, assertions: [{ text: "a" }] },
  }));

  const shards = planExtractionShards(evidence, { repo: "/repo" });
  assert.ok(shards.length > 1, "an oversized group must not become one unbounded prompt");
  assert.deepEqual(shards.flatMap((shard) => shard.evidenceIds).sort(), [...ids].sort(), "no evidence is dropped when splitting");
  for (const shard of shards) {
    assert.ok(shard.estimatedInputTokens <= MAX_SHARD_INPUT_TOKENS || shard.evidenceIds.length === 1);
  }
});

test("output budget follows the work a shard was given", () => {
  assert.equal(outputBudget("behavior", 1), 1740);
  assert.equal(outputBudget("behavior", 100), 4000, "the budget is capped");
  assert.equal(outputBudget("fixture", 0), 800);
  assert.equal(outputBudget("historical_bug", -50), 600, "the budget has a floor");
});

test("per-shard output budget is attached to the shard", () => {
  const evidence = [
    item({ id: "ev_a", payload: { isTest: true, assertions: [{ text: "a" }] } }),
    item({ id: "ev_b", payload: { isTest: true, assertions: [{ text: "b" }] } }),
  ];
  const [shard] = planExtractionShards(evidence, { repo: "/repo" });
  assert.equal(shard.kind, "behavior");
  assert.equal(shard.maxOutputTokens, outputBudget("behavior", 2));
});
