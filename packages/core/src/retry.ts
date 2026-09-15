/**
 * Raised when a model response is cut off by the output budget.
 *
 * `contentPresent` separates two cases that need opposite responses. A response that produced
 * text before running out can be bisected, because half the input fits. A response that produced
 * nothing burned the whole budget elsewhere — a reasoning model spending it on hidden thinking —
 * and splitting the shard only pays that cost twice.
 */
export class LlmTruncationError extends Error {
  readonly contentPresent: boolean;

  constructor(message: string, contentPresent = true) {
    super(message);
    this.name = "LlmTruncationError";
    this.contentPresent = contentPresent;
  }
}

/**
 * The endpoint answered with something that is not JSON at all.
 *
 * A gateway or proxy error page arrives with a success status, so it looks like a model reply
 * until it is parsed. It is transient and worth retrying, and it must never be mistaken for a
 * truncated answer: bisecting would split the shard and pay for the same failure again.
 */
export class LlmResponseFormatError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "LlmResponseFormatError";
  }
}

/** A transport or capacity failure worth retrying. Terminal errors (bad request, auth, unknown route) are not. */
export function isRetryable(error: unknown): boolean {
  // A response cut off *before* writing anything ran out of allowance, not input: retrying with
  // more room can succeed. One cut off mid-answer is an input-size problem and is bisected
  // instead, so it must not be retried unchanged.
  if (error instanceof LlmTruncationError) return !error.contentPresent;
  if (error instanceof LlmResponseFormatError) return true;
  if (error instanceof TypeError) return true;
  const message = error instanceof Error ? error.message : String(error);
  if (/timeout|timed out|ETIMEDOUT|ECONNRESET|ECONNREFUSED|EAI_AGAIN|socket hang up/iu.test(message)) return true;
  const status = /\b(\d{3})\b/u.exec(message);
  if (status) {
    const code = Number(status[1]);
    return code === 408 || code === 425 || code === 429 || (code >= 500 && code < 600);
  }
  return false;
}

export type BackoffOptions = {
  maxAttempts?: number;
  baseMs?: number;
  capMs?: number;
  jitter?: boolean;
  sleep?: (ms: number) => Promise<void>;
  random?: () => number;
};

const defaultSleep = (ms: number): Promise<void> => new Promise((resolve) => { setTimeout(resolve, ms); });

/**
 * Retry a transient failure with exponential backoff.
 *
 * Terminal errors are rethrown on the first attempt: retrying a rejected request or an
 * exhausted quota only burns budget, it cannot succeed.
 */
export async function withBackoff<T>(operation: (attempt: number) => Promise<T>, options: BackoffOptions = {}): Promise<T> {
  const maxAttempts = options.maxAttempts ?? 3;
  const baseMs = options.baseMs ?? 500;
  const capMs = options.capMs ?? 8000;
  const sleep = options.sleep ?? defaultSleep;
  const random = options.random ?? Math.random;

  let lastError: unknown;
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      return await operation(attempt);
    } catch (error) {
      lastError = error;
      if (attempt === maxAttempts || !isRetryable(error)) throw error;
      const exponential = Math.min(capMs, baseMs * 2 ** (attempt - 1));
      await sleep(options.jitter === false ? exponential : Math.round(exponential * (0.5 + random() * 0.5)));
    }
  }
  throw lastError;
}
