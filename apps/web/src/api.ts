/** Keep HTTP failures readable, including non-JSON proxy errors. */
export async function requestJson<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(path, init);
  if (!response.ok) {
    const body: unknown = await response.json().catch(() => null);
    const message = body && typeof body === "object" && "error" in body && typeof body.error === "string"
      ? body.error : `请求失败（HTTP ${response.status}），请检查 API 服务后重试。`;
    throw new Error(message);
  }
  return await response.json() as T;
}

export function errorMessage(cause: unknown): string {
  return cause instanceof Error ? cause.message : "请求未完成，请稍后重试。";
}
