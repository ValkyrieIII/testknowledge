import assert from "node:assert/strict";
import { test } from "node:test";
import { LlmResponseFormatError, LlmTruncationError, isRetryable, withBackoff } from "../dist/index.js";

test("a retryable failure is retried with backoff and can succeed", async () => {
  const slept = [];
  let attempts = 0;
  const result = await withBackoff(async (attempt) => {
    attempts = attempt;
    if (attempt < 3) throw new Error("LLM request failed: 429");
    return "ok";
  }, { sleep: async (ms) => { slept.push(ms); }, random: () => 1, jitter: false });

  assert.equal(result, "ok");
  assert.equal(attempts, 3);
  assert.deepEqual(slept, [500, 1000], "backoff doubles between attempts");
});

test("a terminal failure is not retried", async () => {
  const slept = [];
  let calls = 0;
  await assert.rejects(
    withBackoff(async () => {
      calls += 1;
      throw new Error("LLM request failed: 401");
    }, { sleep: async (ms) => { slept.push(ms); } }),
    /401/u,
  );

  assert.equal(calls, 1, "an unauthorized request cannot succeed on retry");
  assert.deepEqual(slept, []);
});

test("retry classification separates transient from terminal", () => {
  assert.equal(isRetryable(new Error("LLM request failed: 500")), true);
  assert.equal(isRetryable(new Error("LLM request failed: 503")), true);
  assert.equal(isRetryable(new Error("LLM request failed: 429")), true);
  assert.equal(isRetryable(new Error("LLM request failed: 400")), false);
  assert.equal(isRetryable(new Error("LLM request failed: 422")), false);
  assert.equal(isRetryable(new TypeError("fetch failed")), true);
  assert.equal(isRetryable(new LlmTruncationError("cut off mid-answer", true)), false, "that case is bisected, not retried");
  assert.equal(isRetryable(new LlmTruncationError("cut off before any output", false)), true, "that case needs more room, so retrying it can succeed");
  assert.equal(isRetryable(new LlmResponseFormatError("gateway returned an HTML page")), true, "a gateway error page is transient");
});

test("attempts are exhausted when the failure never clears", async () => {
  let calls = 0;
  await assert.rejects(
    withBackoff(async () => {
      calls += 1;
      throw new Error("LLM request failed: 500");
    }, { maxAttempts: 2, sleep: async () => {} }),
    /500/u,
  );
  assert.equal(calls, 2);
});
