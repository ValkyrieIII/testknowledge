import { lstat, readdir, readFile } from "node:fs/promises";
import { join, posix, resolve } from "node:path";
import { isTestModulePath, resolvePytestConfig, type ProjectScan, type ProjectScanner, type SourceSpec } from "@testknowledge/core";

const EXCLUDED = new Set([
  ".git", ".hg", ".svn", "node_modules", ".venv", "venv", "env",
  "dist", "build", "target", "coverage", "vendor", "__pycache__", ".pytest_cache", ".tox",
  ".nox", ".mypy_cache", ".ruff_cache", ".gradle", ".idea", ".codegraph", ".testknowledge",
]);
const CONFIG_FILES = ["pytest.ini", "pyproject.toml", "tox.ini", "setup.cfg"];
const ENVIRONMENT_FILES = /^(?:\.env\.example|dockerfile|compose(?:\.[^.]+)?\.ya?ml|docker-compose(?:\.[^.]+)?\.ya?ml|makefile)$/iu;

/** Discover inputs only; the pytest adapter owns test and fixture recognition. */
export class PytestProjectScanner implements ProjectScanner {
  async scan(input: string): Promise<ProjectScan> {
    const repo = resolve(input);
    const files = new Map<string, SourceSpec>();
    const directories = new Set<string>();
    const configs: string[] = [];
    const environmentFiles: string[] = [];
    const warnings: string[] = [];
    let testFileCount = 0;
    let currentPath = repo;
    try {
      const root = await lstat(repo);
      if (!root.isDirectory() || root.isSymbolicLink()) throw new Error("仓库路径必须是实际目录");
      const walk = async (relative: string, inTests: boolean, ancestors: string[]): Promise<void> => {
        currentPath = join(repo, relative);
        const entries = await readdir(currentPath, { withFileTypes: true });
        entries.sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0);
        const conftest = entries.find((entry) => entry.name === "conftest.py" && entry.isFile());
        const support = conftest ? [...ancestors, posix.join(relative, conftest.name)] : ancestors;
        if (inTests) {
          for (const path of support) files.set(path, { path, type: "test_code" });
        }
        for (const entry of entries) {
          if (entry.isSymbolicLink()) continue;
          const path = posix.join(relative, entry.name);
          if (entry.isDirectory()) {
            if (EXCLUDED.has(entry.name)) continue;
            const isTests = entry.name === "test" || entry.name === "tests";
            if (isTests) directories.add(path);
            await walk(path, inTests || isTests, support);
          } else if (entry.isFile()) {
            if (!relative && CONFIG_FILES.includes(entry.name)) configs.push(path);
            if ((!relative && ENVIRONMENT_FILES.test(entry.name)) || /^\.github\/workflows\/[^/]+\.ya?ml$/iu.test(path)) environmentFiles.push(path);
            if (entry.name.endsWith(".py")) {
              const isTestSupport = inTests || entry.name === "conftest.py";
              files.set(path, { path, type: isTestSupport ? "test_code" : "production_code" });
              if (inTests) testFileCount += 1;
            }
          }
        }
      };
      await walk("", false, []);
      const configSources = await Promise.all(configs.map(async (path) => ({ path, text: await readFile(join(repo, path), "utf8") })));
      const pytestConfig = resolvePytestConfig(configSources);
      for (const [path, spec] of files) {
        if (spec.type !== "production_code" || !path.endsWith(".py") || !isTestModulePath(path, pytestConfig)) continue;
        files.set(path, { path, type: "test_code" });
        testFileCount += 1;
      }
    } catch (cause) {
      throw new Error(`扫描失败 ${currentPath}: ${cause instanceof Error ? cause.message : String(cause)}`, { cause });
    }
    if (!testFileCount) {
      files.clear();
      warnings.push("未在 test/tests 目录中发现 Python 测试来源文件。");
    } else {
      for (const path of configs) files.set(path, { path, type: "test_configuration" });
      for (const path of environmentFiles) files.set(path, { path, type: "test_configuration" });
    }
    const sorted = [...files.values()].sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
    return {
      files: sorted,
      summary: { mode: "auto", fileCount: sorted.length, testDirectories: [...directories].sort(), configFiles: configs.sort(), environmentFiles: environmentFiles.sort(), warnings },
    };
  }
}
