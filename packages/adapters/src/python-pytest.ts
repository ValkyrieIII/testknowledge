import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { parser } from "@lezer/python";
import type { Evidence } from "@testknowledge/model";
import {
  isConftestPath,
  isFixtureDecorator,
  isTestClassName,
  isTestFunctionName,
  isTestModulePath,
  resolvePytestConfig,
  type ProjectScope,
  type PytestConfig,
  type SourceAdapter,
  type SourceFile,
} from "@testknowledge/core";

const hash = (value: string): string => createHash("sha256").update(value).digest("hex");

const CONFIG_FILES = ["pytest.ini", "pyproject.toml", "tox.ini", "setup.cfg"] as const;

function evidenceId(scope: ProjectScope, file: SourceFile, symbol: string, start: number, contentHash: string): string {
  return `ev_${hash(`${scope.repo}:${file.path}:${symbol}:${start}:${contentHash}`).slice(0, 24)}`;
}

function lineNumber(text: string, offset: number): number {
  return text.slice(0, offset).split("\n").length;
}

/** Parameter names from a function signature, dropping `self` / `cls` / `*args` / `**kwargs`. */
export function parameterNames(snippet: string): string[] {
  const signature = /(?:async\s+)?def\s+\w+\s*\(([\s\S]*?)\)\s*(?:->[\s\S]*?)?:/u.exec(snippet)?.[1] ?? "";
  return signature
    .split(",")
    .map((part) => part.trim().split(":")[0]?.split("=")[0]?.trim() ?? "")
    .filter((name) => /^[A-Za-z_]\w*$/u.test(name) && name !== "self" && name !== "cls");
}

/** Decorators live on the surrounding `DecoratedStatement`, not on `FunctionDefinition`. */
function decoratorsFor(file: SourceFile, node: { from: number; parent: { name: string; from: number } | null }): string[] {
  const parent = node.parent;
  if (parent?.name !== "DecoratedStatement") return [];
  const text = file.text.slice(parent.from, node.from);
  return [...text.matchAll(/@([^\n]+)/gu)].map((match) => match[1]?.trim() ?? "").filter(Boolean);
}

async function readPytestConfig(repo: string): Promise<PytestConfig> {
  const sources: Array<{ path: string; text: string }> = [];
  for (const name of CONFIG_FILES) {
    try {
      sources.push({ path: name, text: await readFile(join(repo, name), "utf8") });
    } catch {
      // A missing config file is the normal case.
    }
  }
  return resolvePytestConfig(sources);
}

export class PythonPytestAdapter implements SourceAdapter {
  readonly id = "source.python-pytest.lezer-v2";

  private readonly configCache = new Map<string, PytestConfig>();

  supports(file: SourceFile): boolean {
    return file.type === "test_code" || file.type === "production_code" || file.path.endsWith(".py");
  }

  private async configFor(repo: string): Promise<PytestConfig> {
    const cached = this.configCache.get(repo);
    if (cached) return cached;
    const config = await readPytestConfig(repo);
    this.configCache.set(repo, config);
    return config;
  }

  async collect(file: SourceFile, scope: ProjectScope): Promise<Evidence[]> {
    const config = await this.configFor(scope.repo);
    const isConftest = isConftestPath(file.path);
    const isTestModule = isTestModulePath(file.path, config);
    const sourceType = isTestModule || isConftest ? "test_code" : file.type;
    const tree = parser.parse(file.text);
    const lines = file.text.split("\n");
    const result: Evidence[] = [];
    const add = (symbol: string, start: number, end: number, payload: Record<string, unknown>): void => {
      const snippet = lines.slice(start - 1, end).join("\n");
      const contentHash = hash(snippet);
      result.push({
        id: evidenceId(scope, file, symbol, start, contentHash),
        sourceType,
        sourceRef: `${file.path}:${start}`,
        repo: scope.repo,
        revision: scope.revision,
        path: file.path,
        symbol,
        lineStart: start,
        lineEnd: end,
        contentHash,
        payload: { ...payload, snippet },
      });
    };
    add("", 1, Math.max(1, lines.length), {
      language: "python",
      parser: "@lezer/python",
      isTestModule,
      isConftest,
      imports: [...file.text.matchAll(/^(?:from|import)\s+.+$/gim)].map((match) => match[0]),
    });
    const classStack: string[] = [];
    const cursor = tree.cursor();
    const visit = (): void => {
      const entersClass = cursor.name === "ClassDefinition";
      if (entersClass) {
        const classSnippet = file.text.slice(cursor.from, cursor.to);
        classStack.push(/^\s*class\s+([A-Za-z_]\w*)/u.exec(classSnippet)?.[1] ?? "anonymous");
      }
      if (cursor.name === "FunctionDefinition") {
        const snippet = file.text.slice(cursor.from, cursor.to);
        const name = /^\s*(?:async\s+)?def\s+([A-Za-z_]\w*)/u.exec(snippet)?.[1] ?? "anonymous";
        const start = lineNumber(file.text, cursor.from);
        const end = lineNumber(file.text, cursor.to);
        const decorators = decoratorsFor(file, cursor.node);
        const enclosingClass = classStack.at(-1);
        const inTestClass = enclosingClass !== undefined && isTestClassName(enclosingClass, config);
        const isFixture = decorators.some(isFixtureDecorator);
        const isTest = isTestModule && isTestFunctionName(name, config) && (enclosingClass === undefined || inTestClass);
        const calls = [...snippet.matchAll(/\b([A-Za-z_]\w*)\s*\(/gu)].map((match) => match[1]).filter((value): value is string => Boolean(value));
        const assertions = [...snippet.matchAll(/\bassert\s+([^\n]+)/gu)].map((match) => match[1]?.trim()).filter((value): value is string => Boolean(value));
        const mocks = [...snippet.matchAll(/\b(?:patch|Mock|MagicMock)\b[^\n]*/gu)].map((match) => match[0]);
        add(name, start, end, {
          isTest,
          isFixture,
          isTestModule,
          isConftest,
          enclosingClass: enclosingClass ?? "",
          inTestClass,
          decorators,
          calls: [...new Set(calls)],
          assertions,
          fixtureRequests: parameterNames(snippet),
          mocks,
        });
      }
      if (cursor.firstChild()) {
        do visit(); while (cursor.nextSibling());
        cursor.parent();
      }
      if (entersClass) classStack.pop();
    };
    visit();
    return result;
  }
}
