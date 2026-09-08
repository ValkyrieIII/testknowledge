import { mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { Evidence, KnowledgeCard } from "@testknowledge/model";
import type { KnowledgeRepository, ReviewRecord } from "@testknowledge/core";

async function readJsonl<T>(path: string): Promise<T[]> {
  try {
    const content = await readFile(path, "utf8");
    return content.split("\n").filter(Boolean).map((line) => JSON.parse(line) as T);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
}

async function writeJsonlAtomic<T>(path: string, rows: T[]): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.${process.pid}.${Date.now()}.tmp`;
  const content = rows.map((row) => JSON.stringify(row)).join("\n");
  try {
    await writeFile(temporary, content ? `${content}\n` : "", "utf8");
    try {
      await rename(temporary, path);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== "EEXIST" && code !== "EPERM" && code !== "ENOTEMPTY") throw error;
      await unlink(path).catch((cleanupError) => {
        if ((cleanupError as NodeJS.ErrnoException).code !== "ENOENT") throw cleanupError;
      });
      await rename(temporary, path);
    }
  } catch (error) {
    await unlink(temporary).catch(() => undefined);
    throw error;
  }
}

export class JsonlRepository implements KnowledgeRepository {
  private readonly evidencePath: string;
  private readonly knowledgePath: string;
  private readonly reviewsPath: string;

  constructor(private readonly root: string) {
    this.evidencePath = join(root, "evidence.jsonl");
    this.knowledgePath = join(root, "knowledge.jsonl");
    this.reviewsPath = join(root, "reviews.jsonl");
  }

  async readEvidence(): Promise<Evidence[]> {
    return readJsonl<Evidence>(this.evidencePath);
  }

  async readKnowledge(): Promise<KnowledgeCard[]> {
    return readJsonl<KnowledgeCard>(this.knowledgePath);
  }

  async writeBuild(evidence: Evidence[], cards: KnowledgeCard[]): Promise<void> {
    const oldEvidence = await this.readEvidence();
    const byId = new Map([...oldEvidence, ...evidence].map((item) => [item.id, item]));
    await writeJsonlAtomic(this.evidencePath, [...byId.values()]);
    await writeJsonlAtomic(this.knowledgePath, cards);
  }

  async appendReview(record: ReviewRecord): Promise<void> {
    const records = await readJsonl<ReviewRecord>(this.reviewsPath);
    await writeJsonlAtomic(this.reviewsPath, [...records, record]);
  }
}
