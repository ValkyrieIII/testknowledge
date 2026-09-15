import assert from "node:assert/strict";
import { test } from "node:test";
import { MAX_SHARD_INPUT_TOKENS, MAX_SHARD_ITEMS, escalateOutputBudget, kindOfEvidence, outputBudget, planExtractionShards, supportsKnowledge } from "../dist/index.js";

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

test("evidence that cannot support knowledge never reaches a shard", () => {
  // Production code is collected so COVERS can point at production symbols. It is not knowledge.
  const evidence = [
    item({ id: "ev_test", payload: { isTest: true, assertions: [{ text: "a" }] } }),
    item({ id: "ev_prod", sourceType: "production_code", path: "backend/bot/routes.py", symbol: "register_routes", payload: { isTest: false } }),
    item({ id: "ev_file", sourceType: "production_code", path: "backend/bot/__init__.py", payload: {} }),
  ];

  assert.equal(supportsKnowledge(evidence[0]), true);
  assert.equal(supportsKnowledge(evidence[1]), false);
  assert.equal(supportsKnowledge(evidence[2]), false);
  assert.deepEqual(planExtractionShards(evidence, { repo: "/repo" }).flatMap((shard) => shard.evidenceIds), ["ev_test"]);
});

test("no shard grows past the item ceiling", () => {
  // A token budget alone let one top-level directory become a single 160-file group, which was
  // then sliced into 30-item chunks of unrelated files. Every one of those failed.
  const evidence = Array.from({ length: 35 }, (_, index) => item({ id: `ev_${index}`, path: "tests/one.py", payload: { isTest: true, assertions: [{ text: "a" }] } }));
  const shards = planExtractionShards(evidence, { repo: "/repo" });

  assert.ok(shards.length >= 4, "35 items must not fit in one shard");
  for (const shard of shards) assert.ok(shard.evidenceIds.length <= MAX_SHARD_ITEMS);
  assert.deepEqual(shards.flatMap((shard) => shard.evidenceIds).sort(), evidence.map((entry) => entry.id).sort());
});

test("chunks of one group get distinct labels so their ledger rows stay separate", () => {
  const evidence = Array.from({ length: 25 }, (_, index) => item({ id: `ev_${index}`, path: "tests/one.py", payload: { isTest: true, assertions: [{ text: "a" }] } }));
  const shards = planExtractionShards(evidence, { repo: "/repo" });

  const subjects = shards.map((shard) => shard.subject);
  assert.deepEqual(subjects, ["tests#1", "tests#2", "tests#3"]);
  assert.equal(new Set(subjects).size, subjects.length, "without distinct labels a failing chunk is overwritten by a succeeding sibling");
  assert.equal(new Set(shards.map((shard) => shard.id)).size, shards.length);
});

test("output budget leaves room for a model that reasons before answering", () => {
  // The budget is a ceiling, not a charge, so a generous floor costs nothing for a shard that
  // finishes early. Measured on the real repository, a 29-item shard burned the whole allowance
  // at both 4000 and 8000 on hidden reasoning and emitted nothing.
  assert.equal(outputBudget("fixture", 0), 8000);
  assert.equal(outputBudget("behavior", 1), 8000);
  assert.equal(outputBudget("behavior", 100), 24000, "the budget is capped");
  assert.equal(outputBudget("historical_bug", -50), 8000, "a negative count still gets the floor");
});

test("a budget exhausted before any output is escalated, not split", () => {
  // Splitting cannot help: less input does not mean less thinking. More room can.
  assert.equal(escalateOutputBudget(8000), 16000);
  assert.equal(escalateOutputBudget(24000), 48000, "escalation outgrows the normal ceiling");
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
