import { createHash } from "node:crypto";
import { readFile, realpath } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";
import {
  BuildRequestSchema,
  type BuildRequest,
  type BuildResult,
  ContextRequestSchema,
  CreateEvaluationPlanRequestSchema,
  type CreateEvaluationPlanRequest,
  ConflictRequestSchema,
  type ConflictRequest,
  CreateKnowledgeBatchRequestSchema,
  type CreateKnowledgeBatchRequest,
  CreateKnowledgeRequestSchema,
  type CreateKnowledgeRequest,
  type ContextPack,
  type ContextRequest,
  type Evidence,
  type EvidenceCluster,
  type EvaluationObservation,
  type EvaluationPlan,
  type EvaluationReport,
  type EvaluationRunManifest,
  EvaluationRunSetIdSchema,
  type EvaluationTask,
  type EvaluationVariant,
  type EvaluationVariantSummary,
  ExecutionDetailsSchema,
  type ExecutionRun,
  FeedbackRequestSchema,
  type FeedbackRequest,
  type KnowledgeCard,
  type KnowledgeChange,
  type KnowledgeRelation,
  type ProjectMap,
  MergeKnowledgeRequestSchema,
  type MergeKnowledgeRequest,
  ReviewRequestSchema,
  type ReviewRequest,
  RollbackKnowledgeRequestSchema,
  type RollbackKnowledgeRequest,
  RecordEvaluationObservationRequestSchema,
  type RecordEvaluationObservationRequest,
  ResolveConflictRequestSchema,
  type ResolveConflictRequest,
  type RunDisposition,
  type RunErrorCode,
  type RunItem,
  type RunStage,
  VerificationRequestSchema,
  type VerificationRequest,
} from "@testknowledge/model";
import type {
  CandidateExtractor,
  CandidateExtractionResult,
  EvidenceClusterDraft,
  EvidenceToolRuntime,
  KnowledgeDraft,
  KnowledgeRepository,
  ProjectScope,
  ProjectScanner,
  ProjectEvidenceProvider,
  ReadLogEntry,
  SearchIndex,
  ScanSummary,
  SourceAdapter,
  SourceFile,
  SourceSpec,
  ShardedCandidateExtractor,
  StructuralContextProvider,
} from "./ports.js";
import { isAgenticShardExtractor } from "./ports.js";
import { runAgenticExtraction } from "./agentic-extraction.js";
import { documentedRunInstructions } from "./run-instructions.js";
import { isShardedExtractor, planExtractionShards } from "./extraction-shards.js";
import { materializeObservations } from "./observations.js";
import { withBackoff } from "./retry.js";

const isoNow = (): string => new Date().toISOString();

/** The scan stage runs before file contents are read, so no content revision exists yet. */
const PRESCAN_REVISION = "unscanned";

function isOutside(root: string, target: string): boolean {
  const fromRoot = relative(root, target);
  return fromRoot === ".." || fromRoot.startsWith(`..${sep}`) || isAbsolute(fromRoot);
}

function digest(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

/** Item-level entry a stage can report while it runs. Persisted with the stage record, never one write per item. */
export type RunTraceEntry = {
  itemKey: string;
  itemKind: RunItem["itemKind"];
  disposition: RunDisposition;
  durationMs?: number;
  errorCode?: RunErrorCode | null;
  errorMessage?: string;
};

/** Handed to each traced stage so it can report per-item outcomes before the stage record is written. */
export type RunTrace = {
  runId: string;
  addItem(entry: RunTraceEntry): void;
};

function executionRunId(repo: string, revision: string, stage: RunStage, extractor: string, startedAt: string): string {
  return `run_${digest(`${repo}:${revision}:${stage}:${extractor}:${startedAt}`).slice(0, 24)}`;
}

function runItemRecordId(runId: string, itemKind: string, itemKey: string): string {
  return `ritem_${digest(`${runId}:${itemKind}:${itemKey}`).slice(0, 24)}`;
}

function runErrorMessage(error: unknown): string {
  if (error === undefined) return "";
  const message = error instanceof Error ? error.message : String(error);
  return message.slice(0, 1000);
}

/** Classification is a diagnostic hint for the ledger, not a control-flow input. */
function runErrorCode(error: unknown): RunErrorCode {
  if (error instanceof SyntaxError) return "parse";
  if (error instanceof Error && (error.name === "AbortError" || error.name === "TimeoutError")) return "timeout";
  const message = runErrorMessage(error);
  if (/truncat/iu.test(message)) return "parse";
  if (/timed?\s*out|timeout/iu.test(message)) return "timeout";
  const status = /\b([45]\d{2})\b/u.exec(message);
  if (status) return Number(status[1]) < 500 ? "http_4xx" : "http_5xx";
  return "unknown";
}

function observedIdentity(observed: KnowledgeDraft["observed"]): Record<string, string[]> | null {
  if (!observed) return null;
  return {
    assertions: observed.assertions,
    expectedExceptions: observed.expectedExceptions,
    mocks: observed.mocks,
    factories: observed.factories,
    dependencies: observed.dependencies,
    parametrize: observed.parametrize,
  };
}

/**
 * Identity of a card is its own semantic content plus the repository.
 * `revision`, `evidenceIds` and `confidence` are deliberately excluded:
 * a line shift or a project-wide rebuild must not invalidate a reviewed card.
 */
function cardKey(draft: KnowledgeDraft, repo: string): string {
  return JSON.stringify({
    repo,
    kind: draft.kind,
    title: draft.title,
    statement: draft.statement,
    trigger: draft.trigger,
    expectedBehavior: draft.expectedBehavior,
    oracle: draft.oracle,
    risk: draft.risk,
    path: draft.path,
    symbol: draft.symbol,
    targetSymbols: draft.targetSymbols ?? [],
    partitions: draft.partitions ?? [],
    preconditions: draft.preconditions ?? [],
    dependencies: draft.dependencies ?? [],
    techniques: draft.techniques ?? [],
    applicability: draft.applicability ? {
      languages: draft.applicability.languages,
      frameworks: draft.applicability.frameworks,
      paths: draft.applicability.paths,
      symbols: draft.applicability.symbols,
    } : null,
    // Keep the identity projection explicit. Adding unrelated schema defaults must not silently rotate every card ID.
    observed: observedIdentity(draft.observed),
    clusterId: draft.clusterId ?? null,
  });
}

function stableCardId(draft: KnowledgeDraft, repo: string): string {
  return `kc_${digest(cardKey(draft, repo)).slice(0, 24)}`;
}

function manualDraft(request: CreateKnowledgeRequest): KnowledgeDraft {
  return {
    kind: request.kind, title: request.title, statement: request.statement, trigger: request.trigger,
    expectedBehavior: request.expectedBehavior, oracle: request.oracle, risk: request.risk,
    path: request.path, symbol: request.symbol, targetSymbols: request.targetSymbols, partitions: request.partitions,
    preconditions: request.preconditions, dependencies: request.dependencies, techniques: request.techniques,
    applicability: { ...request.applicability, revision: request.revision },
    evidenceIds: request.evidenceIds, observed: request.observed, confidence: request.confidence,
  };
}

function validateManualKnowledgeRequest(request: CreateKnowledgeRequest, evidenceById: Map<string, Evidence>, label: string): void {
  if (request.applicability.revision && request.applicability.revision !== request.revision) {
    throw new Error(`${label} applicability revision must match its repository revision`);
  }
  if (request.evidenceIds.some((id) => {
    const item = evidenceById.get(id);
    return !item || item.repo !== request.repo || item.revision !== request.revision;
  })) throw new Error(`${label} must cite existing evidence from the same repository revision`);
}

function knowledgeChange(
  action: KnowledgeChange["action"],
  actor: string,
  note: string,
  before: KnowledgeCard | null,
  after: KnowledgeCard | null,
  sourceKnowledgeIds: string[] = [],
  operationId?: string,
): KnowledgeChange {
  const createdAt = isoNow();
  const knowledgeId = after?.id ?? before?.id;
  if (!knowledgeId) throw new Error("Knowledge change requires a before or after card");
  const resolvedOperationId = operationId ?? `op_${digest(JSON.stringify({ knowledgeId, action, actor, note, createdAt })).slice(0, 24)}`;
  return {
    id: `chg_${digest(JSON.stringify({ knowledgeId, action, actor, note, before, after, sourceKnowledgeIds, createdAt })).slice(0, 24)}`,
    operationId: resolvedOperationId,
    knowledgeId,
    action,
    actor,
    note,
    before,
    after,
    sourceKnowledgeIds,
    createdAt,
  };
}

function evidenceSemanticKey(evidence: Evidence): string {
  return JSON.stringify({
    sourceType: evidence.sourceType,
    path: evidence.path,
    symbol: evidence.symbol,
    contentHash: evidence.contentHash,
    extractor: evidence.extractor,
  });
}

function supportFingerprint(evidenceIds: string[], evidenceById: Map<string, Evidence>): string | null {
  const evidence = evidenceIds.map((id) => evidenceById.get(id));
  if (evidence.some((item) => !item)) return null;
  return JSON.stringify(evidence.map((item) => evidenceSemanticKey(item!)).sort());
}

function dependencyFingerprint(
  evidenceIds: string[],
  targetSymbols: string[],
  frameworks: string[],
  evidenceById: Map<string, Evidence>,
  revision?: string,
): string {
  const cited = evidenceIds.map((id) => evidenceById.get(id)).filter((item): item is Evidence => Boolean(item));
  const repo = cited[0]?.repo;
  if (!repo) return "[]";
  const simpleName = (value: string): string => (value.split("#").at(-1)?.split(".").at(-1) ?? value).replace(/^[^A-Za-z_]*/u, "").replace(/[^\w]*$/u, "");
  const calls = cited.flatMap((item) => Array.isArray(item.payload.calls) ? item.payload.calls : []);
  const calledNames = calls.flatMap((call) => call !== null && typeof call === "object" && typeof (call as { name?: unknown }).name === "string" ? [simpleName((call as { name: string }).name)] : []);
  const mockedNames = calls.flatMap((call) => {
    if (call === null || typeof call !== "object") return [];
    const value = call as { name?: unknown; args?: unknown };
    if (typeof value.name !== "string" || !/(?:^|\.)(?:patch|patch\.object)$/u.test(value.name) || !Array.isArray(value.args)) return [];
    return value.args.filter((arg): arg is string => typeof arg === "string").map(simpleName);
  });
  const fixtureNames = cited.flatMap((item) => Array.isArray(item.payload.fixtureRequests)
    ? item.payload.fixtureRequests.filter((name): name is string => typeof name === "string")
    : []);
  const requested = new Set([...calledNames, ...mockedNames, ...targetSymbols.map(simpleName)].filter(Boolean));
  const fixtureRequested = new Set(fixtureNames.filter(Boolean));
  const allEvidence = [...evidenceById.values()].filter((item) => item.repo === repo && (!revision || item.revision === revision));
  const dependencies: Evidence[] = [];
  for (const name of requested) {
    const matches = allEvidence.filter((item) => item.sourceType === "production_code" && item.symbol === name);
    if (matches.length === 1) dependencies.push(matches[0]!);
  }
  for (const name of fixtureRequested) {
    const matches = allEvidence.filter((item) => item.sourceType === "test_code" && item.symbol === name && item.payload.isFixture === true);
    if (matches.length === 1) dependencies.push(matches[0]!);
  }
  if (frameworks.length > 0) dependencies.push(...allEvidence.filter((item) => {
    if (item.sourceType !== "test_configuration") return false;
    const configured = Array.isArray(item.payload.frameworks) ? item.payload.frameworks.filter((value): value is string => typeof value === "string") : [];
    return configured.length === 0 || configured.some((framework) => frameworks.includes(framework));
  }));
  return JSON.stringify([...new Set(dependencies.map(evidenceSemanticKey))].sort());
}

function toCard(
  draft: KnowledgeDraft,
  scope: ProjectScope,
  previous?: KnowledgeCard,
  origin: KnowledgeCard["origin"] = "extracted",
  preserveLifecycle = previous?.sourceHash === digest(cardKey(draft, scope.repo)),
  proposalProvenance: KnowledgeCard["proposalProvenance"] = previous?.proposalProvenance ?? { source: "unknown", actor: "unknown", note: "Legacy or unspecified proposal provenance" },
): KnowledgeCard {
  const now = isoNow();
  const sourceHash = digest(cardKey(draft, scope.repo));
  return {
    id: stableCardId(draft, scope.repo),
    origin: previous?.origin ?? origin,
    proposalProvenance: preserveLifecycle ? previous?.proposalProvenance ?? proposalProvenance : proposalProvenance,
    ...(draft.clusterId ? { clusterId: draft.clusterId } : {}),
    kind: draft.kind,
    title: draft.title,
    statement: draft.statement,
    trigger: draft.trigger,
    expectedBehavior: draft.expectedBehavior,
    oracle: draft.oracle,
    risk: draft.risk,
    repo: scope.repo,
    revision: scope.revision,
    path: draft.path,
    symbol: draft.symbol,
    targetSymbols: draft.targetSymbols ?? [],
    partitions: draft.partitions ?? [],
    preconditions: draft.preconditions ?? [],
    dependencies: draft.dependencies ?? [],
    techniques: draft.techniques ?? [],
    applicability: draft.applicability ?? { languages: [], frameworks: [], paths: [draft.path], symbols: draft.symbol ? [draft.symbol] : [], revision: scope.revision },
    validationEvidenceIds: preserveLifecycle ? previous?.validationEvidenceIds ?? [] : [],
    evidenceIds: draft.evidenceIds,
    observed: draft.observed ?? { assertions: [], expectedExceptions: [], mocks: [], factories: [], dependencies: [], parametrize: [] },
    confidence: draft.confidence,
    status: preserveLifecycle ? previous?.status ?? "candidate" : "candidate",
    sourceHash,
    createdAt: previous?.createdAt ?? now,
    updatedAt: preserveLifecycle ? previous?.updatedAt ?? now : now,
  };
}

function extractionParts(result: CandidateExtractionResult): { drafts: KnowledgeDraft[]; clusters: EvidenceClusterDraft[] } {
  return Array.isArray(result) ? { drafts: result, clusters: [] } : result;
}

function extractionCounts(result: CandidateExtractionResult): Record<string, number> {
  const parts = extractionParts(result);
  return { drafts: parts.drafts.length, clusters: parts.clusters.length };
}

function explicitGroundingAnchors(draft: KnowledgeDraft): string[] {
  const prose = [draft.statement, draft.trigger, draft.expectedBehavior, draft.oracle].join("\n");
  const quoted = [...prose.matchAll(/`([^`]{2,})`|["“「]([^"”」]{2,})["”」]/gu)].map((match) => match[1] ?? match[2] ?? "");
  const codeLike = [...prose.matchAll(/\b(?:[A-Z][A-Z0-9_]{2,}|[A-Za-z_]\w*(?:\.[A-Za-z_]\w*)+)\b/gu)].map((match) => match[0]);
  return [...new Set([
    ...(draft.targetSymbols ?? []),
    ...(draft.dependencies ?? []),
    ...(draft.applicability?.paths ?? []),
    ...(draft.applicability?.symbols ?? []),
    ...quoted,
    ...codeLike,
  ].map((value) => value.trim()).filter((value) => value.length >= 2))];
}

function stringValues(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string" && item.length > 0) : [];
}

function objectValues(value: unknown): Array<Record<string, unknown>> {
  return Array.isArray(value) ? value.filter((item): item is Record<string, unknown> => item !== null && typeof item === "object") : [];
}

function assertionShape(value: string): string {
  return value.trim().replace(/(["']).*?\1/gu, "<str>").replace(/\b\d+(?:\.\d+)?\b/gu, "<num>").replace(/\s+/gu, " ");
}

function deterministicSignals(item: Evidence): Set<string> {
  const payload = item.payload;
  const assertions = objectValues(payload.assertions).flatMap((entry) => typeof entry.text === "string" ? [entry.text] : []);
  const calls = objectValues(payload.calls).flatMap((entry) => typeof entry.name === "string" ? [`${entry.name}:${JSON.stringify(Array.isArray(entry.literals) ? entry.literals : [])}`] : []);
  const exceptions = [
    ...objectValues(payload.withBlocks).filter((entry) => typeof entry.call === "string" && /raises/u.test(entry.call)).flatMap((entry) => stringValues(entry.args)),
    ...objectValues(payload.tryHandlers).flatMap((entry) => stringValues(entry.exceptionTypes)),
    ...stringValues(payload.expectedExceptions),
  ];
  return new Set([
    ...assertions.map((value) => `assertion:${assertionShape(value)}`),
    ...calls.map((value) => `call:${value}`),
    ...exceptions.map((value) => `exception:${value}`),
    ...stringValues(payload.parametrize).map((value) => `parametrize:${assertionShape(value)}`),
    ...stringValues(payload.fixtureRequests).map((value) => `precondition:${value}`),
    ...stringValues(payload.factories).map((value) => `factory:${value}`),
    ...stringValues(payload.mocks).map((value) => `mock:${value}`),
  ]);
}

export type CitationIssue = {
  anchor: string;
  reason: "not_in_evidence" | "line_out_of_range" | "missing_evidence_reference";
};

/**
 * Why a draft's citations do not hold up, for the run ledger.
 *
 * A bare "does this string appear in the cited evidence" test cannot tell that two true facts
 * came from different places. When an anchor carries a line range, that range must sit inside
 * the span of a source the draft actually cites — so a claim cannot borrow a source that merely
 * mentions the same words somewhere else in the file.
 */
export function citationIssues(draft: KnowledgeDraft, cited: Array<Evidence | undefined>): CitationIssue[] {
  if (cited.some((item) => !item)) return [{ anchor: "", reason: "missing_evidence_reference" }];
  const sources = cited as Evidence[];
  const corpus = sources.map((item) => [item.path, item.symbol, item.sourceRef, item.content, JSON.stringify(item.payload)].join("\n")).join("\n").toLowerCase();
  const issues: CitationIssue[] = [];
  for (const anchor of explicitGroundingAnchors(draft)) {
    // A `path:start-end` anchor claims a location. Judge the location, not the literal string:
    // the path is usually present as a path, not as a citation-shaped substring.
    const span = /^(.+?):(\d+)-(\d+)$/u.exec(anchor);
    if (span) {
      const path = span[1] ?? "";
      const start = Number(span[2]);
      const end = Number(span[3]);
      if (!corpus.includes(path.toLowerCase())) {
        issues.push({ anchor, reason: "not_in_evidence" });
        continue;
      }
      const covered = sources.some((item) => item.path === path && start >= item.lineStart && end <= item.lineEnd);
      if (!covered) issues.push({ anchor, reason: "line_out_of_range" });
      continue;
    }
    if (!corpus.includes(anchor.toLowerCase())) issues.push({ anchor, reason: "not_in_evidence" });
  }
  return issues;
}

function clusterKey(draft: EvidenceClusterDraft, repo: string): string {
  return JSON.stringify({ repo, subject: draft.subject, shape: draft.shape, evidenceIds: [...new Set(draft.evidenceIds)].sort() });
}

function stableClusterId(draft: EvidenceClusterDraft, repo: string): string {
  return `cl_${digest(clusterKey(draft, repo)).slice(0, 24)}`;
}

function materializeClusters(drafts: EvidenceClusterDraft[], evidence: Evidence[], scope: ProjectScope, previous: EvidenceCluster[]): { clusters: EvidenceCluster[]; invalidCount: number } {
  const evidenceById = new Map(evidence.map((item) => [item.id, item]));
  const previousById = new Map(previous.map((item) => [item.id, item]));
  const clusters: EvidenceCluster[] = [];
  let invalidCount = 0;
  for (const draft of drafts) {
    const evidenceIds = [...new Set(draft.evidenceIds)];
    const members = evidenceIds.map((id) => evidenceById.get(id));
    if (evidenceIds.length < 2 || members.some((item) => !item || item.repo !== scope.repo || item.revision !== scope.revision)) {
      invalidCount += 1;
      continue;
    }
    const signalSets = members.map((item) => deterministicSignals(item!));
    const sharedSignals = [...(signalSets[0] ?? new Set<string>())].filter((signal) => signalSets.slice(1).every((set) => set.has(signal)));
    if (sharedSignals.length === 0) {
      invalidCount += 1;
      continue;
    }
    const id = stableClusterId({ ...draft, evidenceIds }, scope.repo);
    const old = previousById.get(id);
    const now = isoNow();
    clusters.push({ id, subject: draft.subject, shape: draft.shape, evidenceIds, sharedSignals, repo: scope.repo, revision: scope.revision, confidence: draft.confidence, status: old?.status ?? "candidate", extractor: draft.extractor, createdAt: old?.createdAt ?? now, updatedAt: old?.updatedAt ?? now });
  }
  return { clusters, invalidCount };
}

function relationId(type: KnowledgeRelation["type"], from: KnowledgeRelation["from"], to: KnowledgeRelation["to"], repo: string): string {
  return `rel_${digest(JSON.stringify({ type, from, to, repo })).slice(0, 24)}`;
}

function buildRelations(
  evidence: Evidence[],
  cards: KnowledgeCard[],
  scope: ProjectScope,
  previous: KnowledgeRelation[],
  retainedEvidence: Evidence[] = evidence,
): KnowledgeRelation[] {
  const now = isoNow();
  const previousById = new Map(previous.map((item) => [item.id, item]));
  const evidenceRecordById = new Map(evidence.map((item) => [item.id, item]));
  const relations: KnowledgeRelation[] = [];
  const add = (type: KnowledgeRelation["type"], from: KnowledgeRelation["from"], to: KnowledgeRelation["to"], evidenceIds: string[], confidence: number): void => {
    const id = relationId(type, from, to, scope.repo);
    relations.push({ id, type, from, to, repo: scope.repo, revision: scope.revision, evidenceIds, confidence, source: "testknowledge.deterministic-relations.v1", createdAt: previousById.get(id)?.createdAt ?? now });
  };

  for (const card of cards) {
    for (const evidenceId of card.evidenceIds) {
      add("SUPPORTED_BY", { kind: "knowledge", id: card.id }, { kind: "evidence", id: evidenceId }, [evidenceId], 1);
      const source = evidenceRecordById.get(evidenceId);
      const signals = source ? deterministicSignals(source) : new Set<string>();
      const hasBehaviorOracle = [...signals].some((signal) => signal.startsWith("assertion:") || signal.startsWith("exception:"));
      if (source?.sourceType === "test_code" && source.payload.isTest === true && hasBehaviorOracle) {
        add("VERIFIES", { kind: "evidence", id: evidenceId }, { kind: "knowledge", id: card.id }, [evidenceId], 0.7);
      }
    }
  }

  const fixtures = new Map<string, Evidence[]>();
  const production = new Map<string, Evidence[]>();
  for (const item of evidence) {
    if (item.payload.isFixture === true && item.symbol) fixtures.set(item.symbol, [...(fixtures.get(item.symbol) ?? []), item]);
    if (item.sourceType === "production_code" && item.symbol) production.set(item.symbol, [...(production.get(item.symbol) ?? []), item]);
  }
  for (const item of evidence.filter((entry) => entry.payload.isTest === true)) {
    const fixtureNames = Array.isArray(item.payload.fixtureRequests) ? item.payload.fixtureRequests.filter((name): name is string => typeof name === "string") : [];
    for (const name of fixtureNames) {
      const matches = fixtures.get(name) ?? [];
      if (matches.length === 1) add("USES_FIXTURE", { kind: "evidence", id: item.id }, { kind: "evidence", id: matches[0]!.id }, [item.id, matches[0]!.id], 1);
    }
    const calls = Array.isArray(item.payload.calls) ? item.payload.calls : [];
    const names = calls.flatMap((call) => call !== null && typeof call === "object" && typeof (call as { name?: unknown }).name === "string" ? [(call as { name: string }).name.split(/\.|::/u).at(-1) ?? ""] : []);
    for (const name of new Set(names.filter(Boolean))) {
      const matches = production.get(name) ?? [];
      if (matches.length === 1) add("COVERS", { kind: "evidence", id: item.id }, { kind: "production_symbol", id: `${matches[0]!.path}#${matches[0]!.symbol}` }, [item.id, matches[0]!.id], 0.8);
    }
  }
  const testsByPath = new Map<string, Evidence[]>();
  for (const item of evidence.filter((entry) => entry.payload.isTest === true)) {
    testsByPath.set(item.path, [...(testsByPath.get(item.path) ?? []), item]);
  }
  for (const bug of evidence.filter((entry) => entry.sourceType === "bug_history")) {
    const testFiles = Array.isArray(bug.payload.testFiles) ? bug.payload.testFiles.filter((path): path is string => typeof path === "string") : [];
    for (const path of testFiles) {
      for (const test of testsByPath.get(path) ?? []) {
        add("REGRESSION_OF", { kind: "evidence", id: test.id }, { kind: "evidence", id: bug.id }, [test.id, bug.id], bug.confidence);
      }
    }
  }
  const cardIds = new Set(cards.map((card) => card.id));
  const evidenceIds = new Set(retainedEvidence.map((item) => item.id));
  const retainedTypes = new Set<KnowledgeRelation["type"]>(["CONFLICTS_WITH", "VERIFIED_BY", "INVALIDATED_BY", "MERGED_FROM"]);
  for (const relation of previous) {
    if (!retainedTypes.has(relation.type)) continue;
    const nodesRemain = [relation.from, relation.to].every((node) => node.kind === "knowledge" ? cardIds.has(node.id) : node.kind === "evidence" ? evidenceIds.has(node.id) : true);
    if (!nodesRemain || relation.evidenceIds.some((id) => !evidenceIds.has(id))) continue;
    if (!relations.some((item) => item.id === relation.id)) relations.push(relation);
  }
  return relations;
}

/**
 * The knowledge layer holds review-gated semantic claims. Deterministic rule output is an
 * observation of evidence, not a claim, so it is filtered out of every knowledge read path
 * rather than rewritten in storage — the `knowledge-changes` audit trail stays intact.
 */
function isKnowledgeLayer(card: KnowledgeCard): boolean {
  return card.proposalProvenance.source !== "deterministic_extractor";
}

function isApplicable(card: KnowledgeCard, request: ContextRequest): boolean {
  const applicability = card.applicability;
  if (!applicability) return true;
  const overlaps = (left: string[], right: string[]): boolean => left.some((value) => right.includes(value));
  if (applicability.languages.length > 0 && !overlaps(applicability.languages, request.languages)) return false;
  if (applicability.frameworks.length > 0 && !overlaps(applicability.frameworks, request.frameworks)) return false;
  if (request.revision && applicability.revision && request.revision !== applicability.revision) return false;
  if (applicability.symbols.length > 0 && request.targetSymbols.length > 0 && !overlaps(applicability.symbols, request.targetSymbols)) return false;
  if (applicability.paths.length > 0 && request.changedFiles.length > 0 && !overlaps(applicability.paths, request.changedFiles)) return false;
  return true;
}

function runInstructionsFromEvidence(evidence: Evidence[]): ContextPack["runInstructions"] {
  return evidence.flatMap((item) => {
    const executed = item.payload.runCommand ?? item.payload.command;
    const structured = Array.isArray(executed) && executed.every((part) => typeof part === "string")
      ? [{ command: executed as string[], sourceRef: item.sourceRef, confidence: item.confidence, verified: item.sourceType === "execution_result" && item.payload.outcome === "passed" }]
      : [];
    const paired = documentedRunInstructions(item.payload.environmentProfile).map((instruction) => ({
      commandText: instruction.commandText,
      sourceRef: item.sourceRef,
      ...(instruction.workingDirectory ? { workingDirectory: instruction.workingDirectory } : {}),
      confidence: item.confidence,
      verified: false,
    }));
    // A command the source never paired with a directory is still a documented command, so keep it;
    // leaving workingDirectory unset is the honest answer, attaching an unrelated directory is not.
    const unpaired = paired.length > 0 ? [] : stringValues(item.payload.runCommands).map((commandText) => ({
      commandText,
      sourceRef: item.sourceRef,
      confidence: item.confidence,
      verified: false,
    }));
    return [...structured, ...paired, ...unpaired];
  });
}

function executionSignalsFromEvidence(evidence: Evidence[]): ContextPack["executionSignals"] {
  return evidence.flatMap((item) => {
    if (item.sourceType !== "execution_result") return [];
    const outcome = item.payload.outcome;
    const command = item.payload.command;
    const observed = item.payload.observed;
    const details = ExecutionDetailsSchema.safeParse(item.payload.execution ?? {});
    if ((outcome !== "passed" && outcome !== "failed" && outcome !== "error") || !Array.isArray(command) || !command.every((part) => typeof part === "string") || typeof observed !== "string" || !observed || !details.success) return [];
    return [{ evidenceId: item.id, sourceRef: item.sourceRef, outcome, command, observed, ...details.data }];
  });
}

function materializeProjectMap(
  repo: string,
  revision: string,
  files: SourceSpec[],
  scan: ScanSummary,
  evidence: Evidence[],
  previous?: ProjectMap,
): ProjectMap {
  const unique = (values: string[]): string[] => [...new Set(values.filter(Boolean))].sort();
  const now = isoNow();
  const productionFiles = unique([...files.filter((file) => file.type === "production_code").map((file) => file.path), ...evidence.filter((item) => item.sourceType === "production_code").map((item) => item.path)]);
  const testFiles = unique([...files.filter((file) => file.type === "test_code").map((file) => file.path), ...evidence.filter((item) => item.sourceType === "test_code").map((item) => item.path)]);
  const derivedTestDirectories = testFiles.flatMap((path) => {
    const parts = path.replaceAll("\\", "/").split("/");
    const index = parts.findIndex((part) => part === "test" || part === "tests");
    return index >= 0 ? [parts.slice(0, index + 1).join("/")] : [];
  });
  const environmentEvidenceFiles = evidence.filter((item) => item.payload.environmentProfile !== undefined).map((item) => item.path);
  const languageByExtension: Record<string, string> = { ".py": "python", ".java": "java", ".go": "go", ".rs": "rust" };
  const languagesFromFiles = files.flatMap((file) => Object.entries(languageByExtension).flatMap(([extension, language]) => file.path.endsWith(extension) ? [language] : []));
  const languagesFromEvidence = evidence.flatMap((item) => typeof item.payload.language === "string" && item.payload.language ? [item.payload.language] : []);
  const frameworkByTestExtension: Record<string, string> = { ".py": "pytest", ".java": "junit", ".go": "go-testing", ".rs": "rust-test" };
  const frameworksFromFiles = testFiles.flatMap((file) => Object.entries(frameworkByTestExtension).flatMap(([extension, framework]) => file.endsWith(extension) ? [framework] : []));
  const frameworksFromEvidence = evidence.flatMap((item) => typeof item.payload.framework === "string" && item.payload.framework ? [item.payload.framework] : []);
  return {
    id: `map_${digest(repo).slice(0, 24)}`,
    repo,
    revision,
    languages: unique([...(scan.detectedLanguages ?? []), ...languagesFromFiles, ...languagesFromEvidence]),
    frameworks: unique([...(scan.detectedFrameworks ?? []), ...frameworksFromFiles, ...frameworksFromEvidence]),
    productionFiles,
    testFiles,
    testDirectories: unique([...scan.testDirectories, ...derivedTestDirectories]),
    configFiles: unique([...scan.configFiles, ...files.filter((file) => file.type === "test_configuration").map((file) => file.path)]),
    environmentFiles: unique([...scan.environmentFiles, ...environmentEvidenceFiles]),
    productionSymbols: unique(evidence.filter((item) => item.sourceType === "production_code").map((item) => item.symbol)),
    testSymbols: unique(evidence.filter((item) => item.sourceType === "test_code" && item.payload.isTest === true).map((item) => item.symbol)),
    fixtureSymbols: unique(evidence.filter((item) => item.sourceType === "test_code" && item.payload.isFixture === true).map((item) => item.symbol)),
    setupSymbols: unique(evidence.filter((item) => item.sourceType === "test_code" && item.payload.isSetup === true).map((item) => item.symbol)),
    runInstructions: runInstructionsFromEvidence(evidence),
    warnings: unique(scan.warnings),
    createdAt: previous?.createdAt ?? now,
    updatedAt: now,
  };
}

const EVALUATION_VARIANTS: EvaluationVariant[] = ["A_ordinary_agent", "B_codegraph", "C_codegraph_testknowledge"];

function expectedMatches(observed: string[], expected: string[]): number {
  const expectedSet = new Set(expected);
  return new Set(observed.filter((id) => expectedSet.has(id))).size;
}

function evaluationSummary(rows: Array<{ task: EvaluationTask; observation: EvaluationObservation }>): EvaluationVariantSummary {
  const count = rows.length;
  const total = (field: "criticalBoundaryIds" | "seededBugIds" | "requiredOracleIds"): number => rows.reduce((sum, row) => sum + row.task[field].length, 0);
  const matched = (observed: "coveredBoundaryIds" | "detectedSeededBugIds" | "effectiveOracleIds", expected: "criticalBoundaryIds" | "seededBugIds" | "requiredOracleIds"): number => rows.reduce((sum, row) => sum + expectedMatches(row.observation[observed], row.task[expected]), 0);
  const ratio = (numerator: number, denominator: number): number => denominator === 0 ? 0 : numerator / denominator;
  const fixtureRows = rows.filter((row) => row.task.fixtureMockCriteria.length > 0 && row.observation.fixtureMockCorrect !== null);
  return {
    taskCount: count,
    executionPassRate: ratio(rows.filter((row) => row.observation.executionPassed).length, count),
    boundaryCoverageRate: ratio(matched("coveredBoundaryIds", "criticalBoundaryIds"), total("criticalBoundaryIds")),
    seededBugDetectionRate: ratio(matched("detectedSeededBugIds", "seededBugIds"), total("seededBugIds")),
    effectiveOracleRate: ratio(matched("effectiveOracleIds", "requiredOracleIds"), total("requiredOracleIds")),
    fixtureMockCorrectRate: fixtureRows.length === 0 ? null : fixtureRows.filter((row) => row.observation.fixtureMockCorrect === true).length / fixtureRows.length,
    invalidAssertionCount: rows.reduce((sum, row) => sum + row.observation.invalidAssertionCount, 0),
    duplicateTestCount: rows.reduce((sum, row) => sum + row.observation.duplicateTestCount, 0),
    brittleTestCount: rows.reduce((sum, row) => sum + row.observation.brittleTestCount, 0),
    averageTokens: ratio(rows.reduce((sum, row) => sum + row.observation.tokenUsage, 0), count),
    averageToolCalls: ratio(rows.reduce((sum, row) => sum + row.observation.toolCalls, 0), count),
    averageDurationMs: ratio(rows.reduce((sum, row) => sum + row.observation.durationMs, 0), count),
  };
}

function taskQuality(task: EvaluationTask, observation: EvaluationObservation): number {
  const scores = [observation.executionPassed ? 1 : 0];
  if (task.criticalBoundaryIds.length > 0) scores.push(expectedMatches(observation.coveredBoundaryIds, task.criticalBoundaryIds) / task.criticalBoundaryIds.length);
  if (task.seededBugIds.length > 0) scores.push(expectedMatches(observation.detectedSeededBugIds, task.seededBugIds) / task.seededBugIds.length);
  if (task.requiredOracleIds.length > 0) scores.push(expectedMatches(observation.effectiveOracleIds, task.requiredOracleIds) / task.requiredOracleIds.length);
  if (task.fixtureMockCriteria.length > 0 && observation.fixtureMockCorrect !== null) scores.push(observation.fixtureMockCorrect ? 1 : 0);
  const lowQualityCount = observation.invalidAssertionCount + observation.duplicateTestCount + observation.brittleTestCount;
  return scores.reduce((sum, score) => sum + score, 0) / scores.length - Math.min(1, lowQualityCount) * 0.25;
}

function increaseRatio(candidate: number, baseline: number): number {
  return (candidate - baseline) / Math.max(1, baseline);
}

function sameStringSet(left: string[], right: string[]): boolean {
  const sortedLeft = [...left].sort();
  const sortedRight = [...right].sort();
  return sortedLeft.length === sortedRight.length && sortedLeft.every((value, index) => value === sortedRight[index]);
}

function evaluationRunSpec(plan: EvaluationPlan, task: EvaluationTask, variant: EvaluationVariant, runSetId: string): EvaluationRunManifest["runs"][number] {
  const tools = plan.variantTools?.[variant] ?? plan.tools;
  const prompt = `${plan.promptTemplate.trim()}\n\n## 当前任务\n\n${task.prompt.trim()}`;
  const runId = `evalrun_${digest(JSON.stringify({ planId: plan.id, runSetId, taskId: task.id, variant })).slice(0, 24)}`;
  const base = {
    planId: plan.id,
    runSetId,
    taskId: task.id,
    variant,
    runId,
    agentInput: {
      model: plan.model,
      prompt,
      tools: [...tools],
      budget: { ...plan.budget },
      targetSymbols: [...task.targetSymbols],
      changedFiles: [...task.changedFiles],
    },
    scoring: {
      criticalBoundaryIds: [...task.criticalBoundaryIds],
      seededBugIds: [...task.seededBugIds],
      requiredOracleIds: [...task.requiredOracleIds],
      fixtureMockCriteria: [...task.fixtureMockCriteria],
      duplicateCriteria: [...task.duplicateCriteria],
      brittlenessCriteria: [...task.brittlenessCriteria],
    },
  };
  return { ...base, runSpecHash: digest(JSON.stringify(base)) };
}

export class KnowledgeEngine {
  constructor(
    private readonly repository: KnowledgeRepository,
    private readonly index: SearchIndex,
    private readonly sourceAdapters: SourceAdapter[],
    private readonly ruleExtractor: CandidateExtractor,
    private readonly llmExtractor?: CandidateExtractor,
    private readonly structuralContextProvider?: StructuralContextProvider,
    private readonly projectEvidenceProviders: ProjectEvidenceProvider[] = [],
    private readonly evidenceToolRuntime?: EvidenceToolRuntime,
  ) {}

  /**
   * Runs one pipeline stage and persists an execution record for it.
   *
   * The record is written the moment the stage ends, so a stage that throws still
   * leaves a durable row before the error propagates. Item-level entries are batched
   * into that same write; the ledger is read-all-then-rewrite, so one write per item
   * would degrade it to O(n^2).
   */
  private async traced<T>(
    stage: RunStage,
    base: { repo: string; revision: string; fingerprint: string; extractor: string },
    fn: (trace: RunTrace) => Promise<T>,
    countsOf?: (value: T) => Record<string, number>,
  ): Promise<T> {
    const startedAt = isoNow();
    const startedMs = Date.now();
    const runId = executionRunId(base.repo, base.revision, stage, base.extractor, startedAt);
    const entries: RunTraceEntry[] = [];
    const trace: RunTrace = { runId, addItem: (entry) => { entries.push(entry); } };
    let value: T;
    try {
      value = await fn(trace);
    } catch (error) {
      try {
        await this.persistRun({ stage, base, runId, entries, startedAt, startedMs, disposition: "failed", counts: {}, error });
      } catch {
        // A ledger write must never replace the stage failure it is recording.
      }
      throw error;
    }
    await this.persistRun({ stage, base, runId, entries, startedAt, startedMs, disposition: "done", counts: countsOf?.(value) ?? {} });
    return value;
  }

  private async persistRun(input: {
    stage: RunStage;
    base: { repo: string; revision: string; fingerprint: string; extractor: string };
    runId: string;
    entries: RunTraceEntry[];
    startedAt: string;
    startedMs: number;
    disposition: RunDisposition;
    counts: Record<string, number>;
    error?: unknown;
  }): Promise<void> {
    const { repository } = this;
    if (repository.appendRun) {
      await repository.appendRun({
        id: input.runId,
        repo: input.base.repo,
        revision: input.base.revision,
        stage: input.stage,
        extractor: input.base.extractor,
        fingerprint: input.base.fingerprint,
        disposition: input.disposition,
        startedAt: input.startedAt,
        finishedAt: isoNow(),
        durationMs: Math.max(0, Date.now() - input.startedMs),
        attempt: 1,
        errorCode: input.error === undefined ? null : runErrorCode(input.error),
        errorMessage: runErrorMessage(input.error),
        counts: input.counts,
        warnings: input.entries
          .filter((entry) => entry.disposition === "failed")
          .map((entry) => `${entry.itemKey}:failed`),
      });
    }
    if (repository.appendRunItems && input.entries.length > 0) {
      await repository.appendRunItems(input.entries.map((entry) => ({
        id: runItemRecordId(input.runId, entry.itemKind, entry.itemKey),
        runId: input.runId,
        itemKey: entry.itemKey,
        itemKind: entry.itemKind,
        disposition: entry.disposition,
        attempt: 1,
        durationMs: entry.durationMs ?? 0,
        errorCode: entry.errorCode ?? null,
        errorMessage: entry.errorMessage ?? "",
        createdAt: isoNow(),
      })));
    }
  }

  async listExtractionRuns(repo?: string, revision?: string): Promise<ExecutionRun[]> {
    const runs = await this.repository.readRuns?.() ?? [];
    return runs.filter((run) => (!repo || run.repo === repo) && (!revision || run.revision === revision));
  }

  async getExtractionRun(id: string): Promise<ExecutionRun | null> {
    const runs = await this.repository.readRuns?.() ?? [];
    return runs.find((run) => run.id === id) ?? null;
  }

  async listRunItems(runId: string): Promise<RunItem[]> {
    return await this.repository.readRunItems?.(runId) ?? [];
  }

  /** The search index serves the knowledge layer only; observations are projected on read. */
  private async reindex(cards: KnowledgeCard[]): Promise<void> {
    await this.index.rebuild(cards.filter(isKnowledgeLayer));
  }

  /**
   * Drive a shard-aware extractor one shard at a time.
   *
   * A shard that fails is recorded and skipped rather than aborting the batch, and each shard's
   * own output budget comes from the planner, so no single call can consume the whole
   * repository's allowance. Only when every shard fails does the caller fall back to
   * deterministic extraction.
   */
  private async extractSharded(
    extractor: ShardedCandidateExtractor,
    evidence: Evidence[],
    scope: ProjectScope,
    runBase: { repo: string; revision: string; fingerprint: string; extractor: string },
  ): Promise<{ extraction: CandidateExtractionResult; evidence: Evidence[]; readLog: ReadLogEntry[] }> {
    const shards = planExtractionShards(evidence, { repo: scope.repo });
    const evidenceById = new Map(evidence.map((item) => [item.id, item]));
    const drafts: KnowledgeDraft[] = [];
    const clusters: EvidenceClusterDraft[] = [];
    const discovered: Evidence[] = [];
    const readLog: ReadLogEntry[] = [];
    const runtime = this.evidenceToolRuntime;
    const agenticExtractor = runtime !== undefined && isAgenticShardExtractor(extractor) ? extractor : undefined;
    let failed = 0;
    await this.traced("knowledge_extraction", { ...runBase, extractor: extractor.id }, async (trace) => {
      for (const shard of shards) {
        const startedMs = Date.now();
        const shardEvidence = shard.evidenceIds.flatMap((id) => {
          const item = evidenceById.get(id);
          return item ? [item] : [];
        });
        try {
          const result = await withBackoff(async () => {
            const agentic = agenticExtractor;
            if (agentic === undefined || runtime === undefined) return await extractor.extractShard(shard, shardEvidence, scope);
            const run = await runAgenticExtraction({
              runtime,
              step: (messages) => agentic.step(messages),
              scope,
              messages: agentic.beginShard(shard, shardEvidence),
            });
            discovered.push(...run.evidence);
            readLog.push(...run.readLog);
            return agentic.finishShard(shard, [...shardEvidence, ...run.evidence], run.content);
          });
          const parts = extractionParts(result);
          drafts.push(...parts.drafts);
          clusters.push(...parts.clusters);
          trace.addItem({ itemKey: `${shard.kind}:${shard.subject}`, itemKind: "shard", disposition: "done", durationMs: Date.now() - startedMs });
        } catch (error) {
          failed += 1;
          trace.addItem({ itemKey: `${shard.kind}:${shard.subject}`, itemKind: "shard", disposition: "failed", durationMs: Date.now() - startedMs, errorCode: runErrorCode(error), errorMessage: runErrorMessage(error) });
        }
      }
      if (shards.length > 0 && failed === shards.length) throw new Error(`All ${shards.length} extraction shards failed`);
    }, () => ({ shards: shards.length, drafts: drafts.length, clusters: clusters.length, failed, toolReads: readLog.length }));
    return { extraction: { drafts, clusters }, evidence: discovered, readLog };
  }

  async buildFromRepository(raw: BuildRequest, scanner: ProjectScanner): Promise<BuildResult> {
    const request = BuildRequestSchema.parse(raw);
    const repo = resolve(request.repo);
    const baseScan = await this.traced(
      "scan",
      {
        repo,
        revision: PRESCAN_REVISION,
        extractor: "project-scanner",
        fingerprint: digest(JSON.stringify({ repo, stage: "scan" })),
      },
      async (trace) => {
        const result = request.files
          ? { files: request.files, summary: { mode: "explicit" as const, fileCount: request.files.length, testDirectories: [], configFiles: [], environmentFiles: [], warnings: [] } }
          : await scanner.scan(repo);
        trace.addItem({ itemKey: "scan", itemKind: "evidence", disposition: "done", durationMs: 0 });
        return result;
      },
      (value) => ({ files: value.files.length }),
    );
    const filesByPath = new Map(baseScan.files.map((file) => [file.path, file]));
    for (const file of request.additionalFiles) filesByPath.set(file.path, file);
    const sourceSpecs = [...filesByPath.values()];
    const scan = { ...baseScan, files: sourceSpecs, summary: { ...baseScan.summary, fileCount: sourceSpecs.length } };
    const files = await KnowledgeEngine.readFiles(repo, scan.files);
    const result = await this.build({ repo, files, useLlm: request.useLlm });
    let projectMap: ProjectMap | undefined;
    if (this.repository.readProjectMaps && this.repository.writeProjectMaps) {
      const maps = await this.repository.readProjectMaps();
      const currentEvidence = (await this.repository.readEvidence()).filter((item) => item.repo === repo && item.revision === result.revision);
      projectMap = materializeProjectMap(repo, result.revision, scan.files, scan.summary, currentEvidence, maps.find((item) => item.repo === repo));
      await this.repository.writeProjectMaps([...maps.filter((item) => item.repo !== repo), projectMap]);
    }
    return { ...result, scan: scan.summary, ...(projectMap ? { projectMap } : {}), warnings: [...scan.summary.warnings, ...result.warnings] };
  }

  async build(raw: {
    repo: string;
    files: SourceFile[];
    useLlm: boolean;
  }): Promise<BuildResult> {
    const input = { ...raw, repo: resolve(raw.repo) };
    const previousEvidence = await this.repository.readEvidence();
    const previousEvidenceById = new Map(previousEvidence.map((item) => [item.id, item]));
    for (const adapter of this.sourceAdapters) await adapter.prepare?.(input.repo);
    let revision = digest(input.files.map((file) => `${file.path}:${digest(file.text)}`).sort().join("\n"));
    const scope: ProjectScope = { repo: input.repo, revision };
    const intendedExtractors = input.useLlm && this.llmExtractor ? [this.llmExtractor.id] : [this.ruleExtractor.id];
    let runBase = {
      repo: input.repo,
      revision,
      extractor: intendedExtractors.join("+"),
      fingerprint: digest(JSON.stringify({ repo: input.repo, revision, extractors: intendedExtractors, useLlm: Boolean(input.useLlm && this.llmExtractor) })),
    };
    const evidence: Evidence[] = [];
    await this.traced("source_evidence", runBase, async (trace) => {
      const startedMs = Date.now();
      for (const file of input.files) {
        const adapter = this.sourceAdapters.find((item) => item.supports(file));
        if (!adapter) continue;
        evidence.push(...await adapter.collect(file, scope));
      }
      trace.addItem({ itemKey: "source_files", itemKind: "evidence", disposition: "done", durationMs: Date.now() - startedMs });
    }, () => ({ evidence: evidence.length }));
    const warnings: string[] = [];
    await this.traced("project_evidence", runBase, async (trace) => {
      for (const provider of this.projectEvidenceProviders) {
        const startedMs = Date.now();
        try {
          evidence.push(...await provider.collect(scope));
          trace.addItem({ itemKey: provider.id, itemKind: "provider", disposition: "done", durationMs: Date.now() - startedMs });
        } catch (error) {
          warnings.push(`${provider.id}:failed`);
          trace.addItem({ itemKey: provider.id, itemKind: "provider", disposition: "failed", durationMs: Date.now() - startedMs, errorCode: runErrorCode(error), errorMessage: runErrorMessage(error) });
        }
      }
    }, () => ({ providers: this.projectEvidenceProviders.length, evidence: evidence.length }));
    let extraction: CandidateExtractionResult;
    let extractors: string[];
    const toolEvidence: Evidence[] = [];
    const readLog: ReadLogEntry[] = [];
    if (input.useLlm && this.llmExtractor) {
      const llm = this.llmExtractor;
      try {
        if (isShardedExtractor(llm)) {
          const sharded = await this.extractSharded(llm, evidence, scope, runBase);
          extraction = sharded.extraction;
          toolEvidence.push(...sharded.evidence);
          readLog.push(...sharded.readLog);
        } else {
          extraction = await this.traced("knowledge_extraction", { ...runBase, extractor: llm.id }, async () => llm.extract(evidence, scope), extractionCounts);
        }
        extractors = [llm.id];
      } catch {
        warnings.push(`${llm.id}:failed`);
        extraction = await this.traced("rule_extraction", runBase, async () => this.ruleExtractor.extract(evidence, scope), extractionCounts);
        extractors = [this.ruleExtractor.id];
      }
    } else {
      if (input.useLlm) warnings.push("llm:unconfigured");
      extraction = await this.traced("rule_extraction", runBase, async () => this.ruleExtractor.extract(evidence, scope), extractionCounts);
      extractors = [this.ruleExtractor.id];
    }
    // The model chose what to read, so this build is no longer determined by the repository
    // alone. Folding the read log into the revision is what keeps it reproducible; the read
    // itself stays out of the response-cache key so a cached answer is never keyed on it.
    if (readLog.length > 0) {
      const readLogDigest = digest(JSON.stringify(readLog.map((entry) => ({ tool: entry.tool, target: entry.target, contentHash: entry.contentHash })).sort((left, right) => left.target.localeCompare(right.target))));
      revision = digest(`${revision}:${readLogDigest}`);
      scope.revision = revision;
      runBase = { ...runBase, revision, fingerprint: digest(JSON.stringify({ repo: input.repo, revision, extractors: intendedExtractors, readLog: readLogDigest })) };
      for (const item of toolEvidence) evidence.push({ ...item, revision });
    }
    const extracted = extractionParts(extraction);
    const evidenceById = new Map(evidence.map((item) => [item.id, item]));
    const evidenceBySemanticKey = new Map<string, Evidence[]>();
    for (const item of evidence) {
      const key = evidenceSemanticKey(item);
      evidenceBySemanticKey.set(key, [...(evidenceBySemanticKey.get(key) ?? []), item]);
    }
    let extractedDrafts = extracted.drafts;
    if (extractors.includes(this.llmExtractor?.id ?? "")) {
      const grounded: KnowledgeDraft[] = [];
      let rejected = 0;
      let misplaced = 0;
      for (const draft of extractedDrafts) {
        const issues = citationIssues(draft, draft.evidenceIds.map((id) => evidenceById.get(id)));
        if (issues.length === 0) {
          grounded.push(draft);
          continue;
        }
        rejected += 1;
        if (issues.some((issue) => issue.reason !== "not_in_evidence")) misplaced += 1;
      }
      extractedDrafts = grounded;
      if (rejected > 0) warnings.push(`llm:ungrounded_cards_rejected:${rejected}`);
      if (misplaced > 0) warnings.push(`llm:misplaced_citations_rejected:${misplaced}`);
    }
    const clusterStage = await this.traced("cluster_materialization", runBase, async (trace) => {
      const previousClusters = await this.repository.readClusters?.() ?? [];
      const materialized = materializeClusters(extracted.clusters, evidence, scope, previousClusters);
      if (materialized.invalidCount > 0) warnings.push(`clusters:rejected:${materialized.invalidCount}`);
      const proposedClusterIds = new Set(materialized.clusters.map((cluster) => cluster.id));
      const proposedEvidenceIds = new Set(materialized.clusters.flatMap((cluster) => cluster.evidenceIds));
      const currentEvidenceIds = new Set(evidence.map((item) => item.id));
      const currentClusters = [...materialized.clusters];
      for (const old of previousClusters.filter((cluster) => cluster.repo === input.repo && !proposedClusterIds.has(cluster.id))) {
        const stillSupported = old.evidenceIds.every((id) => currentEvidenceIds.has(id));
        const superseded = old.evidenceIds.some((id) => proposedEvidenceIds.has(id));
        currentClusters.push(stillSupported && !superseded
          ? { ...old, revision: scope.revision }
          : { ...old, status: "stale", updatedAt: isoNow() });
      }
      const clusters = [...previousClusters.filter((cluster) => cluster.repo !== input.repo), ...currentClusters];
      const validClusterIds = new Set(currentClusters.filter((cluster) => cluster.status !== "stale" && cluster.status !== "rejected").map((cluster) => cluster.id));
      trace.addItem({ itemKey: "clusters", itemKind: "shard", disposition: "done", durationMs: 0 });
      return {
        clusters,
        validClusterIds,
        currentClusters,
        proposed: materialized.clusters.length,
        stale: currentClusters.filter((cluster) => cluster.status === "stale").length,
        rejected: materialized.invalidCount,
      };
    }, (value) => ({ proposed: value.proposed, stale: value.stale, rejected: value.rejected, total: value.clusters.length }));
    const { clusters, validClusterIds, currentClusters } = clusterStage;
    const drafts = extractedDrafts.flatMap((draft): KnowledgeDraft[] => {
      if (!draft.clusterEvidenceIds || !draft.clusterSubject || !draft.clusterShape) return [draft];
      const clusterId = stableClusterId({ subject: draft.clusterSubject, shape: draft.clusterShape, evidenceIds: draft.clusterEvidenceIds, confidence: draft.confidence, extractor: this.llmExtractor?.id ?? "unknown" }, input.repo);
      return validClusterIds.has(clusterId) ? [{ ...draft, clusterId }] : [];
    });
    // Deterministic rule output is an observation of evidence, not a claim, so the rule
    // extractor produces no knowledge cards at all. Those facts reach consumers through the
    // observation layer, which is projected on read.
    const knowledgeDrafts = extractors.includes(this.llmExtractor?.id ?? "") ? drafts : [];
    const cardStage = await this.traced("card_materialization", runBase, async (trace) => {
      const previous = await this.repository.readKnowledge();
      const previousById = new Map(previous.map((card) => [card.id, card]));
      let invalidatedCount = 0;
      const generatedCards = knowledgeDrafts.map((draft) => {
        const id = stableCardId(draft, input.repo);
        const old = previousById.get(id);
        const oldSupport = old ? supportFingerprint(old.evidenceIds, previousEvidenceById) : null;
        const currentSupport = supportFingerprint(draft.evidenceIds, evidenceById);
        const oldDependencies = old ? dependencyFingerprint(old.evidenceIds, old.targetSymbols, old.applicability.frameworks, previousEvidenceById, old.revision) : "[]";
        const currentDependencies = dependencyFingerprint(draft.evidenceIds, draft.targetSymbols ?? [], draft.applicability?.frameworks ?? [], evidenceById, scope.revision);
        const preserveLifecycle = Boolean(
          old &&
          old.sourceHash === digest(cardKey(draft, input.repo)) &&
          oldSupport !== null &&
          oldSupport === currentSupport &&
          oldDependencies === currentDependencies
        );
        const proposalProvenance: KnowledgeCard["proposalProvenance"] = extractors.includes(this.llmExtractor?.id ?? "")
          ? { source: "llm_extractor", actor: this.llmExtractor?.id ?? "unknown", note: "Semantic candidate proposed from validated evidence references" }
          : { source: "deterministic_extractor", actor: this.ruleExtractor.id, note: "Candidate produced by deterministic extraction rules" };
        const card = toCard(draft, scope, old, "extracted", preserveLifecycle, proposalProvenance);
        if (old && !preserveLifecycle && (old.status === "reviewed" || old.status === "verified")) {
          invalidatedCount += 1;
          return { ...card, status: "stale" as const, validationEvidenceIds: [] };
        }
        return card;
      });
      const generatedIds = new Set(generatedCards.map((card) => card.id));
      const preservedManual = previous.flatMap((card): KnowledgeCard[] => {
        if (card.repo !== input.repo || card.origin !== "manual" || generatedIds.has(card.id)) return [];
        const remappedEvidence = card.evidenceIds.map((id) => {
          const oldEvidence = previousEvidenceById.get(id);
          if (!oldEvidence) return undefined;
          const matches = evidenceBySemanticKey.get(evidenceSemanticKey(oldEvidence)) ?? [];
          return matches.length === 1 ? matches[0] : undefined;
        });
        if (remappedEvidence.some((item) => !item)) return [];
        const dependenciesStable = dependencyFingerprint(card.evidenceIds, card.targetSymbols, card.applicability.frameworks, previousEvidenceById, card.revision)
          === dependencyFingerprint(remappedEvidence.map((item) => item!.id), card.targetSymbols, card.applicability.frameworks, evidenceById, scope.revision);
        const requiresReevaluation = !dependenciesStable && (card.status === "reviewed" || card.status === "verified");
        if (requiresReevaluation) invalidatedCount += 1;
        return [{
          ...card,
          revision: scope.revision,
          applicability: { ...card.applicability, revision: scope.revision },
          evidenceIds: remappedEvidence.map((item) => item!.id),
          status: requiresReevaluation ? "stale" : card.status,
          validationEvidenceIds: requiresReevaluation ? [] : card.validationEvidenceIds,
          updatedAt: requiresReevaluation ? isoNow() : card.updatedAt,
        }];
      });
      // Observations already in storage are carried forward untouched rather than removed or
      // re-staled: they are invisible to every knowledge read path, and rewriting them would
      // churn the knowledge-changes audit trail for no readable effect.
      const untouched = previous.filter((card) => card.repo === input.repo && !isKnowledgeLayer(card) && !generatedIds.has(card.id));
      const cards = [
        ...previous.filter((card) => card.repo !== input.repo),
        ...untouched,
        ...preservedManual,
        ...generatedCards,
      ];
      const currentIds = new Set(cards.map((card) => card.id));
      for (const old of previous) {
        if (old.repo === input.repo && isKnowledgeLayer(old) && !currentIds.has(old.id) && old.status !== "rejected") {
          if (old.status === "reviewed" || old.status === "verified") invalidatedCount += 1;
          cards.push({ ...old, status: "stale", updatedAt: isoNow() });
        }
      }
      if (invalidatedCount > 0) warnings.push(`knowledge:invalidated_by_evidence_change:${invalidatedCount}`);
      trace.addItem({ itemKey: "cards", itemKind: "draft", disposition: "done", durationMs: 0 });
      return { previousById, cards, generated: generatedCards.length, preserved: preservedManual.length, invalidated: invalidatedCount };
    }, (value) => ({ generated: value.generated, preserved: value.preserved, invalidated: value.invalidated, total: value.cards.length }));
    const { previousById, cards } = cardStage;
    const relationStage = await this.traced("relations", runBase, async (trace) => {
      const previousRelations = await this.repository.readRelations?.() ?? [];
      const retainedEvidence = [...new Map([...previousEvidence, ...evidence].map((item) => [item.id, item])).values()];
      const currentRelations = buildRelations(evidence, cards.filter((card) => card.repo === input.repo && card.status !== "stale" && isKnowledgeLayer(card)), scope, previousRelations, retainedEvidence);
      const relations = [...previousRelations.filter((item) => item.repo !== input.repo), ...currentRelations];
      trace.addItem({ itemKey: "relations", itemKind: "index", disposition: "done", durationMs: 0 });
      return { currentRelations, relations };
    }, (value) => ({ current: value.currentRelations.length, total: value.relations.length }));
    const { currentRelations, relations } = relationStage;
    await this.repository.writeBuild(evidence, cards, relations, clusters);
    const changes = cards.flatMap((card) => {
      if (card.repo !== input.repo) return [];
      const before = previousById.get(card.id) ?? null;
      return before && JSON.stringify(before) === JSON.stringify(card)
        ? []
        : [knowledgeChange("build", extractors.join("+") || "static-build", "Repository extraction refresh", before, card)];
    });
    await this.repository.appendKnowledgeChanges?.(changes);
    await this.traced("index_rebuild", runBase, async (trace) => {
      await this.reindex(cards);
      trace.addItem({ itemKey: "cards_index", itemKind: "index", disposition: "done", durationMs: 0 });
    }, () => ({ indexed: cards.length }));
    return { repo: input.repo, revision, evidenceCount: evidence.length, knowledgeCount: cards.length, relationCount: currentRelations.length, clusterCount: currentClusters.length, extractor: extractors, warnings };
  }

  async query(raw: ContextRequest): Promise<ContextPack> {
    const parsedInput = ContextRequestSchema.parse(raw);
    const parsed = { ...parsedInput, repo: resolve(parsedInput.repo) };
    const requestedProjectMap = (await this.repository.readProjectMaps?.() ?? []).find((item) => item.repo === parsed.repo && (!parsed.revision || item.revision === parsed.revision)) ?? null;
    const parsedRequest = {
      ...parsed,
      languages: parsed.languages.length > 0 ? parsed.languages : requestedProjectMap?.languages.length ? requestedProjectMap.languages : ["python"],
      frameworks: parsed.frameworks.length > 0 ? parsed.frameworks : requestedProjectMap?.frameworks.length ? requestedProjectMap.frameworks : ["pytest"],
    };
    let structural: Awaited<ReturnType<StructuralContextProvider["analyze"]>> | undefined;
    const structuralAbstentions: string[] = [];
    if (this.structuralContextProvider) {
      try {
        structural = await this.structuralContextProvider.analyze(parsedRequest);
        structuralAbstentions.push(...structural.warnings);
      } catch {
        structuralAbstentions.push("structural_impact_unavailable");
      }
    } else {
      structuralAbstentions.push("structural_impact_provider_not_configured");
    }
    const inferredTargetSymbols = parsedRequest.targetSymbols.length === 0 ? structural?.targetSymbols ?? [] : [];
    const request = inferredTargetSymbols.length > 0 ? { ...parsedRequest, targetSymbols: inferredTargetSymbols } : parsedRequest;
    const retrievalQuery = [request.task, ...request.changedFiles, ...request.targetSymbols].filter(Boolean).join(" ");
    const hits = await this.index.search(retrievalQuery, {
      repo: request.repo,
      ...(request.revision ? { revision: request.revision } : {}),
      changedFiles: request.changedFiles,
      targetSymbols: request.targetSymbols,
      includeCandidates: request.includeCandidates,
      limit: request.limit,
    });
    const cards = (await this.repository.readKnowledge()).filter(isKnowledgeLayer);
    const evidence = await this.repository.readEvidence();
    const projectMap = requestedProjectMap;
    const clusters = await this.repository.readClusters?.() ?? [];
    const clustersById = new Map(clusters.map((cluster) => [cluster.id, cluster]));
    const relations = await this.repository.readRelations?.() ?? [];
    const byId = new Map(cards.map((card) => [card.id, card]));
    const selected = hits.map((hit) => byId.get(hit.id)).filter((card): card is KnowledgeCard => Boolean(card));
    const matchedIds = new Set(selected.map((card) => card.id));
    const matchingConflicts = relations.filter((item) => item.repo === request.repo && item.type === "CONFLICTS_WITH" && !item.resolvedAt && (matchedIds.has(item.from.id) || matchedIds.has(item.to.id)));
    const conflictedIds = new Set(matchingConflicts.flatMap((item) => [item.from.id, item.to.id]));
    const eligibleByStatus = selected.filter((card) => card.status === "reviewed" || card.status === "verified" || (request.includeCandidates && card.status === "candidate"));
    const eligibleByCluster = eligibleByStatus.filter((card) => !card.clusterId || clustersById.get(card.clusterId)?.status === "reviewed" || (request.includeCandidates && clustersById.get(card.clusterId)?.status === "candidate"));
    const eligible = eligibleByCluster.filter((card) => isApplicable(card, request));
    const knowledge = eligible.filter((card) => !conflictedIds.has(card.id));
    const evidenceIds = new Set(knowledge.flatMap((card) => card.evidenceIds));
    const baseEvidence = evidence.filter((item) => evidenceIds.has(item.id));
    const retrieval = hits.map((hit) => ({ id: hit.id, channels: hit.channels, matchedFields: hit.matchedFields, score: hit.score }));
    const selectedNodeIds = new Set([...knowledge.map((card) => card.id), ...baseEvidence.map((item) => item.id)]);
    const persistedRelations = relations.filter((item) => item.repo === request.repo && ((selectedNodeIds.has(item.from.id) || selectedNodeIds.has(item.to.id)) || matchingConflicts.some((conflict) => conflict.id === item.id)));
    const relatedEvidenceIds = new Set(persistedRelations.flatMap((item) => [
      ...item.evidenceIds,
      ...(item.from.kind === "evidence" ? [item.from.id] : []),
      ...(item.to.kind === "evidence" ? [item.to.id] : []),
    ]));
    const selectedEvidence = evidence.filter((item) => evidenceIds.has(item.id) || relatedEvidenceIds.has(item.id));
    const usableHits = retrieval.filter((hit) => knowledge.some((card) => card.id === hit.id));
    const mode = knowledge.length > 0 ? "evidence_augmented" : "ordinary_agent";
    const unique = (values: string[]): string[] => [...new Set(values.filter(Boolean))];
    const testEvidence = selectedEvidence.filter((item) => item.sourceType === "test_code");
    const existingTestEvidence = testEvidence.filter((item) => item.payload.isTest === true);
    const suggestedCommands = [...new Map(testEvidence.flatMap((item): string[][] => {
      const framework = typeof item.payload.framework === "string" ? item.payload.framework : "";
      if (framework === "pytest") return [["pytest", item.path]];
      if (framework === "go-testing") {
        const separator = item.path.lastIndexOf("/");
        const directory = separator >= 0 ? `./${item.path.slice(0, separator)}` : ".";
        return [["go", "test", directory]];
      }
      if (framework === "rust-test" && item.symbol) return [["cargo", "test", item.symbol]];
      return [];
    }).map((command) => [JSON.stringify(command), command])).values()];
    const runInstructions = [...new Map([
      ...runInstructionsFromEvidence(selectedEvidence),
      ...(projectMap?.runInstructions ?? []),
    ].map((item) => [JSON.stringify(item), item])).values()];
    const relatedPaths = unique([...request.changedFiles, ...(structural?.relatedPaths ?? []), ...knowledge.map((card) => card.path), ...selectedEvidence.map((item) => item.path)]);
    const structuralRelations: KnowledgeRelation[] = structural ? request.targetSymbols.flatMap((symbol) => structural.relatedPaths.map((path) => {
      const from = { kind: "production_symbol" as const, id: symbol };
      const to = { kind: "production_symbol" as const, id: path };
      return {
        id: relationId("IMPACTS", from, to, request.repo),
        type: "IMPACTS" as const,
        from,
        to,
        repo: request.repo,
        revision: request.revision ?? knowledge[0]?.revision ?? "unknown",
        evidenceIds: [],
        confidence: 0.9,
        source: "codegraph.cli",
        createdAt: isoNow(),
      };
    })) : [];
    const requestedEvidence = evidence.filter((item) => item.repo === request.repo
      && (!request.revision || item.revision === request.revision)
      && (request.changedFiles.includes(item.path) || (item.symbol !== "" && request.targetSymbols.includes(item.symbol))));
    const observationEvidence = [...new Map([...selectedEvidence, ...requestedEvidence].map((item) => [item.id, item])).values()];
    const newestFirst = [...observationEvidence].sort((left, right) => right.extractedAt.localeCompare(left.extractedAt));
    const observationRevision = request.revision ?? newestFirst[0]?.revision;
    const observations = observationRevision
      ? materializeObservations(observationEvidence.filter((item) => item.revision === observationRevision), { repo: request.repo, revision: observationRevision })
      : [];
    const abstentions: string[] = [];
    if (eligibleByStatus.length > eligibleByCluster.length) abstentions.push("unreviewed_or_missing_cluster_excluded");
    if (eligibleByCluster.length > eligible.length) abstentions.push("inapplicable_knowledge_excluded");
    if (eligible.length > knowledge.length) abstentions.push("conflicting_knowledge_excluded");
    if (request.targetSymbols.length === 0) abstentions.push("target_symbols_not_provided");
    if (request.changedFiles.length === 0) abstentions.push("changed_files_not_provided");
    const historicalRegressionEvidence = selectedEvidence.filter((item) => item.sourceType === "bug_history" || item.sourceType === "issue");
    const environmentProfiles = selectedEvidence.flatMap((item) => {
      const raw = item.payload.environmentProfile;
      if (raw === null || typeof raw !== "object") return [];
      const profile = raw as Record<string, unknown>;
      const strings = (value: unknown): string[] => Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === "string") : [];
      return [{ sourceRef: item.sourceRef, runCommands: strings(profile.runCommands), workingDirectories: strings(profile.workingDirectories), environmentVariableNames: strings(profile.environmentVariableNames), serviceImages: strings(profile.serviceImages) }];
    });
    if (knowledge.every((card) => card.kind !== "historical_bug") && historicalRegressionEvidence.length === 0) abstentions.push("no_supported_historical_regression");
    if (runInstructions.length === 0) abstentions.push("no_evidence_backed_run_instruction");
    abstentions.push(...structuralAbstentions);
    return {
      mode,
      reason: mode === "ordinary_agent" ? (request.includeCandidates ? "no_matching_knowledge" : "no_applicable_reviewed_or_verified_knowledge") : null,
      request,
      projectMap,
      knowledge,
      evidence: selectedEvidence,
      evidenceClusters: [...new Set(knowledge.flatMap((card) => card.clusterId ? [card.clusterId] : []))].flatMap((id) => {
        const cluster = clustersById.get(id);
        return cluster ? [cluster] : [];
      }),
      observations,
      relations: [...persistedRelations, ...structuralRelations],
      impactSummary: {
        changedFiles: request.changedFiles,
        targetSymbols: request.targetSymbols,
        targetSymbolSource: parsedRequest.targetSymbols.length > 0 ? "request" : inferredTargetSymbols.length > 0 ? "codegraph" : "unavailable",
        relatedPaths,
        source: structural?.source ?? (relatedPaths.length > 0 ? "request_and_retrieval" : "unavailable"),
      },
      existingTests: existingTestEvidence.map((item) => ({ path: item.path, symbol: item.symbol, sourceRef: item.sourceRef, evidenceId: item.id })),
      testDesignKnowledge: knowledge,
      fixturesAndMocks: {
        fixtures: unique(observations.filter((item) => item.kind === "fixture").map((item) => item.subject)),
        factories: unique(observations.filter((item) => item.kind === "dependency").map((item) => item.subject)),
        mocks: unique(observations.filter((item) => item.kind === "mock").map((item) => item.subject)),
      },
      oracles: knowledge.map((card) => ({ knowledgeId: card.id, oracle: card.oracle, evidenceIds: card.evidenceIds })),
      historicalRegressions: knowledge.filter((card) => card.kind === "historical_bug"),
      historicalRegressionEvidence,
      environmentProfiles,
      executionSignals: executionSignalsFromEvidence(selectedEvidence),
      runInstructions,
      evidenceAndConfidence: knowledge.map((card) => ({ knowledgeId: card.id, evidenceIds: card.evidenceIds, confidence: card.confidence, status: card.status })),
      abstentions,
      suggestedCommands,
      retrieval: usableHits,
    };
  }

  async createEvaluationPlan(raw: CreateEvaluationPlanRequest): Promise<EvaluationPlan> {
    const request = CreateEvaluationPlanRequestSchema.parse(raw);
    const taskIds = request.tasks.map((task) => task.id);
    if (new Set(taskIds).size !== taskIds.length) throw new Error("Evaluation task IDs must be unique within a plan");
    const frozen = { ...request, repo: resolve(request.repo) };
    const promptHash = digest(JSON.stringify({ promptTemplate: frozen.promptTemplate, tasks: frozen.tasks.map((task) => ({ id: task.id, prompt: task.prompt })) }));
    const toolPolicy = frozen.variantTools
      ? Object.fromEntries(Object.entries(frozen.variantTools).sort(([left], [right]) => left.localeCompare(right)).map(([variant, tools]) => [variant, [...tools].sort()]))
      : { shared: [...frozen.tools].sort() };
    const toolPolicyHash = digest(JSON.stringify(toolPolicy));
    const protocolVersion = "evaluation.v2" as const;
    const id = `eval_${digest(JSON.stringify({ ...frozen, promptHash, toolPolicyHash, protocolVersion })).slice(0, 24)}`;
    const existing = await this.repository.readEvaluationPlans?.() ?? [];
    const current = existing.find((plan) => plan.id === id);
    if (current) return current;
    const plan: EvaluationPlan = { ...frozen, id, promptHash, toolPolicyHash, protocolVersion, status: "frozen", createdAt: isoNow() };
    if (!this.repository.writeEvaluationPlans) throw new Error("Evaluation plan storage is not configured");
    await this.repository.writeEvaluationPlans([...existing, plan]);
    return plan;
  }

  async listEvaluationPlans(): Promise<EvaluationPlan[]> {
    return await this.repository.readEvaluationPlans?.() ?? [];
  }

  async evaluationRunManifest(planId: string, rawRunSetId: string): Promise<EvaluationRunManifest> {
    const runSetId = EvaluationRunSetIdSchema.parse(rawRunSetId);
    const plan = (await this.repository.readEvaluationPlans?.() ?? []).find((item) => item.id === planId);
    if (!plan) throw new Error(`Unknown evaluation plan: ${planId}`);
    if (plan.protocolVersion !== "evaluation.v2") throw new Error("Legacy evaluation plans cannot produce integrity-bound run manifests");
    const runs = plan.tasks.flatMap((task) => EVALUATION_VARIANTS.map((variant) => evaluationRunSpec(plan, task, variant, runSetId)));
    return { protocolVersion: "evaluation.v2", planId, runSetId, repo: plan.repo, revision: plan.revision, promptHash: plan.promptHash, toolPolicyHash: plan.toolPolicyHash, runs };
  }

  async listProjectMaps(repo?: string): Promise<ProjectMap[]> {
    const maps = await this.repository.readProjectMaps?.() ?? [];
    return repo ? maps.filter((item) => item.repo === resolve(repo)) : maps;
  }

  async recordEvaluationObservation(raw: RecordEvaluationObservationRequest): Promise<EvaluationObservation> {
    const request = RecordEvaluationObservationRequestSchema.parse(raw);
    const plan = (await this.repository.readEvaluationPlans?.() ?? []).find((item) => item.id === request.planId);
    if (!plan) throw new Error(`Unknown evaluation plan: ${request.planId}`);
    if (plan.protocolVersion !== "evaluation.v2") throw new Error("Legacy evaluation plans cannot accept integrity-bound observations");
    const task = plan.tasks.find((item) => item.id === request.taskId);
    if (!task) throw new Error(`Unknown evaluation task in plan ${plan.id}: ${request.taskId}`);
    if (request.model !== plan.model || request.promptHash !== plan.promptHash || request.toolPolicyHash !== plan.toolPolicyHash) {
      throw new Error("Evaluation observation does not match the frozen model, prompt, or tool policy");
    }
    const runSpec = evaluationRunSpec(plan, task, request.variant, request.runSetId);
    if (request.runId !== runSpec.runId || request.runSpecHash !== runSpec.runSpecHash) throw new Error("Evaluation observation does not match the frozen run set and specification");
    const requireSubset = (observed: string[], expected: string[], label: string): void => {
      if (observed.some((id) => !expected.includes(id))) throw new Error(`${label} contains IDs not frozen in the evaluation task`);
    };
    requireSubset(request.coveredBoundaryIds, task.criticalBoundaryIds, "coveredBoundaryIds");
    requireSubset(request.detectedSeededBugIds, task.seededBugIds, "detectedSeededBugIds");
    requireSubset(request.effectiveOracleIds, task.requiredOracleIds, "effectiveOracleIds");
    if ((task.fixtureMockCriteria.length > 0) !== (request.fixtureMockCorrect !== null)) {
      throw new Error("fixtureMockCorrect must be recorded exactly when the frozen task defines fixture/mock criteria");
    }
    if (request.tokenUsage > plan.budget.maxTokens || request.toolCalls > plan.budget.maxToolCalls || request.durationMs > plan.budget.maxDurationMs) {
      throw new Error("Evaluation observation exceeds the frozen plan budget");
    }
    if (new Set(request.usedTools).size !== request.usedTools.length || request.usedTools.some((tool) => !runSpec.agentInput.tools.includes(tool))) {
      throw new Error("Evaluation observation contains duplicate or non-whitelisted tools");
    }
    const evidence = await this.repository.readEvidence();
    const cited = request.evidenceIds.map((id) => evidence.find((item) => item.id === id));
    if (cited.some((item) => !item || item.repo !== plan.repo || item.revision !== plan.revision || item.sourceType !== "execution_result")) {
      throw new Error("Evaluation observations must cite execution evidence from the frozen repository revision");
    }
    const expectedOutcome = request.executionPassed ? "passed" : "failed";
    if (!cited.some((item) => item?.payload.outcome === expectedOutcome || (!request.executionPassed && item?.payload.outcome === "error"))) {
      throw new Error("Evaluation execution outcome must agree with at least one cited execution evidence record");
    }
    const bindingMatches = cited.some((item) => {
      const binding = item?.payload.evaluation;
      if (binding === null || typeof binding !== "object") return false;
      const value = binding as {
        planId?: unknown; runSetId?: unknown; taskId?: unknown; variant?: unknown; runId?: unknown; runSpecHash?: unknown;
        model?: unknown; promptHash?: unknown; toolPolicyHash?: unknown; usedTools?: unknown;
        tokenUsage?: unknown; toolCalls?: unknown; durationMs?: unknown; duplicateTestCount?: unknown; brittleTestCount?: unknown;
      };
      return value.planId === plan.id && value.runSetId === request.runSetId && value.taskId === task.id
        && value.variant === request.variant && value.runId === request.runId && value.runSpecHash === request.runSpecHash
        && value.model === request.model && value.promptHash === request.promptHash && value.toolPolicyHash === request.toolPolicyHash
        && Array.isArray(value.usedTools) && value.usedTools.every((tool): tool is string => typeof tool === "string") && sameStringSet(value.usedTools, request.usedTools)
        && value.tokenUsage === request.tokenUsage && value.toolCalls === request.toolCalls && value.durationMs === request.durationMs
        && value.duplicateTestCount === request.duplicateTestCount && value.brittleTestCount === request.brittleTestCount;
    });
    if (!bindingMatches) throw new Error("Evaluation evidence must be explicitly bound to this plan, task, variant, and run");
    const id = `evalobs_${digest(JSON.stringify({ planId: plan.id, runSetId: request.runSetId, taskId: task.id, variant: request.variant, runId: request.runId })).slice(0, 24)}`;
    const previousObservations = await this.repository.readEvaluationObservations?.() ?? [];
    const previous = previousObservations.find((item) => item.id === id);
    if (previous) {
      const previousRequest = RecordEvaluationObservationRequestSchema.parse(previous);
      if (JSON.stringify(previousRequest) === JSON.stringify(request)) return previous;
      throw new Error("An observation for this run already exists and is immutable; use a new runSetId to rerun");
    }
    const recordedAt = isoNow();
    const observation: EvaluationObservation = { ...request, id, recordedAt };
    if (!this.repository.appendEvaluationObservation) throw new Error("Evaluation observation storage is not configured");
    await this.repository.appendEvaluationObservation(observation);
    return observation;
  }

  async listEvaluationObservations(planId?: string, runSetId?: string): Promise<EvaluationObservation[]> {
    const observations = await this.repository.readEvaluationObservations?.() ?? [];
    return observations.filter((item) => (!planId || item.planId === planId) && (!runSetId || item.runSetId === runSetId));
  }

  async evaluationReport(planId: string, rawRunSetId = ""): Promise<EvaluationReport> {
    const plan = (await this.repository.readEvaluationPlans?.() ?? []).find((item) => item.id === planId);
    if (!plan) throw new Error(`Unknown evaluation plan: ${planId}`);
    const all = (await this.repository.readEvaluationObservations?.() ?? []).filter((item) => item.planId === planId);
    const availableRunSetIds = [...new Set(all.map((item) => item.runSetId))].sort();
    const requestedRunSetId = rawRunSetId.trim() ? EvaluationRunSetIdSchema.parse(rawRunSetId) : "";
    const runSetId = plan.protocolVersion === "evaluation.v2"
      ? requestedRunSetId || (availableRunSetIds.length === 1 ? availableRunSetIds[0]! : null)
      : null;
    const scoped = plan.protocolVersion === "evaluation.v2" ? (runSetId ? all.filter((item) => item.runSetId === runSetId) : []) : all;
    const latest = new Map<string, EvaluationObservation>();
    for (const observation of scoped) {
      const key = `${observation.taskId}:${observation.variant}`;
      const previous = latest.get(key);
      if (!previous || previous.recordedAt < observation.recordedAt) latest.set(key, observation);
    }
    const completeTasks = plan.tasks.filter((task) => EVALUATION_VARIANTS.every((variant) => latest.has(`${task.id}:${variant}`)));
    const rowsByVariant = Object.fromEntries(EVALUATION_VARIANTS.map((variant) => [
      variant,
      completeTasks.map((task) => ({ task, observation: latest.get(`${task.id}:${variant}`)! })),
    ])) as Record<EvaluationVariant, Array<{ task: EvaluationTask; observation: EvaluationObservation }>>;
    const variants = Object.fromEntries(EVALUATION_VARIANTS.map((variant) => [variant, evaluationSummary(rowsByVariant[variant])])) as Record<EvaluationVariant, EvaluationVariantSummary>;
    let taskWins = 0;
    let taskLosses = 0;
    for (const task of completeTasks) {
      const baseline = taskQuality(task, latest.get(`${task.id}:B_codegraph`)!);
      const candidate = taskQuality(task, latest.get(`${task.id}:C_codegraph_testknowledge`)!);
      if (candidate > baseline + 1e-9) taskWins += 1;
      else if (candidate < baseline - 1e-9) taskLosses += 1;
    }
    const baseline = variants.B_codegraph;
    const candidate = variants.C_codegraph_testknowledge;
    const deltaCvsB = {
      boundaryCoverageRate: candidate.boundaryCoverageRate - baseline.boundaryCoverageRate,
      seededBugDetectionRate: candidate.seededBugDetectionRate - baseline.seededBugDetectionRate,
      effectiveOracleRate: candidate.effectiveOracleRate - baseline.effectiveOracleRate,
      fixtureMockCorrectRate: candidate.fixtureMockCorrectRate === null || baseline.fixtureMockCorrectRate === null ? null : candidate.fixtureMockCorrectRate - baseline.fixtureMockCorrectRate,
      executionPassRate: candidate.executionPassRate - baseline.executionPassRate,
      invalidAssertionCount: candidate.invalidAssertionCount - baseline.invalidAssertionCount,
      duplicateTestCount: candidate.duplicateTestCount - baseline.duplicateTestCount,
      brittleTestCount: candidate.brittleTestCount - baseline.brittleTestCount,
      tokenIncreaseRatio: increaseRatio(candidate.averageTokens, baseline.averageTokens),
      toolCallIncreaseRatio: increaseRatio(candidate.averageToolCalls, baseline.averageToolCalls),
      durationIncreaseRatio: increaseRatio(candidate.averageDurationMs, baseline.averageDurationMs),
    };
    const reasons: string[] = [];
    if (plan.protocolVersion !== "evaluation.v2") reasons.push("legacy_evaluation_protocol_without_run_spec_integrity");
    if (plan.protocolVersion === "evaluation.v2" && !runSetId && availableRunSetIds.length > 1) reasons.push("run_set_selection_required");
    if (completeTasks.length < plan.acceptance.minimumCompleteTasks) reasons.push("complete_task_count_below_threshold");
    const winRate = completeTasks.length === 0 ? 0 : taskWins / completeTasks.length;
    const lossRate = completeTasks.length === 0 ? 0 : taskLosses / completeTasks.length;
    if (winRate < plan.acceptance.minimumTaskWinRate) reasons.push("task_win_rate_below_threshold");
    if (lossRate > plan.acceptance.maximumTaskLossRate) reasons.push("task_loss_rate_above_threshold");
    if (deltaCvsB.executionPassRate < 0) reasons.push("execution_pass_rate_regressed");
    if (deltaCvsB.boundaryCoverageRate < 0) reasons.push("boundary_coverage_regressed");
    if (deltaCvsB.seededBugDetectionRate < 0) reasons.push("seeded_bug_detection_regressed");
    if (deltaCvsB.effectiveOracleRate < 0) reasons.push("effective_oracle_rate_regressed");
    if ((deltaCvsB.fixtureMockCorrectRate ?? 0) < 0) reasons.push("fixture_mock_correctness_regressed");
    if (deltaCvsB.invalidAssertionCount > 0) reasons.push("invalid_assertions_increased");
    if (deltaCvsB.duplicateTestCount > 0) reasons.push("duplicate_tests_increased");
    if (deltaCvsB.brittleTestCount > 0) reasons.push("brittle_tests_increased");
    if (deltaCvsB.tokenIncreaseRatio > plan.acceptance.maximumTokenIncreaseRatio) reasons.push("token_cost_above_threshold");
    if (deltaCvsB.toolCallIncreaseRatio > plan.acceptance.maximumToolCallIncreaseRatio) reasons.push("tool_calls_above_threshold");
    if (deltaCvsB.durationIncreaseRatio > plan.acceptance.maximumDurationIncreaseRatio) reasons.push("duration_above_threshold");
    const behaviorImproved = deltaCvsB.boundaryCoverageRate > 0 || deltaCvsB.seededBugDetectionRate > 0 || deltaCvsB.effectiveOracleRate > 0 || (deltaCvsB.fixtureMockCorrectRate ?? 0) > 0
      || deltaCvsB.invalidAssertionCount < 0 || deltaCvsB.duplicateTestCount < 0 || deltaCvsB.brittleTestCount < 0;
    if (!behaviorImproved) reasons.push("no_behavior_metric_improved");
    const verdict = plan.protocolVersion !== "evaluation.v2" || completeTasks.length < plan.acceptance.minimumCompleteTasks ? "insufficient_data" : reasons.length === 0 ? "improved" : "not_demonstrated";
    return { planId, runSetId, availableRunSetIds, completeTaskCount: completeTasks.length, taskWins, taskLosses, taskTies: completeTasks.length - taskWins - taskLosses, variants, deltaCvsB, verdict, reasons };
  }

  async review(id: string, raw: ReviewRequest): Promise<KnowledgeCard> {
    const request = ReviewRequestSchema.parse(raw);
    const cards = await this.repository.readKnowledge();
    const current = cards.find((card) => card.id === id);
    if (!current) throw new Error(`Unknown knowledge card: ${id}`);
    if (request.status === "reviewed" && current.status === "rejected") throw new Error("Rejected knowledge must be rewritten as a new candidate before review");
    const evidence = await this.repository.readEvidence();
    if (request.status === "reviewed") {
      const mapRevision = (await this.repository.readProjectMaps?.() ?? []).find((item) => item.repo === current.repo)?.revision;
      const latestEvidence = evidence.filter((item) => item.repo === current.repo).sort((left, right) => right.extractedAt.localeCompare(left.extractedAt))[0];
      const currentRevision = mapRevision ?? latestEvidence?.revision;
      if (!currentRevision || current.revision !== currentRevision || current.evidenceIds.some((evidenceId) => !evidence.some((item) => item.id === evidenceId && item.repo === current.repo && item.revision === currentRevision))) {
        throw new Error("Knowledge can be reviewed only when all supporting evidence belongs to the current repository revision");
      }
    }
    if (request.status === "reviewed" && current.clusterId) {
      const cluster = (await this.repository.readClusters?.() ?? []).find((item) => item.id === current.clusterId);
      if (!cluster || cluster.status !== "reviewed") throw new Error("Clustered knowledge can be reviewed only after its evidence cluster is reviewed");
    }
    const next = { ...current, status: request.status, validationEvidenceIds: current.status === "verified" ? [] : current.validationEvidenceIds, updatedAt: isoNow() };
    const relations = await this.repository.readRelations?.() ?? [];
    const updatedRelations = current.status === "verified"
      ? relations.filter((relation) => !(relation.type === "VERIFIED_BY" && relation.from.kind === "knowledge" && relation.from.id === id))
      : relations;
    await this.repository.writeBuild(evidence, cards.map((card) => card.id === id ? next : card), updatedRelations);
    await this.repository.appendReview({ knowledgeId: id, ...request, createdAt: isoNow() });
    await this.repository.appendKnowledgeChanges?.([knowledgeChange("review", request.reviewer, request.note, current, next)]);
    await this.reindex(cards.map((card) => card.id === id ? next : card));
    return next;
  }

  async listClusters(repo?: string): Promise<EvidenceCluster[]> {
    const clusters = await this.repository.readClusters?.() ?? [];
    return repo ? clusters.filter((cluster) => cluster.repo === resolve(repo)) : clusters;
  }

  async reviewCluster(id: string, raw: ReviewRequest): Promise<EvidenceCluster> {
    const request = ReviewRequestSchema.parse(raw);
    const clusters = await this.repository.readClusters?.() ?? [];
    const current = clusters.find((cluster) => cluster.id === id);
    if (!current) throw new Error(`Unknown evidence cluster: ${id}`);
    if (current.status === "stale") throw new Error(`Stale evidence cluster cannot be reviewed: ${id}`);
    const now = isoNow();
    const next = { ...current, status: request.status, updatedAt: now };
    const updatedClusters = clusters.map((cluster) => cluster.id === id ? next : cluster);
    const cards = await this.repository.readKnowledge();
    const updatedCards = request.status === "rejected"
      ? cards.map((card) => card.clusterId === id ? { ...card, status: "rejected" as const, updatedAt: now } : card)
      : cards;
    await this.repository.writeBuild(await this.repository.readEvidence(), updatedCards, await this.repository.readRelations?.(), updatedClusters);
    await this.repository.appendClusterReview?.({ clusterId: id, ...request, createdAt: now });
    if (request.status === "rejected") {
      const changes = cards.flatMap((card) => {
        const after = updatedCards.find((item) => item.id === card.id);
        return after && after !== card ? [knowledgeChange("cluster_rejection", request.reviewer, request.note, card, after)] : [];
      });
      await this.repository.appendKnowledgeChanges?.(changes);
    }
    await this.reindex(updatedCards);
    return next;
  }

  async createKnowledge(raw: CreateKnowledgeRequest): Promise<KnowledgeCard> {
    const parsed = CreateKnowledgeRequestSchema.parse(raw);
    const request = { ...parsed, repo: resolve(parsed.repo) };
    const evidence = await this.repository.readEvidence();
    validateManualKnowledgeRequest(request, new Map(evidence.map((item) => [item.id, item])), "A manual knowledge card");
    const draft = manualDraft(request);
    const cards = await this.repository.readKnowledge();
    const id = stableCardId(draft, request.repo);
    const previous = cards.find((item) => item.id === id);
    const card = { ...toCard(draft, { repo: request.repo, revision: request.revision }, previous, "manual", false, request.proposalProvenance), origin: "manual" as const };
    const updatedCards = [...cards.filter((item) => item.id !== id), card];
    const relations = await this.repository.readRelations?.() ?? [];
    const additions = request.evidenceIds.map((evidenceId): KnowledgeRelation => {
      const from = { kind: "knowledge" as const, id };
      const to = { kind: "evidence" as const, id: evidenceId };
      return { id: relationId("SUPPORTED_BY", from, to, request.repo), type: "SUPPORTED_BY", from, to, repo: request.repo, revision: request.revision, evidenceIds: [evidenceId], confidence: 1, source: "manual-knowledge.v1", createdAt: isoNow() };
    });
    const retainedRelations = relations.filter((item) => !((item.type === "SUPPORTED_BY" || item.type === "VERIFIED_BY" || item.type === "INVALIDATED_BY") && item.from.kind === "knowledge" && item.from.id === id));
    await this.repository.writeBuild([], updatedCards, [...retainedRelations, ...additions]);
    await this.repository.appendKnowledgeChanges?.([knowledgeChange("create", "manual", "Manual evidence-bound knowledge created or rewritten", previous ?? null, card)]);
    await this.reindex(updatedCards);
    return card;
  }

  async createKnowledgeBatch(raw: CreateKnowledgeBatchRequest): Promise<KnowledgeCard[]> {
    const parsed = CreateKnowledgeBatchRequestSchema.parse(raw);
    const request = { ...parsed, repo: resolve(parsed.repo) };
    const expanded = request.cards.map((card) => CreateKnowledgeRequestSchema.parse({ ...card, repo: request.repo, revision: request.revision, proposalProvenance: request.proposalProvenance }));
    const evidence = await this.repository.readEvidence();
    const evidenceById = new Map(evidence.map((item) => [item.id, item]));
    expanded.forEach((card, index) => validateManualKnowledgeRequest(card, evidenceById, `Manual knowledge pack card ${index + 1}`));

    const drafts = expanded.map(manualDraft);
    const ids = drafts.map((draft) => stableCardId(draft, request.repo));
    if (new Set(ids).size !== ids.length) throw new Error("A manual knowledge pack cannot contain duplicate card identities");

    const cards = await this.repository.readKnowledge();
    const existingById = new Map(cards.map((card) => [card.id, card]));
    const imported = drafts.map((draft, index) => {
      const previous = existingById.get(ids[index]!);
      return { ...toCard(draft, { repo: request.repo, revision: request.revision }, previous, "manual", false, request.proposalProvenance), origin: "manual" as const };
    });
    const importedIds = new Set(imported.map((card) => card.id));
    const updatedCards = [...cards.filter((card) => !importedIds.has(card.id)), ...imported];
    const relations = await this.repository.readRelations?.() ?? [];
    const retainedRelations = relations.filter((relation) => !(
      (relation.type === "SUPPORTED_BY" || relation.type === "VERIFIED_BY" || relation.type === "INVALIDATED_BY")
      && relation.from.kind === "knowledge"
      && importedIds.has(relation.from.id)
    ));
    const supportRelations = imported.flatMap((card) => card.evidenceIds.map((evidenceId): KnowledgeRelation => {
      const from = { kind: "knowledge" as const, id: card.id };
      const to = { kind: "evidence" as const, id: evidenceId };
      return { id: relationId("SUPPORTED_BY", from, to, request.repo), type: "SUPPORTED_BY", from, to, repo: request.repo, revision: request.revision, evidenceIds: [evidenceId], confidence: 1, source: "manual-knowledge-pack.v1", actor: request.reviewer, note: request.note, createdAt: isoNow() };
    }));
    const operationId = `op_${digest(JSON.stringify({ action: "create-pack", repo: request.repo, revision: request.revision, ids, reviewer: request.reviewer, at: isoNow() })).slice(0, 24)}`;
    await this.repository.writeBuild([], updatedCards, [...retainedRelations, ...supportRelations]);
    await this.repository.appendKnowledgeChanges?.(imported.map((card) => knowledgeChange("create", request.reviewer, request.note, existingById.get(card.id) ?? null, card, [], operationId)));
    await this.reindex(updatedCards);
    return imported;
  }

  async mergeKnowledge(raw: MergeKnowledgeRequest): Promise<KnowledgeCard> {
    const parsed = MergeKnowledgeRequestSchema.parse(raw);
    const request = { ...parsed, merged: { ...parsed.merged, repo: resolve(parsed.merged.repo) } };
    const sourceKnowledgeIds = [...new Set(request.sourceKnowledgeIds)];
    if (sourceKnowledgeIds.length < 2) throw new Error("Merging requires at least two distinct source knowledge cards");
    const cards = await this.repository.readKnowledge();
    const sources = sourceKnowledgeIds.map((id) => cards.find((card) => card.id === id));
    if (sources.some((card) => !card)) throw new Error("Every source knowledge card must exist");
    const sourceCards = sources as KnowledgeCard[];
    if (sourceCards.some((card) => card.repo !== request.merged.repo || card.revision !== request.merged.revision)) {
      throw new Error("Merged knowledge and all source cards must share one repository revision");
    }
    if (sourceCards.some((card) => card.status === "stale" || card.status === "rejected")) {
      throw new Error("Stale or rejected knowledge cannot be merged");
    }
    const requiredEvidenceIds = [...new Set(sourceCards.flatMap((card) => card.evidenceIds))];
    if (requiredEvidenceIds.some((id) => !request.merged.evidenceIds.includes(id))) {
      throw new Error("Merged knowledge must preserve every source card's evidence provenance");
    }
    const evidence = await this.repository.readEvidence();
    validateManualKnowledgeRequest(request.merged, new Map(evidence.map((item) => [item.id, item])), "Merged knowledge");
    const draft = manualDraft(request.merged);
    const id = stableCardId(draft, request.merged.repo);
    if (sourceKnowledgeIds.includes(id) || cards.some((card) => card.id === id)) {
      throw new Error("Merged knowledge must produce a new card identity");
    }
    const now = isoNow();
    const merged = {
      ...toCard(draft, { repo: request.merged.repo, revision: request.merged.revision }, undefined, "manual", false, request.merged.proposalProvenance),
      status: "candidate" as const,
      validationEvidenceIds: [],
      createdAt: now,
      updatedAt: now,
    };
    const updatedCards = [
      ...cards.map((card) => sourceKnowledgeIds.includes(card.id) ? { ...card, status: "rejected" as const, updatedAt: now } : card),
      merged,
    ];
    const relations = await this.repository.readRelations?.() ?? [];
    const supportRelations = merged.evidenceIds.map((evidenceId): KnowledgeRelation => {
      const from = { kind: "knowledge" as const, id: merged.id };
      const to = { kind: "evidence" as const, id: evidenceId };
      return { id: relationId("SUPPORTED_BY", from, to, merged.repo), type: "SUPPORTED_BY", from, to, repo: merged.repo, revision: merged.revision, evidenceIds: [evidenceId], confidence: 1, source: "human-merge.v1", actor: request.reviewer, note: request.note, createdAt: now };
    });
    const mergeRelations = sourceCards.map((source): KnowledgeRelation => {
      const from = { kind: "knowledge" as const, id: merged.id };
      const to = { kind: "knowledge" as const, id: source.id };
      return { id: relationId("MERGED_FROM", from, to, merged.repo), type: "MERGED_FROM", from, to, repo: merged.repo, revision: merged.revision, evidenceIds: source.evidenceIds, confidence: 1, source: "human-merge.v1", actor: request.reviewer, note: request.note, createdAt: now };
    });
    const additions = [...supportRelations, ...mergeRelations];
    const additionIds = new Set(additions.map((relation) => relation.id));
    await this.repository.writeBuild([], updatedCards, [...relations.filter((relation) => !additionIds.has(relation.id)), ...additions]);
    for (const source of sourceCards) {
      await this.repository.appendReview({ knowledgeId: source.id, status: "rejected", reviewer: request.reviewer, note: `合并至 ${merged.id}：${request.note}`, createdAt: now });
    }
    const operationId = `op_${digest(JSON.stringify({ action: "merge", sourceKnowledgeIds, mergedId: merged.id, reviewer: request.reviewer, now })).slice(0, 24)}`;
    await this.repository.appendKnowledgeChanges?.([
      ...sourceCards.map((source) => knowledgeChange("merge", request.reviewer, request.note, source, updatedCards.find((card) => card.id === source.id)!, sourceKnowledgeIds, operationId)),
      knowledgeChange("merge", request.reviewer, request.note, null, merged, sourceKnowledgeIds, operationId),
    ]);
    await this.reindex(updatedCards);
    return merged;
  }

  async listKnowledgeChanges(knowledgeId?: string): Promise<KnowledgeChange[]> {
    const changes = await this.repository.readKnowledgeChanges?.() ?? [];
    return knowledgeId ? changes.filter((change) => change.knowledgeId === knowledgeId) : changes;
  }

  async rollbackKnowledge(id: string, raw: RollbackKnowledgeRequest): Promise<KnowledgeCard[]> {
    const request = RollbackKnowledgeRequestSchema.parse(raw);
    const changes = await this.repository.readKnowledgeChanges?.() ?? [];
    const target = changes.find((change) => change.id === request.changeId && change.knowledgeId === id);
    if (!target) throw new Error(`Unknown knowledge change for ${id}: ${request.changeId}`);
    const operationChanges = changes.filter((change) => change.operationId === target.operationId);
    const cards = await this.repository.readKnowledge();
    const evidence = await this.repository.readEvidence();
    const evidenceById = new Map(evidence.map((item) => [item.id, item]));
    const restored: KnowledgeCard[] = [];
    const removeIds = new Set<string>();
    for (const change of operationChanges) {
      if (!change.before) {
        removeIds.add(change.knowledgeId);
        continue;
      }
      const current = cards.find((card) => card.id === change.knowledgeId);
      if (!current) throw new Error(`Cannot rollback missing knowledge card: ${change.knowledgeId}`);
      const latestRepoEvidence = evidence.filter((item) => item.repo === current.repo).sort((left, right) => right.extractedAt.localeCompare(left.extractedAt))[0];
      if (!latestRepoEvidence) throw new Error(`Cannot rollback ${change.knowledgeId}: repository has no current evidence`);
      const cited = change.before.evidenceIds.map((evidenceId) => evidenceById.get(evidenceId));
      if (cited.some((item) => !item || item.repo !== current.repo || item.revision !== latestRepoEvidence.revision)) {
        throw new Error(`Cannot rollback ${change.knowledgeId}: its evidence is no longer current for this repository revision`);
      }
      restored.push({
        ...change.before,
        revision: latestRepoEvidence.revision,
        applicability: { ...change.before.applicability, revision: latestRepoEvidence.revision },
        status: "candidate",
        validationEvidenceIds: [],
        updatedAt: isoNow(),
      });
    }
    const restoredById = new Map(restored.map((card) => [card.id, card]));
    const updatedCards = [
      ...cards.filter((card) => !removeIds.has(card.id)).map((card) => restoredById.get(card.id) ?? card),
      ...restored.filter((card) => !cards.some((current) => current.id === card.id)),
    ];
    const relations = await this.repository.readRelations?.() ?? [];
    const affectedIds = new Set([...removeIds, ...restored.map((card) => card.id)]);
    const retainedRelations = relations.filter((relation) => {
      if (removeIds.has(relation.from.id) || removeIds.has(relation.to.id)) return false;
      return !((relation.type === "VERIFIED_BY" || relation.type === "INVALIDATED_BY") && affectedIds.has(relation.from.id));
    });
    const supportRelations = restored.flatMap((card) => card.evidenceIds.map((evidenceId): KnowledgeRelation => {
      const from = { kind: "knowledge" as const, id: card.id };
      const to = { kind: "evidence" as const, id: evidenceId };
      return { id: relationId("SUPPORTED_BY", from, to, card.repo), type: "SUPPORTED_BY", from, to, repo: card.repo, revision: card.revision, evidenceIds: [evidenceId], confidence: 1, source: "human-rollback.v1", actor: request.reviewer, note: request.note, createdAt: isoNow() };
    }));
    const supportIds = new Set(supportRelations.map((relation) => relation.id));
    await this.repository.writeBuild([], updatedCards, [...retainedRelations.filter((relation) => !supportIds.has(relation.id)), ...supportRelations]);
    const operationId = `op_${digest(JSON.stringify({ action: "rollback", target: target.operationId, reviewer: request.reviewer, at: isoNow() })).slice(0, 24)}`;
    await this.repository.appendKnowledgeChanges?.(operationChanges.map((change) => {
      const before = cards.find((card) => card.id === change.knowledgeId) ?? null;
      const after = updatedCards.find((card) => card.id === change.knowledgeId) ?? null;
      return knowledgeChange("rollback", request.reviewer, request.note, before, after, target.sourceKnowledgeIds, operationId);
    }).filter((change) => change.before || change.after));
    await this.reindex(updatedCards);
    return updatedCards.filter((card) => restoredById.has(card.id));
  }

  async recordConflict(raw: ConflictRequest): Promise<KnowledgeRelation> {
    const request = ConflictRequestSchema.parse(raw);
    if (request.leftKnowledgeId === request.rightKnowledgeId) throw new Error("A knowledge card cannot conflict with itself");
    const cards = await this.repository.readKnowledge();
    const left = cards.find((card) => card.id === request.leftKnowledgeId);
    const right = cards.find((card) => card.id === request.rightKnowledgeId);
    if (!left || !right || left.repo !== right.repo) throw new Error("Conflicting cards must exist in the same repository");
    const evidence = await this.repository.readEvidence();
    if (request.evidenceIds.some((id) => !evidence.some((item) => item.id === id && item.repo === left.repo))) throw new Error("Conflict evidence must exist in the same repository");
    const [fromId, toId] = [left.id, right.id].sort();
    const from = { kind: "knowledge" as const, id: fromId! };
    const to = { kind: "knowledge" as const, id: toId! };
    const relation: KnowledgeRelation = {
      id: relationId("CONFLICTS_WITH", from, to, left.repo), type: "CONFLICTS_WITH", from, to,
      repo: left.repo, revision: left.revision, evidenceIds: request.evidenceIds, confidence: 1,
      source: "human-conflict-review.v1", actor: request.reviewer, note: request.note, createdAt: isoNow(),
    };
    const relations = await this.repository.readRelations?.() ?? [];
    await this.repository.writeBuild([], cards, [...relations.filter((item) => item.id !== relation.id), relation]);
    return relation;
  }

  async resolveConflict(id: string, raw: ResolveConflictRequest): Promise<KnowledgeRelation> {
    const request = ResolveConflictRequestSchema.parse(raw);
    const relations = await this.repository.readRelations?.() ?? [];
    const current = relations.find((item) => item.id === id && item.type === "CONFLICTS_WITH");
    if (!current) throw new Error(`Unknown conflict relation: ${id}`);
    if (current.resolvedAt) throw new Error(`Conflict relation is already resolved: ${id}`);
    const cards = await this.repository.readKnowledge();
    const rejectIds = request.resolution === "keep_left" ? [current.to.id]
      : request.resolution === "keep_right" ? [current.from.id]
        : request.resolution === "reject_both" ? [current.from.id, current.to.id] : [];
    const now = isoNow();
    const updatedCards = cards.map((card) => rejectIds.includes(card.id) ? { ...card, status: "rejected" as const, updatedAt: now } : card);
    const resolved = { ...current, resolution: request.resolution, actor: request.reviewer, note: request.note, resolvedAt: now };
    await this.repository.writeBuild([], updatedCards, relations.map((item) => item.id === id ? resolved : item));
    for (const knowledgeId of rejectIds) {
      await this.repository.appendReview({ knowledgeId, status: "rejected", reviewer: request.reviewer, note: `冲突决议：${request.note}`, createdAt: now });
    }
    await this.repository.appendKnowledgeChanges?.(cards.flatMap((card) => {
      const after = updatedCards.find((item) => item.id === card.id);
      return after && after !== card ? [knowledgeChange("conflict_resolution", request.reviewer, request.note, card, after)] : [];
    }));
    await this.reindex(updatedCards);
    return resolved;
  }

  async recordFeedback(raw: FeedbackRequest): Promise<Evidence> {
    const parsed = FeedbackRequestSchema.parse(raw);
    const request = { ...parsed, repo: resolve(parsed.repo) };
    if (request.evaluation) {
      const plan = (await this.repository.readEvaluationPlans?.() ?? []).find((item) => item.id === request.evaluation!.planId);
      const task = plan?.tasks.find((item) => item.id === request.evaluation!.taskId);
      if (!plan || !task || plan.protocolVersion !== "evaluation.v2" || plan.repo !== request.repo || plan.revision !== request.revision) {
        throw new Error("Evaluation feedback must reference a v2 plan task from the same repository revision");
      }
      const runSpec = evaluationRunSpec(plan, task, request.evaluation.variant, request.evaluation.runSetId);
      if (request.evaluation.runId !== runSpec.runId || request.evaluation.runSpecHash !== runSpec.runSpecHash) throw new Error("Evaluation feedback does not match the frozen run set and specification");
      if (request.evaluation.model !== plan.model || request.evaluation.promptHash !== plan.promptHash || request.evaluation.toolPolicyHash !== plan.toolPolicyHash) {
        throw new Error("Evaluation feedback does not match the frozen model, prompt, or tool policy");
      }
      if (new Set(request.evaluation.usedTools).size !== request.evaluation.usedTools.length || request.evaluation.usedTools.some((tool) => !runSpec.agentInput.tools.includes(tool))) {
        throw new Error("Evaluation feedback contains duplicate or non-whitelisted tools");
      }
      if (request.evaluation.tokenUsage > plan.budget.maxTokens || request.evaluation.toolCalls > plan.budget.maxToolCalls || request.evaluation.durationMs > plan.budget.maxDurationMs) {
        throw new Error("Evaluation feedback exceeds the frozen plan budget");
      }
      if (request.execution?.durationMs !== null && request.execution?.durationMs !== undefined && request.execution.durationMs !== request.evaluation.durationMs) {
        throw new Error("Evaluation feedback duration must match execution details");
      }
    }
    const cards = await this.repository.readKnowledge();
    const current = request.knowledgeId ? cards.find((card) => card.id === request.knowledgeId) : undefined;
    if (request.knowledgeId && (!current || current.repo !== request.repo || current.revision !== request.revision)) {
      throw new Error("Feedback knowledgeId must reference an existing card from the same repository revision");
    }
    const content = JSON.stringify({ command: request.command, outcome: request.outcome, observed: request.observed, execution: request.execution ?? null, evaluation: request.evaluation ?? null, oracleAssessment: request.oracleAssessment ?? null });
    const contentHash = digest(content);
    const evidence: Evidence = {
      id: `ev_${digest(`${request.repo}:${request.revision}:${request.sourceRef}:${contentHash}`).slice(0, 24)}`,
      sourceType: "execution_result",
      sourceRef: request.sourceRef,
      repo: request.repo,
      revision: request.revision,
      path: request.sourceRef,
      symbol: "",
      lineStart: 1,
      lineEnd: 1,
      contentHash,
      extractedAt: isoNow(),
      extractor: "feedback.external-execution.v2",
      content: request.observed,
      confidence: request.confidence,
      payload: { command: request.command, outcome: request.outcome, observed: request.observed, knowledgeId: request.knowledgeId ?? null, execution: request.execution ?? null, evaluation: request.evaluation ?? null, oracleAssessment: request.oracleAssessment ?? null },
    };
    const shouldInvalidate = request.oracleAssessment?.verdict === "contradicted" && current !== undefined && (current.status === "reviewed" || current.status === "verified");
    const next = shouldInvalidate
      ? { ...current, status: "stale" as const, updatedAt: isoNow() }
      : current;
    const updatedCards = next ? cards.map((card) => card.id === next.id ? next : card) : cards;
    const relations = await this.repository.readRelations?.() ?? [];
    const invalidationRelation = shouldInvalidate && next ? (() => {
      const from = { kind: "knowledge" as const, id: next.id };
      const to = { kind: "evidence" as const, id: evidence.id };
      return {
        id: relationId("INVALIDATED_BY", from, to, request.repo), type: "INVALIDATED_BY" as const, from, to,
        repo: request.repo, revision: request.revision, evidenceIds: [evidence.id], confidence: evidence.confidence,
        source: "oracle-feedback.v1", createdAt: isoNow(),
      };
    })() : undefined;
    await this.repository.writeBuild([evidence], updatedCards, invalidationRelation ? [...relations.filter((item) => item.id !== invalidationRelation.id), invalidationRelation] : relations);
    if (shouldInvalidate && current && next && request.oracleAssessment) {
      await this.repository.appendKnowledgeChanges?.([knowledgeChange("feedback_invalidation", request.oracleAssessment.assessor, request.oracleAssessment.note, current, next)]);
      await this.reindex(updatedCards);
    }
    return evidence;
  }

  async verify(id: string, raw: VerificationRequest): Promise<KnowledgeCard> {
    const request = VerificationRequestSchema.parse(raw);
    const cards = await this.repository.readKnowledge();
    const current = cards.find((card) => card.id === id);
    if (!current) throw new Error(`Unknown knowledge card: ${id}`);
    if (current.status !== "reviewed") throw new Error("Only reviewed knowledge can be promoted to verified");
    if (current.clusterId) {
      const cluster = (await this.repository.readClusters?.() ?? []).find((item) => item.id === current.clusterId);
      if (!cluster || cluster.status !== "reviewed") throw new Error("Clustered knowledge can be verified only after its evidence cluster is reviewed");
    }
    const evidence = (await this.repository.readEvidence()).find((item) => item.id === request.evidenceId);
    if (!evidence || evidence.repo !== current.repo || evidence.revision !== current.revision || evidence.sourceType !== "execution_result" || evidence.payload.outcome !== "passed" || evidence.payload.knowledgeId !== id) {
      throw new Error("Verification requires a passed execution_result explicitly bound to this card and repository");
    }
    const next = { ...current, status: "verified" as const, validationEvidenceIds: [...new Set([...(current.validationEvidenceIds ?? []), evidence.id])], updatedAt: isoNow() };
    const updatedCards = cards.map((card) => card.id === id ? next : card);
    const relations = await this.repository.readRelations?.() ?? [];
    const from = { kind: "knowledge" as const, id };
    const to = { kind: "evidence" as const, id: evidence.id };
    const relation: KnowledgeRelation = {
      id: relationId("VERIFIED_BY", from, to, current.repo), type: "VERIFIED_BY", from, to,
      repo: current.repo, revision: current.revision, evidenceIds: [evidence.id], confidence: evidence.confidence,
      source: "human-verification.v1", createdAt: isoNow(),
    };
    await this.repository.writeBuild([], updatedCards, [...relations.filter((item) => item.id !== relation.id), relation]);
    await this.repository.appendReview({ knowledgeId: id, status: "verified", reviewer: request.reviewer, note: request.note, createdAt: isoNow() });
    await this.repository.appendKnowledgeChanges?.([knowledgeChange("verify", request.reviewer, request.note, current, next)]);
    await this.reindex(updatedCards);
    return next;
  }

  async listKnowledge(): Promise<KnowledgeCard[]> {
    return (await this.repository.readKnowledge()).filter(isKnowledgeLayer);
  }

  async getKnowledge(id: string): Promise<KnowledgeCard> {
    const card = (await this.repository.readKnowledge()).find((item) => item.id === id && isKnowledgeLayer(item));
    if (!card) throw new Error(`Unknown knowledge card: ${id}`);
    return card;
  }

  async getEvidence(id: string): Promise<Evidence> {
    const evidence = (await this.repository.readEvidence()).find((item) => item.id === id);
    if (!evidence) throw new Error(`Unknown evidence: ${id}`);
    return evidence;
  }

  async listRelations(): Promise<KnowledgeRelation[]> {
    return await this.repository.readRelations?.() ?? [];
  }

  async listEvidence(repo?: string): Promise<Evidence[]> {
    const evidence = await this.repository.readEvidence();
    return repo ? evidence.filter((item) => item.repo === repo) : evidence;
  }

  async exportMemory(): Promise<string> {
    const cards = (await this.repository.readKnowledge()).filter((card) => card.status === "verified" && isKnowledgeLayer(card));
    return cards.map((card) => `## ${card.title}\n\n- 适用：${card.trigger}\n- 规则：${card.statement}\n- 手法：${card.techniques.join("、") || "未标注"}\n- 预期：${card.expectedBehavior}\n- 断言：${card.oracle}\n- 来源：${card.evidenceIds.join(", ")}\n`).join("\n");
  }

  static async readFiles(repo: string, files: SourceSpec[]): Promise<SourceFile[]> {
    const root = resolve(repo);
    const canonicalRoot = await realpath(root);
    return Promise.all(files.map(async (file) => {
      if (isAbsolute(file.path)) throw new Error(`Source path must be repository-relative: ${file.path}`);
      const path = resolve(root, file.path);
      if (isOutside(root, path)) throw new Error(`Source path escapes repository: ${file.path}`);
      const canonicalPath = await realpath(path);
      if (isOutside(canonicalRoot, canonicalPath)) throw new Error(`Source path resolves outside repository: ${file.path}`);
      return { ...file, text: await readFile(canonicalPath, "utf8") };
    }));
  }
}
