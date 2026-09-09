import { createHash } from "node:crypto";
import { lstat, readFile } from "node:fs/promises";
import { join } from "node:path";
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
import { extractFunctions, isMockCall } from "./python-facts.js";

const hash = (value: string): string => createHash("sha256").update(value).digest("hex");

const CONFIG_FILES = ["pytest.ini", "pyproject.toml", "tox.ini", "setup.cfg"] as const;

function evidenceId(scope: ProjectScope, file: SourceFile, symbol: string, start: number, contentHash: string): string {
  return `ev_${hash(`${scope.repo}:${file.path}:${symbol}:${start}:${contentHash}`).slice(0, 24)}`;
}

/** Parameter names supplied by `@pytest.mark.parametrize(...)` are test inputs, not fixtures. */
function parametrizedNames(decorators: Array<{ name: string; literals: unknown[] }>): string[] {
  return decorators
    .filter((decorator) => /parametrize/u.test(decorator.name))
    .flatMap((decorator) => {
      const first = decorator.literals[0];
      if (typeof first !== "string") return [];
      return first
        .split(",")
        .map((name) => name.trim())
        .filter(Boolean);
    });
}

async function readPytestConfig(repo: string): Promise<PytestConfig> {
  const sources: Array<{ path: string; text: string }> = [];
  for (const name of CONFIG_FILES) {
    try {
      const info = await lstat(join(repo, name));
      if (!info.isFile() || info.isSymbolicLink()) continue;
      sources.push({ path: name, text: await readFile(join(repo, name), "utf8") });
    } catch (cause) {
      if ((cause as NodeJS.ErrnoException).code !== "ENOENT") {
        throw new Error(`无法读取 pytest 配置 ${join(repo, name)}`, { cause });
      }
    }
  }
  return resolvePytestConfig(sources);
}

export class PythonPytestAdapter implements SourceAdapter {
  readonly id = "source.python-pytest.lezer-v3";

  private readonly configCache = new Map<string, PytestConfig>();

  async prepare(repo: string): Promise<void> {
    this.configCache.set(repo, await readPytestConfig(repo));
  }

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
    for (const fn of extractFunctions(file.text)) {
      const inTestClass = fn.enclosingClass !== "" && isTestClassName(fn.enclosingClass, config);
      const isFixture = fn.decorators.some((decorator) => isFixtureDecorator(decorator.name));
      const isTest = isTestModule && isTestFunctionName(fn.name, config) && (fn.enclosingClass === "" || inTestClass);
      const parametrized = new Set(parametrizedNames(fn.decorators));
      const mocks = [...fn.calls, ...fn.decorators].map((item) => item.name).filter(isMockCall);
      add(fn.name, fn.lineStart, fn.lineEnd, {
        isTest,
        isFixture,
        isTestModule,
        isConftest,
        isAsync: fn.isAsync,
        enclosingClass: fn.enclosingClass,
        inTestClass,
        decorators: fn.decorators,
        parameters: fn.parameters,
        assertions: fn.assertions,
        calls: fn.calls,
        withBlocks: fn.withBlocks,
        tryHandlers: fn.tryHandlers,
        fixtureRequests: fn.parameters.map((parameter) => parameter.name).filter((name) => !parametrized.has(name)),
        mocks: [...new Set(mocks)],
      });
    }
    return result;
  }
}
