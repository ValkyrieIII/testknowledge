import assert from "node:assert/strict";
import { test } from "node:test";
import { RuleCandidateExtractor } from "../dist/rule-extractor.js";

const scope = { repo: "/repo", revision: "rev" };

function evidence(payload) {
  return [
    {
      id: "ev_1",
      sourceType: "test_code",
      sourceRef: "t.py:1",
      repo: "/repo",
      revision: "rev",
      path: "t.py",
      symbol: "test_x",
      lineStart: 1,
      lineEnd: 1,
      contentHash: "hash",
      payload,
    },
  ];
}

function draftsFor(payload) {
  return new RuleCandidateExtractor().extract(evidence(payload), scope);
}

const base = { isTest: true, assertions: [], fixtureRequests: [], mocks: [], withBlocks: [], tryHandlers: [], decorators: [] };

test("an exception-only test now produces a card", async () => {
  const drafts = await draftsFor({
    ...base,
    withBlocks: [{ call: "pytest.raises", args: ["ValueError"], literals: [], lineStart: 2, lineEnd: 2 }],
  });
  assert.equal(drafts.length, 1);
  assert.equal(drafts[0]?.kind, "behavior");
  assert.match(drafts[0]?.statement ?? "", /期望异常：ValueError/);
  assert.match(drafts[0]?.oracle ?? "", /ValueError/);
});

test("try/except handlers are recorded", async () => {
  const drafts = await draftsFor({
    ...base,
    tryHandlers: [{ exceptionTypes: ["TypeError", "KeyError"], lineStart: 3, lineEnd: 3 }],
  });
  assert.equal(drafts.length, 1);
  assert.match(drafts[0]?.statement ?? "", /期望异常：TypeError、KeyError/);
});

test("parametrize values stay visible on the card", async () => {
  const drafts = await draftsFor({
    ...base,
    assertions: [{ text: "parse(value) >= 0", lineStart: 5, lineEnd: 5 }],
    fixtureRequests: ["value"],
    decorators: [
      {
        name: "pytest.mark.parametrize",
        args: ['"value"', "[0, 1, 100, -1]"],
        literals: ["value", [0, 1, 100, -1]],
        text: '@pytest.mark.parametrize("value", [0, 1, 100, -1])',
      },
    ],
  });
  assert.equal(drafts.length, 1);
  assert.match(drafts[0]?.statement ?? "", /参数化：@pytest\.mark\.parametrize/);
});

test("a test with no signals still produces no card", async () => {
  assert.equal((await draftsFor(base)).length, 0);
});

test("assertion-only cards keep the assertion as oracle", async () => {
  const drafts = await draftsFor({ ...base, assertions: [{ text: "a == b", lineStart: 2, lineEnd: 2 }] });
  assert.equal(drafts[0]?.kind, "assertion");
  assert.equal(drafts[0]?.oracle, "a == b");
});

test("fixture dependencies no longer mislabel the kind as fixture", async () => {
  const drafts = await draftsFor({ ...base, assertions: [{ text: "result is None", lineStart: 2, lineEnd: 2 }], fixtureRequests: ["tmp_path"] });
  assert.equal(drafts[0]?.kind, "behavior");
});

test("observed facts are structured separately from the statement", async () => {
  const drafts = await draftsFor({
    ...base,
    assertions: [{ text: "result is None", lineStart: 2, lineEnd: 2 }],
    fixtureRequests: ["tmp_path"],
    withBlocks: [{ call: "pytest.raises", args: ["ValueError"], literals: [], lineStart: 3, lineEnd: 3 }],
    mocks: ["patch"],
  });
  assert.deepEqual(drafts[0]?.observed, {
    assertions: ["result is None"],
    expectedExceptions: ["ValueError"],
    mocks: ["patch"],
    dependencies: ["tmp_path"],
    parametrize: [],
  });
});
