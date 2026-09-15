import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";

export interface LlmResponseCache {
  get(key: string): Promise<string | undefined>;
  set(key: string, content: string): Promise<void>;
}

type CacheEntry = { key: string; content: string; createdAt: string };

/** Immutable, content-addressed files avoid cross-process cache index races. */
export class FileLlmResponseCache implements LlmResponseCache {
  constructor(private readonly directory: string) {}

  private path(key: string): string {
    if (!/^[a-f0-9]{64}$/u.test(key)) throw new Error("LLM cache key must be a SHA-256 digest");
    return join(this.directory, `${key}.json`);
  }

  async get(key: string): Promise<string | undefined> {
    try {
      const parsed = JSON.parse(await readFile(this.path(key), "utf8")) as Partial<CacheEntry>;
      return parsed.key === key && typeof parsed.content === "string" ? parsed.content : undefined;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT" || error instanceof SyntaxError) return undefined;
      throw error;
    }
  }

  async set(key: string, content: string): Promise<void> {
    await mkdir(this.directory, { recursive: true });
    const destination = this.path(key);
    const temporary = `${destination}.${process.pid}.${randomUUID()}.tmp`;
    const entry: CacheEntry = { key, content, createdAt: new Date().toISOString() };
    await writeFile(temporary, `${JSON.stringify(entry)}\n`, { encoding: "utf8", flag: "wx" });
    try {
      await rename(temporary, destination);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      await unlink(temporary).catch(() => undefined);
      if (code !== "EEXIST" && code !== "EPERM") throw error;
    }
  }
}
