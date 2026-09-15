import { createHash } from "node:crypto";
import type { Evidence, KnowledgeKind } from "@testknowledge/model";
import type { CandidateExtractor, ExtractionShard, ShardedCandidateExtractor } from "./ports.js";

/**
 * Shard planning: decide which evidence goes to which extraction call, and how much output
 * each call may produce.
 *
 * The pipeline used to send every evidence item in the repository in one prompt with a single
 * output cap. On the real repository that measured 265k characters in one request against a
 * 4000-token response budget, so most of the input could never be reflected in the output.
 * Partitioning up front keeps each call's input bounded and lets its output budget follow the
 * amount of work it was actually given.
 */

/** Input ceiling per shard. Keeps a shard inside a normal context window with room for the response. */
export const MAX_SHARD_INPUT_TOKENS = 24000;

/** Character allowance per evidence item, by the kind of knowledge that item can support. */
const EXCERPT_CHARS: Record<KnowledgeKind, number> = {
  fixture: 2000,
  mock: 2000,
  assertion: 2000,
  boundary: 2000,
  behavior: 2000,
  execution_recipe: 3000,
  environment: 4000,
  historical_bug: 6000,
};

/** Output budget floor per kind, before the per-item allowance. */
const OUTPUT_BASE: Record<KnowledgeKind, number> = {
  fixture: 800,
  mock: 800,
  assertion: 1200,
  behavior: 1600,
  boundary: 1500,
  execution_recipe: 1200,
  historical_bug: 1400,
  environment: 1200,
};

const OUTPUT_PER_ITEM = 140;
const OUTPUT_MIN = 600;
const OUTPUT_MAX = 4000;

/** Approximate token count. Deliberately conservative; this is a guard, not an accounting figure. */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 2.5);
}

export function excerptLimit(kind: KnowledgeKind): number {
  return EXCERPT_CHARS[kind];
}

export function outputBudget(kind: KnowledgeKind, itemCount: number): number {
  const raw = OUTPUT_BASE[kind] + OUTPUT_PER_ITEM * itemCount;
  return Math.max(OUTPUT_MIN, Math.min(OUTPUT_MAX, raw));
}

/**
 * The kind of knowledge an evidence item can support. One item belongs to one shard, so the
 * order below is a priority: a defect report is never treated as a mere test observation.
 */
export function kindOfEvidence(item: Evidence): KnowledgeKind {
  const payload = item.payload ?? {};
  if (item.sourceType === "issue" || item.sourceType === "bug_history") return "historical_bug";
  if (item.sourceType === "test_configuration") return "environment";
  if (payload.isFixture === true) return "fixture";
  if (payload.isTest === true) {
    const mocks = Array.isArray(payload.mocks) ? payload.mocks : [];
    if (mocks.length > 0) return "mock";
    const parametrize = Array.isArray(payload.parametrize) ? payload.parametrize : [];
    if (parametrize.some((value) => typeof value === "string" && /(?:^|[^\w])-?1(?:[^\w]|$)|(?:^|[^\w])0(?:[^\w]|$)|\bNone\b|["']{2}/u.test(value))) return "boundary";
    if (Array.isArray(payload.assertions) && payload.assertions.length > 0) return "behavior";
    if (Array.isArray(payload.expectedExceptions) && payload.expectedExceptions.length > 0) return "behavior";
    return "assertion";
  }
  return "behavior";
}

/** Groups a shard by its top-level directory, or by symbol when paths are flat. */
export function subjectOf(item: Evidence): string {
  const separator = item.path.indexOf("/");
  if (separator > 0) return item.path.slice(0, separator);
  return item.symbol !== "" ? item.symbol : item.path;
}

function itemCost(item: Evidence, kind: KnowledgeKind): number {
  const limit = EXCERPT_CHARS[kind];
  const content = typeof item.content === "string" ? item.content : "";
  const payload = JSON.stringify(item.payload ?? {});
  return estimateTokens(content.slice(0, limit)) + estimateTokens(payload.slice(0, limit));
}

function makeShard(repo: string, kind: KnowledgeKind, subject: string, items: Evidence[]): ExtractionShard {
  const evidenceIds = items.map((item) => item.id);
  const key = JSON.stringify({ repo, kind, subject, evidenceIds });
  return {
    id: `sh_${createHash("sha256").update(key).digest("hex").slice(0, 24)}`,
    kind,
    subject,
    evidenceIds,
    maxOutputTokens: outputBudget(kind, items.length),
    estimatedInputTokens: items.reduce((total, item) => total + itemCost(item, kind), 0),
  };
}

/**
 * Partition evidence into extraction shards.
 *
 * Shards are grouped by kind first and subject second, then split again whenever a group would
 * exceed the input ceiling, so a large module cannot produce an unbounded prompt. Ordering is
 * fully determined by the input, which keeps a build reproducible.
 */
export function planExtractionShards(evidence: Evidence[], options: { repo: string }): ExtractionShard[] {
  const groups = new Map<string, Evidence[]>();
  for (const item of evidence) {
    const key = `${kindOfEvidence(item)}\u0000${subjectOf(item)}`;
    groups.set(key, [...(groups.get(key) ?? []), item]);
  }

  const shards: ExtractionShard[] = [];
  for (const key of [...groups.keys()].sort()) {
    const [kind, subject] = key.split("\u0000") as [KnowledgeKind, string];
    const items = [...(groups.get(key) ?? [])].sort((left, right) => left.id.localeCompare(right.id));
    let current: Evidence[] = [];
    let currentTokens = 0;
    const flush = (): void => {
      if (current.length === 0) return;
      shards.push(makeShard(options.repo, kind, subject, current));
      current = [];
      currentTokens = 0;
    };
    for (const item of items) {
      const cost = itemCost(item, kind);
      if (current.length > 0 && currentTokens + cost > MAX_SHARD_INPUT_TOKENS) flush();
      current.push(item);
      currentTokens += cost;
    }
    flush();
  }
  return shards;
}

/** Split one shard in half, used when a response was cut off by the output budget. */
export function bisectShard(shard: ExtractionShard, evidence: Evidence[]): Array<{ shard: ExtractionShard; evidence: Evidence[] }> {
  const midpoint = Math.ceil(evidence.length / 2);
  const halves: Evidence[][] = [evidence.slice(0, midpoint), evidence.slice(midpoint)];
  return halves.flatMap((items, index) => items.length === 0 ? [] : [{
    shard: makeShard(shard.id, shard.kind, `${shard.subject}#${index + 1}`, items),
    evidence: items,
  }]);
}

export function isShardedExtractor(extractor: CandidateExtractor): extractor is ShardedCandidateExtractor {
  return typeof (extractor as Partial<ShardedCandidateExtractor>).extractShard === "function";
}
