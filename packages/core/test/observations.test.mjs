import assert from "node:assert/strict";
import { resolve } from "node:path";
import { test } from "node:test";
import { KnowledgeEngine, materializeObservations } from "../dist/index.js";

function evidenceItem(overrides) {
  return {
    id: "ev_1",
    sourceType: "test_code",
    sourceRef: "t.py:1",
    repo: "/repo",
    revision: "rev",
    path: "t.py",
    symbol: "test_x",
    lineStart: 1,
    lineEnd: 9,
    contentHash: "hash",
    extractedAt: "2026-09-15T00:00:00.000Z",
    extractor: "stub",
    confidence: 0.5,
    content: "",
    payload: {},
    ...overrides,
  };
}

const scope = { repo: "/repo", revision: "rev" };

test("observations carry no review lifecycle at all", () => {
  const observations = materializeObservations([
    evidenceItem({ payload: { isTest: true, assertions: [{ text: "a == b", lineStart: 2, lineEnd: 2 }], fixtureRequests: ["tmp_path"] } }),
  ], scope);

  assert.ok(observations.length > 0);
  for (const observation of observations) {
    assert.equal("status" in observation, false, "an observation has no status");
    assert.equal("updatedAt" in observation, false, "an observation has no mutation timestamp");
    assert.equal(observation.repo, "/repo");
    assert.equal(observation.extractor, "extractor.observations.v1");
  }
});

test("projection is deterministic and its identity ignores the revision", () => {
  const item = evidenceItem({ payload: { isTest: true, assertions: [{ text: "a == b", lineStart: 2, lineEnd: 2 }] } });

  assert.deepEqual(materializeObservations([item], scope), materializeObservations([item], scope));

  const first = materializeObservations([item], { repo: "/repo", revision: "rev-1" }).map((entry) => entry.id);
  const second = materializeObservations([item], { repo: "/repo", revision: "rev-2" }).map((entry) => entry.id);
  assert.deepEqual(first, second, "the same fact keeps one identity across revisions");
});

test("a command is never paired with an unrelated working directory", () => {
  const observations = materializeObservations([
    evidenceItem({
      id: "ev_ci",
      sourceType: "test_configuration",
      path: ".github/workflows/ci.yml",
      sourceRef: ".github/workflows/ci.yml:1",
      payload: {
        environmentProfile: {
          runCommands: ["python -m pytest -q"],
          workingDirectories: ["frontend"],
          runInstructions: [{ commandText: "python -m pytest -q" }],
          environmentVariableNames: [],
          serviceImages: [],
        },
      },
    }),
  ], scope);

  const runInstructions = observations.filter((entry) => entry.predicate === "documents_run_instruction");
  assert.equal(runInstructions.length, 1);
  assert.match(runInstructions[0].statement, /pytest/u);
  assert.doesNotMatch(runInstructions[0].statement, /frontend/u, "a stray directory must not attach to a command it did not come from");
});

test("fixtures and mocks are derived from observations, not from stored cards", async () => {
  // query() resolves the repo path, so stored evidence must carry the resolved form.
  const repo = resolve("/repo");
  const evidence = [
    evidenceItem({ id: "ev_test", repo, payload: { isTest: true, assertions: [{ text: "a == b", lineStart: 2, lineEnd: 2 }], fixtureRequests: ["tmp_path"], mocks: ["patch"] } }),
    evidenceItem({ id: "ev_fixture", repo, symbol: "tmp_path", payload: { isFixture: true, fixtureRequests: [] } }),
  ];
  const repository = {
    evidence: [],
    knowledge: [],
    async readEvidence() { return evidence.map((item) => ({ ...item })); },
    async readKnowledge() { return this.knowledge.map((item) => ({ ...item })); },
    async writeBuild(builtEvidence, cards) { this.evidence = builtEvidence; this.knowledge = cards; },
    async appendReview() {},
  };
  const index = { rebuild: async () => {}, search: async () => [] };
  const engine = new KnowledgeEngine(repository, index, [], { id: "rule", extract: async () => [] });
  await engine.build({ repo: "/repo", files: [{ path: "t.py", type: "test_code", text: "x" }], useLlm: false });

  // Observations are scoped the same way the rest of the pack is: by the request's targets.
  const pack = await engine.query({ repo: "/repo", revision: "rev", task: "add a test", changedFiles: [], targetSymbols: ["test_x"] });

  assert.ok(pack.observations.length > 0, "observations must be projected even when no knowledge cards were produced");
  assert.deepEqual(pack.knowledge, [], "the rule extractor produced no claims");
  assert.deepEqual(pack.fixturesAndMocks.fixtures, [...new Set(pack.observations.filter((entry) => entry.kind === "fixture").map((entry) => entry.subject))]);
  assert.deepEqual(pack.fixturesAndMocks.mocks, [...new Set(pack.observations.filter((entry) => entry.kind === "mock").map((entry) => entry.subject))]);
  assert.equal(repository.knowledge.length, 0, "querying must not persist a projected observation");
});
