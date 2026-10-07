import { mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { ExecutionRunSchema, KnowledgeCardSchema, KnowledgeChangeSchema, ProjectMapSchema, RunItemSchema, type Evidence, type EvidenceCluster, type ExecutionRun, type KnowledgeCard, type KnowledgeChange, type KnowledgeRelation, type ProjectMap, type RunItem } from "@testknowledge/model";
import type { ClusterReviewRecord, KnowledgeRepository, ReviewRecord } from "@testknowledge/core";

/** Ledgers are read-all-then-rewrite, so retention bounds the rewrite cost. Oldest rows are dropped first. */
const RUN_RETENTION = 5000;
const RUN_ITEM_RETENTION = 20000;

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
  private readonly clustersPath: string;
  private readonly clusterReviewsPath: string;
  private readonly relationsPath: string;
  private readonly knowledgeChangesPath: string;
  private readonly runsPath: string;
  private readonly runItemsPath: string;
  private readonly projectMapsPath: string;

  constructor(private readonly root: string) {
    this.evidencePath = join(root, "evidence.jsonl");
    this.knowledgePath = join(root, "knowledge.jsonl");
    this.reviewsPath = join(root, "reviews.jsonl");
    this.clustersPath = join(root, "clusters.jsonl");
    this.clusterReviewsPath = join(root, "cluster-reviews.jsonl");
    this.relationsPath = join(root, "relations.jsonl");
    this.knowledgeChangesPath = join(root, "knowledge-changes.jsonl");
    this.runsPath = join(root, "runs.jsonl");
    this.runItemsPath = join(root, "run-items.jsonl");
    this.projectMapsPath = join(root, "project-maps.jsonl");
  }

  async readEvidence(): Promise<Evidence[]> {
    return readJsonl<Evidence>(this.evidencePath);
  }

  async readKnowledge(): Promise<KnowledgeCard[]> {
    return (await readJsonl<unknown>(this.knowledgePath)).map((row) => KnowledgeCardSchema.parse(row));
  }

  async readClusters(): Promise<EvidenceCluster[]> {
    return readJsonl<EvidenceCluster>(this.clustersPath);
  }

  async readRelations(): Promise<KnowledgeRelation[]> {
    return readJsonl<KnowledgeRelation>(this.relationsPath);
  }

  async readKnowledgeChanges(): Promise<KnowledgeChange[]> {
    return (await readJsonl<unknown>(this.knowledgeChangesPath)).map((row) => KnowledgeChangeSchema.parse(row));
  }

  async writeBuild(evidence: Evidence[], cards: KnowledgeCard[], relations?: KnowledgeRelation[], clusters?: EvidenceCluster[]): Promise<void> {
    const oldEvidence = await this.readEvidence();
    const byId = new Map([...oldEvidence, ...evidence].map((item) => [item.id, item]));
    await writeJsonlAtomic(this.evidencePath, [...byId.values()]);
    await writeJsonlAtomic(this.knowledgePath, cards);
    if (relations) await writeJsonlAtomic(this.relationsPath, relations);
    if (clusters) await writeJsonlAtomic(this.clustersPath, clusters);
  }

  async appendReview(record: ReviewRecord): Promise<void> {
    const records = await readJsonl<ReviewRecord>(this.reviewsPath);
    await writeJsonlAtomic(this.reviewsPath, [...records, record]);
  }

  async appendClusterReview(record: ClusterReviewRecord): Promise<void> {
    const records = await readJsonl<ClusterReviewRecord>(this.clusterReviewsPath);
    await writeJsonlAtomic(this.clusterReviewsPath, [...records, record]);
  }

  async appendKnowledgeChanges(records: KnowledgeChange[]): Promise<void> {
    if (records.length === 0) return;
    const existing = await this.readKnowledgeChanges();
    await writeJsonlAtomic(this.knowledgeChangesPath, [...existing, ...records]);
  }

  async readRuns(): Promise<ExecutionRun[]> {
    return (await readJsonl<unknown>(this.runsPath)).map((row) => ExecutionRunSchema.parse(row));
  }

  async appendRun(record: ExecutionRun): Promise<void> {
    const existing = await this.readRuns();
    if (existing.some((item) => item.id === record.id)) return;
    await writeJsonlAtomic(this.runsPath, [...existing, record].slice(-RUN_RETENTION));
  }

  async readRunItems(runId?: string): Promise<RunItem[]> {
    const items = (await readJsonl<unknown>(this.runItemsPath)).map((row) => RunItemSchema.parse(row));
    return runId ? items.filter((item) => item.runId === runId) : items;
  }

  async appendRunItems(records: RunItem[]): Promise<void> {
    if (records.length === 0) return;
    const existing = await this.readRunItems();
    const byId = new Map(existing.map((item) => [item.id, item]));
    for (const record of records) byId.set(record.id, record);
    await writeJsonlAtomic(this.runItemsPath, [...byId.values()].slice(-RUN_ITEM_RETENTION));
  }

  async readProjectMaps(): Promise<ProjectMap[]> {
    return (await readJsonl<unknown>(this.projectMapsPath)).map((row) => ProjectMapSchema.parse(row));
  }

  async writeProjectMaps(maps: ProjectMap[]): Promise<void> {
    await writeJsonlAtomic(this.projectMapsPath, maps);
  }
}
