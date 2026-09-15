import { createHash } from "node:crypto";
import { ExecutionDetailsSchema, type Evidence, type ExecutionDetails } from "@testknowledge/model";
import type { ProjectScope, SourceAdapter, SourceFile } from "@testknowledge/core";

type JsonRecord = Record<string, unknown>;

const hash = (value: string): string => createHash("sha256").update(value).digest("hex");
const isRecord = (value: unknown): value is JsonRecord => value !== null && typeof value === "object" && !Array.isArray(value);
const text = (value: unknown): string => typeof value === "string" ? value.trim() : "";
const strings = (value: unknown): string[] => Array.isArray(value)
  ? value.flatMap((item) => typeof item === "string" ? [item] : isRecord(item) && typeof item.name === "string" ? [item.name] : [])
  : [];
const evaluationVariants = new Set(["A_ordinary_agent", "B_codegraph", "C_codegraph_testknowledge"]);

const number = (...values: unknown[]): number | null => {
  const value = values.find((item) => typeof item === "number" && Number.isFinite(item));
  return typeof value === "number" && value >= 0 ? value : null;
};
const integer = (...values: unknown[]): number | null => {
  const value = number(...values);
  return value !== null && Number.isInteger(value) ? value : null;
};
const percent = (...values: unknown[]): number | null => {
  const value = number(...values);
  return value !== null && value <= 100 ? value : null;
};

function executionDetails(item: JsonRecord): ExecutionDetails {
  const explicit = isRecord(item.execution) ? item.execution : item;
  const testCounts = isRecord(explicit.testCounts) ? explicit.testCounts : isRecord(explicit.tests) ? explicit.tests : {};
  const coverage = isRecord(explicit.coverage) ? explicit.coverage : null;
  const lines = coverage && isRecord(coverage.lines) ? coverage.lines : {};
  const branches = coverage && isRecord(coverage.branches) ? coverage.branches : {};
  const mutation = isRecord(explicit.mutation) ? explicit.mutation : null;
  const failures = Array.isArray(explicit.failures) ? explicit.failures.filter(isRecord).slice(0, 100).flatMap((failure) => {
    const testId = text(failure.testId) || text(failure.test_id) || text(failure.nodeid) || text(failure.name);
    const message = text(failure.message) || text(failure.error) || text(failure.summary);
    if (!testId || !message) return [];
    return [{
      testId,
      message: message.slice(0, 4000),
      path: text(failure.path) || text(failure.file),
      line: integer(failure.line, failure.lineNumber, failure.line_number),
    }];
  }) : [];
  return ExecutionDetailsSchema.parse({
    durationMs: number(explicit.durationMs, explicit.duration_ms),
    testCounts: {
      total: integer(testCounts.total), passed: integer(testCounts.passed), failed: integer(testCounts.failed),
      skipped: integer(testCounts.skipped), errors: integer(testCounts.errors),
    },
    coverage: coverage ? {
      linesPercent: percent(coverage.linesPercent, coverage.lines_percent, lines.percent, lines.pct),
      branchesPercent: percent(coverage.branchesPercent, coverage.branches_percent, branches.percent, branches.pct),
      coveredFiles: strings(coverage.coveredFiles ?? coverage.covered_files ?? coverage.files),
    } : null,
    mutation: mutation ? {
      scorePercent: percent(mutation.scorePercent, mutation.score_percent, mutation.mutationScore, mutation.mutation_score),
      killed: integer(mutation.killed), survived: integer(mutation.survived),
      timedOut: integer(mutation.timedOut, mutation.timed_out), noCoverage: integer(mutation.noCoverage, mutation.no_coverage),
    } : null,
    failures,
  });
}

function evaluationBinding(value: unknown): JsonRecord | null {
  if (!isRecord(value)) return null;
  const planId = text(value.planId);
  const runSetId = text(value.runSetId);
  const taskId = text(value.taskId);
  const variant = text(value.variant);
  const runId = text(value.runId);
  const runSpecHash = text(value.runSpecHash);
  const model = text(value.model);
  const promptHash = text(value.promptHash);
  const toolPolicyHash = text(value.toolPolicyHash);
  const usedTools = strings(value.usedTools);
  const tokenUsage = integer(value.tokenUsage);
  const toolCalls = integer(value.toolCalls);
  const durationMs = integer(value.durationMs);
  const duplicateTestCount = integer(value.duplicateTestCount);
  const brittleTestCount = integer(value.brittleTestCount);
  return planId && runSetId && taskId && runId && runSpecHash && model && promptHash && toolPolicyHash
    && tokenUsage !== null && toolCalls !== null && durationMs !== null && duplicateTestCount !== null && brittleTestCount !== null
    && evaluationVariants.has(variant)
    ? { planId, runSetId, taskId, variant, runId, runSpecHash, model, promptHash, toolPolicyHash, usedTools, tokenUsage, toolCalls, durationMs, duplicateTestCount, brittleTestCount }
    : null;
}

function records(raw: string): JsonRecord[] {
  const parsed: unknown = JSON.parse(raw);
  if (Array.isArray(parsed)) return parsed.filter(isRecord);
  if (!isRecord(parsed)) return [];
  for (const key of ["issues", "items", "results", "runs"]) {
    const nested = parsed[key];
    if (Array.isArray(nested)) return nested.filter(isRecord);
  }
  return [parsed];
}

function evidenceId(repo: string, sourceRef: string, contentHash: string): string {
  return `ev_${hash(`${repo}:${sourceRef}:${contentHash}`).slice(0, 24)}`;
}

/** Imports explicit, repository-local snapshots. It never contacts trackers or executes test commands. */
export class ExternalArtifactAdapter implements SourceAdapter {
  readonly id = "source.external-artifact.v5";

  supports(file: SourceFile): boolean {
    return file.type === "issue" || file.type === "execution_result";
  }

  async collect(file: SourceFile, scope: ProjectScope): Promise<Evidence[]> {
    return file.type === "issue" ? this.issues(file, scope) : this.executionResults(file, scope);
  }

  private issues(file: SourceFile, scope: ProjectScope): Evidence[] {
    let items: JsonRecord[];
    try {
      items = records(file.text);
    } catch {
      items = [{ title: file.path, body: file.text }];
    }
    return items.flatMap((item, index) => {
      const title = text(item.title) || `Issue ${index + 1}`;
      const body = text(item.body) || text(item.description);
      if (!body && !title) return [];
      const issueId = text(item.id) || (typeof item.number === "number" ? String(item.number) : String(index + 1));
      const url = text(item.html_url) || text(item.url);
      const sourceRef = url || `${file.path}#${issueId}`;
      const content = [title, body].filter(Boolean).join("\n\n").slice(0, 20_000);
      const contentHash = hash(content);
      const payload = {
        issueId,
        title,
        body,
        state: text(item.state),
        labels: strings(item.labels),
        url,
        expectedBehavior: text(item.expectedBehavior) || text(item.expected_behavior),
        actualBehavior: text(item.actualBehavior) || text(item.actual_behavior),
        reproduction: text(item.reproduction) || text(item.reproductionSteps) || text(item.steps_to_reproduce),
        affectedPaths: strings(item.affectedPaths ?? item.affected_paths ?? item.files),
        targetSymbols: strings(item.targetSymbols ?? item.target_symbols),
      };
      return [{
        id: evidenceId(scope.repo, sourceRef, contentHash), sourceType: "issue" as const, sourceRef,
        repo: scope.repo, revision: scope.revision, path: file.path, symbol: "", lineStart: 1,
        lineEnd: Math.max(1, content.split(/\r?\n/u).length), contentHash, extractedAt: new Date().toISOString(),
        extractor: this.id, content, confidence: body ? 0.8 : 0.5, payload,
      }];
    });
  }

  private executionResults(file: SourceFile, scope: ProjectScope): Evidence[] {
    let items: JsonRecord[];
    try {
      items = records(file.text);
    } catch {
      return [];
    }
    return items.flatMap((item, index) => {
      const outcome = item.outcome;
      const command = strings(item.command);
      const observed = text(item.observed) || text(item.summary);
      const evaluation = evaluationBinding(item.evaluation);
      if ((outcome !== "passed" && outcome !== "failed" && outcome !== "error") || command.length === 0 || !observed) return [];
      const sourceRef = text(item.sourceRef) || text(item.url) || `${file.path}#${index + 1}`;
      const execution = executionDetails(item);
      const content = JSON.stringify({ command, outcome, observed, execution, evaluation });
      const contentHash = hash(content);
      return [{
        id: evidenceId(scope.repo, sourceRef, contentHash), sourceType: "execution_result" as const, sourceRef,
        repo: scope.repo, revision: scope.revision, path: file.path, symbol: "", lineStart: 1, lineEnd: 1,
        contentHash, extractedAt: new Date().toISOString(), extractor: this.id, content, confidence: 0.8,
        payload: { command, outcome, observed, knowledgeId: null, imported: true, execution, evaluation },
      }];
    });
  }
}
