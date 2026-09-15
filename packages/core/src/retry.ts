/** Raised when a model response is cut off by the output budget, so callers can bisect instead of retrying blind. */
export class LlmTruncationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "LlmTruncationError";
  }
}

/** A transport or capacity failure worth retrying. Terminal errors (bad request, auth, unknown route) are not. */
export function isRetryable(error: unknown): boolean {
  if (error instanceof LlmTruncationError) return false;
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
