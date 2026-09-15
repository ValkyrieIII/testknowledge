import assert from "node:assert/strict";
import { test } from "node:test";
import { LlmKnowledgeExtractor } from "../dist/llm-knowledge.js";
import { systemPromptFor } from "../dist/llm-prompts.js";

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

function fakeFetch(payload, capture, finishReason) {
  return async (url, init) => {
    if (capture) capture(JSON.parse(init.body));
    return {
      ok: true,
      status: 200,
      json: async () => ({ choices: [{ message: { content: JSON.stringify(payload) }, finish_reason: finishReason }] }),
    };
  };
}

function extractor(payload, capture, finishReason) {
  return new LlmKnowledgeExtractor({ baseUrl: "http://example.test/v1/", apiKey: "key", model: "model", fetch: fakeFetch(payload, capture, finishReason) });
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

const SHARD = {
  id: "sh_test",
  kind: "behavior",
  subject: "t.py",
  evidenceIds: ["ev_1", "ev_2"],
  maxOutputTokens: 1740,
  estimatedInputTokens: 100,
};

test("produces one behaviour card citing multiple evidence items", async () => {
  const result = await extractor({ cards: [CARD] }).extract(EVIDENCE, scope);
  assert.equal(result.drafts.length, 1);
  assert.deepEqual(result.drafts[0]?.evidenceIds, ["ev_1", "ev_2"]);
  assert.equal(result.drafts[0]?.path, "t.py");
  assert.equal(result.drafts[0]?.symbol, "test_missing");
  assert.equal(result.drafts[0]?.confidence, 0.6);
});

test("drops cards that cite unknown evidence", async () => {
  const result = await extractor({ cards: [{ ...CARD, evidenceIds: ["ev_missing"] }] }).extract(EVIDENCE, scope);
  assert.equal(result.drafts.length, 0);
});

test("drops cards missing required fields", async () => {
  const result = await extractor({ cards: [{ ...CARD, statement: "" }] }).extract(EVIDENCE, scope);
  assert.equal(result.drafts.length, 0);
});

test("falls back to a default risk and kind", async () => {
  const result = await extractor({ cards: [{ ...CARD, kind: "nonsense", risk: "" }] }).extract(EVIDENCE, scope);
  assert.equal(result.drafts[0]?.kind, "behavior");
  assert.match(result.drafts[0]?.risk ?? "", /人工审核/u);
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
  const result = await instance.extract([], scope);
  assert.equal(called, false);
  assert.equal(result.drafts.length, 0);
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

test("a shard call uses the shard's own output budget and its kind's instruction set", async () => {
  let body;
  const result = await extractor({ cards: [CARD] }, (captured) => {
    body = captured;
  }).extractShard(SHARD, EVIDENCE, scope);

  assert.equal(body.max_tokens, SHARD.maxOutputTokens, "the shard budget replaces the global cap");
  assert.match(body.messages[0].content, /BEHAVIOUR knowledge/u, "a shard gets the per-kind prompt, not the generic one");
  assert.doesNotMatch(body.messages[0].content, /the most fitting kind/u);
  assert.equal(result.drafts.length, 1);
});

test("a truncated shard response is bisected once instead of retried unchanged", async () => {
  let calls = 0;
  const instance = new LlmKnowledgeExtractor({
    baseUrl: "http://example.test/v1/",
    apiKey: "key",
    model: "model",
    fetch: async () => {
      calls += 1;
      if (calls === 1) {
        return { ok: true, status: 200, json: async () => ({ choices: [{ message: { content: "{\"cards\":[" }, finish_reason: "length" }] }) };
      }
      const id = calls === 2 ? "ev_1" : "ev_2";
      return {
        ok: true,
        status: 200,
        json: async () => ({ choices: [{ message: { content: JSON.stringify({ cards: [{ ...CARD, evidenceIds: [id] }] }) }, finish_reason: "stop" }] }),
      };
    },
  });

  const result = await instance.extractShard(SHARD, EVIDENCE, scope);
  assert.equal(calls, 3, "one truncated call plus one call per half");
  assert.equal(result.drafts.length, 2, "both halves contribute");
  assert.deepEqual(result.drafts.map((draft) => draft.evidenceIds[0]).sort(), ["ev_1", "ev_2"]);
});

test("a single-evidence shard propagates truncation rather than bisecting forever", async () => {
  let calls = 0;
  const instance = new LlmKnowledgeExtractor({
    baseUrl: "http://example.test/v1/",
    apiKey: "key",
    model: "model",
    fetch: async () => {
      calls += 1;
      return { ok: true, status: 200, json: async () => ({ choices: [{ message: { content: "{\"cards\":[" }, finish_reason: "length" }] }) };
    },
  });

  await assert.rejects(instance.extractShard({ ...SHARD, evidenceIds: ["ev_1"] }, [EVIDENCE[0]], scope), /cut off|not valid JSON/u);
  assert.equal(calls, 1);
});

test("a truncation that produced no text is not bisected", async () => {
  let calls = 0;
  const instance = new LlmKnowledgeExtractor({
    baseUrl: "http://example.test/v1/",
    apiKey: "key",
    model: "model",
    fetch: async () => {
      calls += 1;
      return { ok: true, status: 200, json: async () => ({ choices: [{ message: { content: "" }, finish_reason: "length" }] }) };
    },
  });

  await assert.rejects(instance.extractShard(SHARD, EVIDENCE, scope), /cut off/u);
  assert.equal(calls, 1, "splitting cannot help when the budget was spent before any output — a reasoning model's hidden tokens");
});

test("bisection keeps the half that did succeed", async () => {
  let calls = 0;
  const instance = new LlmKnowledgeExtractor({
    baseUrl: "http://example.test/v1/",
    apiKey: "key",
    model: "model",
    fetch: async () => {
      calls += 1;
      if (calls === 2) {
        return { ok: true, status: 200, json: async () => ({ choices: [{ message: { content: JSON.stringify({ cards: [{ ...CARD, evidenceIds: ["ev_1"] }] }) }, finish_reason: "stop" }] }) };
      }
      return { ok: true, status: 200, json: async () => ({ choices: [{ message: { content: "{\"cards\":[" }, finish_reason: "length" }] }) };
    },
  });

  const result = await instance.extractShard(SHARD, EVIDENCE, scope);
  assert.equal(calls, 3, "one truncated call plus one call per half");
  assert.equal(result.drafts.length, 1, "the successful half must not be discarded because its sibling failed");
  assert.deepEqual(result.drafts[0]?.evidenceIds, ["ev_1"]);
});

test("a singular toolCall is recognised as a read request", async () => {
  const instance = new LlmKnowledgeExtractor({
    baseUrl: "http://example.test/v1/",
    apiKey: "key",
    model: "model",
    fetch: async () => ({
      ok: true,
      status: 200,
      json: async () => ({ choices: [{ message: { content: JSON.stringify({ toolCall: { tool: "read", target: "src/one.py" } }) }, finish_reason: "stop" }] }),
    }),
  });

  const step = await instance.step([]);
  assert.deepEqual(step.toolCalls, [{ tool: "read", target: "src/one.py" }], "mistaking this for a final answer ends the loop and silently yields nothing");
  assert.equal(step.content, undefined);
});

test("an answer carrying neither cards nor clusters fails loudly", async () => {
  const instance = new LlmKnowledgeExtractor({
    baseUrl: "http://example.test/v1/",
    apiKey: "key",
    model: "model",
    fetch: async () => ({
      ok: true,
      status: 200,
      json: async () => ({ choices: [{ message: { content: JSON.stringify({ note: "nothing to report" }) }, finish_reason: "stop" }] }),
    }),
  });

  await assert.rejects(instance.extractShard(SHARD, EVIDENCE, scope), /neither cards nor clusters/u);
});

test("a gateway error page is not mistaken for a truncated answer", async () => {
  let calls = 0;
  const instance = new LlmKnowledgeExtractor({
    baseUrl: "http://example.test/v1/",
    apiKey: "key",
    model: "model",
    fetch: async () => {
      calls += 1;
      return { ok: true, status: 200, json: async () => ({ choices: [{ message: { content: "<html><body>502 Bad Gateway</body></html>" }, finish_reason: "stop" }] }) };
    },
  });

  await assert.rejects(instance.extractShard(SHARD, EVIDENCE, scope), /was not JSON/u);
  assert.equal(calls, 1, "a non-JSON body must not be bisected: splitting pays for the same failure twice");
});

test("an agentic run is cached together with what it read", async () => {
  const store = new Map();
  let calls = 0;
  const instance = new LlmKnowledgeExtractor({
    baseUrl: "http://example.test/v1/",
    apiKey: "key",
    model: "model",
    cache: { get: async (key) => store.get(key), set: async (key, value) => { store.set(key, value); } },
    fetch: async () => {
      calls += 1;
      return { ok: true, status: 200, json: async () => ({ choices: [{ message: { content: JSON.stringify({ cards: [CARD] }) }, finish_reason: "stop" }] }) };
    },
  });

  const run = { content: JSON.stringify({ cards: [CARD] }), readLog: [{ tool: "read", target: "src/one.py", contentHash: "h", evidenceId: "ev_tool" }], evidence: [] };
  await instance.saveRun(SHARD, EVIDENCE, run);

  assert.deepEqual(await instance.loadRun(SHARD, EVIDENCE), run, "the read log survives the round trip");
  assert.equal(calls, 0, "a replay must not call the model");
});

test("the agentic run cache key ignores what the model chose to read", async () => {
  const keys = [];
  const instance = new LlmKnowledgeExtractor({
    baseUrl: "http://example.test/v1/",
    apiKey: "key",
    model: "model",
    cache: { get: async (key) => { keys.push(key); return undefined; }, set: async () => {} },
    fetch: async () => ({ ok: true, status: 200, json: async () => ({ choices: [{ message: { content: "{}" }, finish_reason: "stop" }] }) }),
  });

  await instance.loadRun(SHARD, EVIDENCE);
  await instance.loadRun(SHARD, EVIDENCE);
  assert.equal(keys[0], keys[1], "the same shard and evidence must produce the same key");
  assert.equal(typeof keys[0], "string");
});

test("a change in how evidence is summarised misses the cache", async () => {
  const keys = [];
  const instance = new LlmKnowledgeExtractor({
    baseUrl: "http://example.test/v1/",
    apiKey: "key",
    model: "model",
    cache: { get: async (key) => { keys.push(key); return undefined; }, set: async () => {} },
    fetch: async () => ({ ok: true, status: 200, json: async () => ({ choices: [{ message: { content: "{}" }, finish_reason: "stop" }] }) }),
  });

  // Same evidence ids and same source file hash, different published content — exactly the shape
  // of an adapter fix that leaves the underlying file untouched.
  await instance.loadRun(SHARD, EVIDENCE);
  await instance.loadRun(SHARD, [{ ...EVIDENCE[0], content: "summarised differently" }, EVIDENCE[1]]);
  assert.notEqual(keys[0], keys[1], "keying on the source hash alone would replay a stale answer after an adapter change");
});

test("per-kind prompts differ while keeping the shared grounding invariants", () => {
  const behavior = systemPromptFor("behavior");
  const environment = systemPromptFor("environment");
  assert.notEqual(behavior, environment);
  for (const prompt of [behavior, environment]) {
    assert.match(prompt, /not present in the cited evidence/i);
    assert.match(prompt, /MUST cite existing evidence ids exactly/u);
  }
  assert.match(environment, /working director/iu);
});

test("an agentic turn returns the read the model asked for, then the final answer", async () => {
  let calls = 0;
  const instance = new LlmKnowledgeExtractor({
    baseUrl: "http://example.test/v1/",
    apiKey: "key",
    model: "model",
    fetch: async () => {
      calls += 1;
      const content = calls === 1
        ? JSON.stringify({ toolCalls: [{ tool: "read", target: "src/one.py" }] })
        : JSON.stringify({ cards: [CARD] });
      return { ok: true, status: 200, json: async () => ({ choices: [{ message: { content }, finish_reason: "stop" }] }) };
    },
  });

  const messages = instance.beginShard(SHARD, EVIDENCE);
  assert.match(messages[0].content, /toolCalls/u, "the opening prompt advertises the tool protocol");

  const request = await instance.step(messages);
  assert.deepEqual(request.toolCalls, [{ tool: "read", target: "src/one.py" }]);
  assert.equal(request.content, undefined);

  const answer = await instance.step(messages);
  assert.equal(answer.toolCalls, undefined);
  assert.equal(instance.finishShard(SHARD, EVIDENCE, answer.content).drafts.length, 1);
});

test("a malformed tool request is treated as a final answer instead of a read", async () => {
  const instance = new LlmKnowledgeExtractor({
    baseUrl: "http://example.test/v1/",
    apiKey: "key",
    model: "model",
    fetch: async () => ({
      ok: true,
      status: 200,
      json: async () => ({ choices: [{ message: { content: JSON.stringify({ toolCalls: [{ tool: "shell", target: "rm -rf /" }] }) }, finish_reason: "stop" }] }),
    }),
  });

  const step = await instance.step([]);
  assert.equal(step.toolCalls, undefined, "an unknown tool is not executed");
  assert.ok(step.content, "the response is still handed back for parsing");
});
