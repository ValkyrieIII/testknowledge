import { createHash } from "node:crypto";
import type { Evidence, Observation, ObservationKind, ObservedFacts } from "@testknowledge/model";
import type { ProjectScope } from "./ports.js";
import { runInstructionTexts } from "./run-instructions.js";

/**
 * The observation layer: a deterministic projection of evidence.
 *
 * Observations restate what the evidence mechanically says, so they carry no review
 * status and can never go stale. They are derived on read, never persisted, and no
 * model output is ever written here — that is what keeps them trustworthy without review.
 *
 * Where the old card pipeline concatenated independent facts into one sentence (commands
 * joined to unrelated working directories), this module emits **one observation per fact**
 * so a claim can never borrow a source it did not come from.
 */

export const OBSERVATION_EXTRACTOR = "extractor.observations.v1";

function digest(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function stringList(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string" && item.length > 0) : [];
}

function factList(value: unknown): Array<Record<string, unknown>> {
  return Array.isArray(value) ? value.filter((item): item is Record<string, unknown> => item !== null && typeof item === "object") : [];
}

/** Assertions are structured facts ({ text, lineStart, lineEnd }); accept plain strings too. */
function assertionEntries(payload: Record<string, unknown>): Array<{ text: string; lineStart?: number; lineEnd?: number }> {
  if (!Array.isArray(payload.assertions)) return [];
  return payload.assertions.flatMap((item) => {
    if (typeof item === "string") return [{ text: item }];
    if (item === null || typeof item !== "object") return [];
    const record = item as Record<string, unknown>;
    if (typeof record.text !== "string") return [];
    const entry: { text: string; lineStart?: number; lineEnd?: number } = { text: record.text };
    if (typeof record.lineStart === "number") entry.lineStart = record.lineStart;
    if (typeof record.lineEnd === "number") entry.lineEnd = record.lineEnd;
    return [entry];
  });
}

function textList(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value.flatMap((item) => {
      if (typeof item === "string") return [item];
      if (item !== null && typeof item === "object" && typeof (item as { text?: unknown }).text === "string") {
        return [(item as { text: string }).text];
      }
      return [];
    });
  }
  return [];
}

/** Exception types the test expects: `with pytest.raises(E)` and `try/except E`. */
function exceptionExpectations(payload: Record<string, unknown>): string[] {
  const fromWith = factList(payload.withBlocks)
    .filter((item) => typeof item.call === "string" && /raises/u.test(item.call))
    .flatMap((item) => stringList(item.args).filter((arg) => /^[A-Za-z_][\w.]*$/u.test(arg)));
  const fromTry = factList(payload.tryHandlers).flatMap((item) => stringList(item.exceptionTypes));
  return [...new Set([...fromWith, ...fromTry, ...stringList(payload.expectedExceptions)])];
}

/** Raw decorator text for parametrised tests, so the input values stay visible. */
function parametrizeTexts(payload: Record<string, unknown>): string[] {
  return [...new Set([...factList(payload.decorators)
    .filter((item) => typeof item.name === "string" && /parametrize/u.test(item.name))
    .map((item) => (typeof item.text === "string" ? item.text : ""))
    .filter(Boolean), ...stringList(payload.parametrize)])];
}

/** The mechanical facts an evidence payload states about a test. */
export function observedFactsOf(payload: Record<string, unknown>): ObservedFacts {
  return {
    assertions: textList(payload.assertions),
    expectedExceptions: exceptionExpectations(payload),
    mocks: stringList(payload.mocks),
    factories: stringList(payload.factories),
    dependencies: stringList(payload.fixtureRequests),
    parametrize: parametrizeTexts(payload),
  };
}

type ObservationDraft = Omit<Observation, "id" | "repo" | "revision" | "extractor" | "createdAt">;

export function observationId(repo: string, draft: Pick<ObservationDraft, "kind" | "subject" | "predicate" | "statement" | "evidenceIds">): string {
  const key = JSON.stringify({
    repo,
    kind: draft.kind,
    subject: draft.subject,
    predicate: draft.predicate,
    statement: draft.statement,
    evidenceIds: [...new Set(draft.evidenceIds)].sort(),
  });
  return `obs_${digest(key).slice(0, 24)}`;
}

function observationsOf(item: Evidence): ObservationDraft[] {
  const payload = item.payload;
  const drafts: ObservationDraft[] = [];
  const push = (
    kind: ObservationKind,
    predicate: string,
    subject: string,
    statement: string,
    detail: Record<string, unknown> = {},
    span?: { lineStart?: number; lineEnd?: number },
  ): void => {
    drafts.push({
      sourceType: item.sourceType,
      kind,
      predicate,
      subject,
      statement,
      detail,
      sourceRef: item.sourceRef,
      lineStart: span?.lineStart ?? item.lineStart,
      lineEnd: span?.lineEnd ?? item.lineEnd,
      evidenceIds: [item.id],
      confidence: item.confidence,
    });
  };

  if (item.sourceType === "issue") {
    const expectedBehavior = typeof payload.expectedBehavior === "string" ? payload.expectedBehavior : "";
    const actualBehavior = typeof payload.actualBehavior === "string" ? payload.actualBehavior : "";
    const reproduction = typeof payload.reproduction === "string" ? payload.reproduction : "";
    if (expectedBehavior && (actualBehavior || reproduction)) {
      const targetSymbols = stringList(payload.targetSymbols);
      push(
        "history",
        "reports_defect",
        targetSymbols[0] ?? "",
        actualBehavior ? `曾观察到：${actualBehavior}` : `复现路径：${reproduction}`,
        { expectedBehavior, actualBehavior, reproduction, affectedPaths: stringList(payload.affectedPaths), targetSymbols },
      );
    }
    return drafts;
  }

  if (item.sourceType === "test_configuration" && payload.environmentProfile !== null && typeof payload.environmentProfile === "object") {
    const profile = payload.environmentProfile as Record<string, unknown>;
    // Only documented command/directory pairs are projected. Individually scanned commands
    // are never zipped to a stray directory: that pairing would be inventing a relation.
    for (const text of runInstructionTexts(profile)) push("environment", "documents_run_instruction", item.path, `运行指令：${text}`, { source: item.path });
    for (const name of stringList(profile.environmentVariableNames)) push("environment", "documents_environment_variable", name, `环境变量名：${name}`, { source: item.path });
    for (const image of stringList(profile.serviceImages)) push("environment", "documents_service_image", image, `服务镜像：${image}`, { source: item.path });
    return drafts;
  }

  if (payload.isFixture === true) {
    push("fixture", "defines_fixture", item.symbol, `项目已定义 fixture「${item.symbol}」`, { symbol: item.symbol, parameters: stringList(payload.fixtureRequests) });
    return drafts;
  }
  if (payload.isSetup === true) {
    push("lifecycle", "defines_lifecycle_hook", item.symbol, `「${item.symbol}」是框架生命周期钩子`, { symbol: item.symbol });
    return drafts;
  }
  if (payload.isTest !== true) return drafts;

  push("test_location", "declares_test", item.symbol, `测试函数「${item.symbol}」位于 ${item.path}`, { path: item.path, symbol: item.symbol });
  for (const entry of assertionEntries(payload)) push("assertion", "asserts", item.symbol, entry.text, { testSymbol: item.symbol }, entry);
  for (const exceptionType of exceptionExpectations(payload)) push("exception", "expects_exception", exceptionType, `期望抛出：${exceptionType}`, { testSymbol: item.symbol });
  for (const name of stringList(payload.fixtureRequests)) push("fixture", "requests_fixture", name, `测试请求 fixture「${name}」`, { testSymbol: item.symbol });
  for (const name of stringList(payload.mocks)) push("mock", "uses_mock", name, `测试 mock 了「${name}」`, { testSymbol: item.symbol });
  for (const name of stringList(payload.factories)) push("dependency", "uses_factory", name, `测试使用 factory「${name}」`, { testSymbol: item.symbol });
  for (const text of parametrizeTexts(payload)) push("parametrization", "parametrizes", item.symbol, `参数化：${text}`, { testSymbol: item.symbol });
  return drafts;
}

/**
 * Project evidence into observations.
 *
 * `createdAt` comes from the cited evidence's own `extractedAt` rather than the clock, so a
 * projection is fully determined by the evidence it came from — same input, same output.
 */
export function materializeObservations(evidence: Evidence[], scope: ProjectScope): Observation[] {
  const extractedAtById = new Map(evidence.map((item) => [item.id, item.extractedAt]));
  const observations: Observation[] = [];
  const seen = new Set<string>();
  for (const item of evidence) {
    for (const draft of observationsOf(item)) {
      const id = observationId(scope.repo, draft);
      if (seen.has(id)) continue;
      seen.add(id);
      const cited = draft.evidenceIds.map((evidenceId) => extractedAtById.get(evidenceId) ?? item.extractedAt);
      observations.push({
        ...draft,
        id,
        repo: scope.repo,
        revision: item.revision,
        extractor: OBSERVATION_EXTRACTOR,
        createdAt: cited.sort().at(-1) ?? item.extractedAt,
      });
    }
  }
  return observations;
}
