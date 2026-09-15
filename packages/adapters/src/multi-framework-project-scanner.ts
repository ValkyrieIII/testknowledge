import { lstat, readdir, readFile } from "node:fs/promises";
import { join, posix, resolve } from "node:path";
import type { ProjectScan, ProjectScanner, SourceSpec } from "@testknowledge/core";
import { PytestProjectScanner } from "./pytest-project-scanner.js";

const EXCLUDED = new Set([
  ".git", ".hg", ".svn", "node_modules", ".venv", "venv", "vendor", "target",
  "dist", "build", "coverage", "__pycache__", ".pytest_cache", ".tox", ".nox",
  ".mypy_cache", ".ruff_cache", ".gradle", ".idea", ".codegraph", ".testknowledge",
]);
const CONFIG_NAMES = new Set([
  "pytest.ini", "pyproject.toml", "tox.ini", "setup.cfg",
  "pom.xml", "build.gradle", "build.gradle.kts", "settings.gradle", "settings.gradle.kts", "gradle.properties",
  "go.mod", "go.sum", "Cargo.toml", "Cargo.lock",
]);
const ENVIRONMENT_FILES = /^(?:\.env\.example|dockerfile|compose(?:\.[^.]+)?\.ya?ml|docker-compose(?:\.[^.]+)?\.ya?ml|makefile)$/iu;

type Language = "python" | "java" | "go" | "rust";

function languageOf(name: string): Language | null {
  if (name.endsWith(".py")) return "python";
  if (name.endsWith(".java")) return "java";
  if (name.endsWith(".go")) return "go";
  if (name.endsWith(".rs")) return "rust";
  return null;
}

function frameworkOf(language: Language): string {
  return { python: "pytest", java: "junit", go: "go-testing", rust: "rust-test" }[language];
}

function isNamedTest(path: string, name: string, language: Language, inTestDirectory: boolean): boolean {
  if (language === "python") return inTestDirectory || name === "conftest.py" || /^(?:test_.+|.+_test)\.py$/u.test(name);
  if (language === "java") return /(?:^|\/)src\/test(?:\/|$)/u.test(path) || /(?:Test|Tests|IT)\.java$/u.test(name);
  if (language === "go") return name.endsWith("_test.go");
  return /(?:^|\/)tests(?:\/|$)/u.test(path);
}

/** One deterministic discovery pass; language adapters remain responsible for symbol-level recognition. */
export class MultiFrameworkProjectScanner implements ProjectScanner {
  async scan(input: string): Promise<ProjectScan> {
    const repo = resolve(input);
    const pythonScan = await new PytestProjectScanner().scan(repo);
    const sourceCandidates: Array<{ spec: SourceSpec; language: Language }> = [];
    const configs = new Set<string>();
    const environmentFiles = new Set<string>();
    const testDirectories = new Set<string>();
    const languagesWithTests = new Set<Language>();
    let currentPath = repo;
    try {
      const root = await lstat(repo);
      if (!root.isDirectory() || root.isSymbolicLink()) throw new Error("仓库路径必须是实际目录");
      const walk = async (relative: string, inPythonTests: boolean): Promise<void> => {
        currentPath = join(repo, relative);
        const entries = await readdir(currentPath, { withFileTypes: true });
        entries.sort((a, b) => a.name.localeCompare(b.name));
        for (const entry of entries) {
          if (entry.isSymbolicLink()) continue;
          const path = posix.join(relative, entry.name);
          if (entry.isDirectory()) {
            if (EXCLUDED.has(entry.name)) continue;
            const entersPythonTests = entry.name === "test" || entry.name === "tests";
            if (entersPythonTests || /(?:^|\/)src\/test$/u.test(path) || path === "tests") testDirectories.add(path);
            await walk(path, inPythonTests || entersPythonTests);
            continue;
          }
          if (!entry.isFile()) continue;
          if ((!relative && CONFIG_NAMES.has(entry.name)) || /^(?:.+\/)?(?:pom\.xml|build\.gradle(?:\.kts)?|go\.mod|Cargo\.toml)$/u.test(path)) configs.add(path);
          if ((!relative && ENVIRONMENT_FILES.test(entry.name)) || /^\.github\/workflows\/[^/]+\.ya?ml$/iu.test(path)) environmentFiles.add(path);
          const language = languageOf(entry.name);
          if (!language) continue;
          if (language === "python") continue;
          const isTest = isNamedTest(path, entry.name, language, inPythonTests);
          let containsTests = isTest;
          if (language === "java" && isTest) {
            const source = await readFile(join(repo, path), "utf8");
            containsTests = /\borg\.junit(?:\.|\b)/u.test(source);
          }
          if (language === "rust" && !containsTests) {
            const source = await readFile(join(repo, path), "utf8");
            containsTests = /#\s*\[\s*(?:tokio::)?test(?:\s*\([^\]]*\))?\s*\]/u.test(source);
          }
          if (containsTests) languagesWithTests.add(language);
          if (containsTests) {
            const directory = posix.dirname(path);
            if (directory !== ".") testDirectories.add(directory);
          }
          sourceCandidates.push({ spec: { path, type: containsTests ? "test_code" : "production_code" }, language });
        }
      };
      await walk("", false);
    } catch (cause) {
      throw new Error(`扫描失败 ${currentPath}: ${cause instanceof Error ? cause.message : String(cause)}`, { cause });
    }

    const files = new Map<string, SourceSpec>();
    for (const spec of pythonScan.files) files.set(spec.path, spec);
    if (pythonScan.files.some((file) => file.type === "test_code")) languagesWithTests.add("python");
    for (const path of pythonScan.summary.testDirectories) testDirectories.add(path);
    for (const path of pythonScan.summary.configFiles) configs.add(path);
    for (const path of pythonScan.summary.environmentFiles) environmentFiles.add(path);
    for (const candidate of sourceCandidates) {
      if (languagesWithTests.has(candidate.language)) files.set(candidate.spec.path, candidate.spec);
    }
    if (languagesWithTests.size > 0) {
      for (const path of configs) files.set(path, { path, type: "test_configuration" });
      for (const path of environmentFiles) files.set(path, { path, type: "test_configuration" });
    }
    const warnings = languagesWithTests.size === 0 ? ["未发现受支持的 Python、Java、Go 或 Rust 测试来源文件。"] : [];
    const sorted = [...files.values()].sort((a, b) => a.path.localeCompare(b.path));
    const detectedLanguages = [...languagesWithTests].sort();
    return {
      files: sorted,
      summary: {
        mode: "auto", fileCount: sorted.length, testDirectories: [...testDirectories].sort(),
        configFiles: [...configs].sort(), environmentFiles: [...environmentFiles].sort(),
        detectedLanguages, detectedFrameworks: detectedLanguages.map((language) => frameworkOf(language)), warnings,
      },
    };
  }
}
