import assert from "node:assert/strict";
import { test } from "node:test";
import { LlmKnowledgeExtractor } from "../dist/llm-knowledge.js";

const scope = { repo: "/repo", revision: "rev" };

const EVIDENCE = [
  {
    id: "ev_1",
    sourceType: "test_code",
    sourceRef: "t.py:1",
    repo: "/repo",
    revision: "rev",
    path: "t.py",
    symbol: "test_missing",
    lineStart: 1,
    lineEnd: 3,
    contentHash: "h1",
    payload: { assertions: [{ text: "result is None", lineStart: 2, lineEnd: 2 }] },
  },
  {
    id: "ev_2",
    sourceType: "test_code",
    sourceRef: "t.py:5",
    repo: "/repo",
    revision: "rev",
    path: "t.py",
    symbol: "test_not_found",
    lineStart: 5,
    lineEnd: 7,
    contentHash: "h2",
    payload: { assertions: [{ text: "result is None", lineStart: 6, lineEnd: 6 }] },
  },
];

function fakeFetch(payload, capture) {
  return async (url, init) => {
    if (capture) capture(JSON.parse(init.body));
    return {
      ok: true,
      status: 200,
      json: async () => ({ choices: [{ message: { content: JSON.stringify(payload) } }] }),
    };
  };
}

function extractor(payload, capture) {
  return new LlmKnowledgeExtractor({ baseUrl: "http://example.test/v1/", apiKey: "key", model: "model", fetch: fakeFetch(payload, capture) });
}

const CARD = {
  title: "get_key 缺失时返回 None",
  statement: "get_key 在键或文件不存在时返回 None",
  trigger: "需要判断键是否存在时",
  expectedBehavior: "返回 None",
  oracle: "result is None",
  risk: "",
  kind: "behavior",
  evidenceIds: ["ev_1", "ev_2"],
  confidence: 0.6,
};

test("produces one behaviour card citing multiple evidence items", async () => {
  const drafts = await extractor({ cards: [CARD] }).extract(EVIDENCE, scope);
  assert.equal(drafts.length, 1);
  assert.deepEqual(drafts[0]?.evidenceIds, ["ev_1", "ev_2"]);
  assert.equal(drafts[0]?.path, "t.py");
  assert.equal(drafts[0]?.symbol, "test_missing");
  assert.equal(drafts[0]?.confidence, 0.6);
});

test("drops cards that cite unknown evidence", async () => {
  const drafts = await extractor({ cards: [{ ...CARD, evidenceIds: ["ev_missing"] }] }).extract(EVIDENCE, scope);
  assert.equal(drafts.length, 0);
});

test("drops cards missing required fields", async () => {
  const drafts = await extractor({ cards: [{ ...CARD, statement: "" }] }).extract(EVIDENCE, scope);
  assert.equal(drafts.length, 0);
});

test("falls back to a default risk and kind", async () => {
  const drafts = await extractor({ cards: [{ ...CARD, kind: "nonsense", risk: "" }] }).extract(EVIDENCE, scope);
  assert.equal(drafts[0]?.kind, "behavior");
  assert.match(drafts[0]?.risk ?? "", /人工审核/);
});

test("does not call the model when there is no evidence", async () => {
  let called = false;
  const instance = new LlmKnowledgeExtractor({
    baseUrl: "http://example.test/v1/",
    apiKey: "key",
    model: "model",
    fetch: async () => {
      called = true;
      throw new Error("should not be called");
    },
  });
  const drafts = await instance.extract([], scope);
  assert.equal(called, false);
  assert.equal(drafts.length, 0);
});

test("sends the evidence facts to the model", async () => {
  let body;
  await extractor({ cards: [] }, (captured) => {
    body = captured;
  }).extract(EVIDENCE, scope);
  assert.match(body.messages[1].content, /result is None/);
  assert.match(body.messages[1].content, /test_missing/);
  assert.match(body.messages[0].content, /not present in the cited evidence/i);
});
