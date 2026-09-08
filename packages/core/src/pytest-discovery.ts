/**
 * pytest test discovery, aligned with pytest's own defaults.
 *
 * pytest resolves a single configuration file (highest precedence first:
 * pytest.ini, pyproject.toml [tool.pytest.ini_options], tox.ini [pytest],
 * setup.cfg [tool:pytest]) and falls back to these defaults:
 *
 *   python_files     = ["test_*.py", "*_test.py"]
 *   python_functions = ["test"]
 *   python_classes   = ["Test"]
 *
 * `python_functions` / `python_classes` entries are prefixes unless they
 * contain a glob character; `python_files` entries are always globs matched
 * against the file basename.
 */

export type PytestConfig = {
  pythonFiles: string[];
  pythonFunctions: string[];
  pythonClasses: string[];
};

export type ConfigSource = {
  path: string;
  text: string;
};

export const DEFAULT_PYTEST_CONFIG: PytestConfig = {
  pythonFiles: ["test_*.py", "*_test.py"],
  pythonFunctions: ["test"],
  pythonClasses: ["Test"],
};

const CONFIG_PRECEDENCE = ["pytest.ini", "pyproject.toml", "tox.ini", "setup.cfg"] as const;

function basename(path: string): string {
  return path.replaceAll("\\", "/").split("/").pop() ?? path;
}

/** Convert a pytest glob pattern (`*` / `?`) into an anchored regular expression. */
export function globToRegExp(pattern: string): RegExp {
  const escaped = pattern.replace(/[.+^${}()|[\]\\]/gu, "\\$&").replaceAll("*", ".*").replaceAll("?", ".");
  return new RegExp(`^${escaped}$`, "u");
}

/** pytest treats a bare name as a prefix and anything with `*` / `?` as a glob. */
export function matchesPytestName(patterns: string[], name: string): boolean {
  return patterns.some((pattern) => (/[*?]/u.test(pattern) ? globToRegExp(pattern).test(name) : name.startsWith(pattern)));
}

function matchesGlob(patterns: string[], name: string): boolean {
  return patterns.some((pattern) => globToRegExp(pattern).test(name));
}

export function isTestModulePath(path: string, config: PytestConfig = DEFAULT_PYTEST_CONFIG): boolean {
  return matchesGlob(config.pythonFiles, basename(path));
}

export function isConftestPath(path: string): boolean {
  return basename(path) === "conftest.py";
}

export function isTestFunctionName(name: string, config: PytestConfig = DEFAULT_PYTEST_CONFIG): boolean {
  return matchesPytestName(config.pythonFunctions, name);
}

export function isTestClassName(name: string, config: PytestConfig = DEFAULT_PYTEST_CONFIG): boolean {
  return matchesPytestName(config.pythonClasses, name);
}

/** True when the decorator list contains a fixture decorator (`pytest.fixture`, `fixture`, ...). */
export function isFixtureDecorator(decorator: string): boolean {
  return /(?:^|\.)fixture\b/u.test(decorator);
}

function stripTomlComment(line: string): string {
  let inSingle = false;
  let inDouble = false;
  let result = "";
  for (const char of line) {
    if (char === "'" && !inDouble) inSingle = !inSingle;
    else if (char === '"' && !inSingle) inDouble = !inDouble;
    else if (char === "#" && !inSingle && !inDouble) break;
    result += char;
  }
  return result;
}

function isBalanced(value: string): boolean {
  let depth = 0;
  let inSingle = false;
  let inDouble = false;
  for (const char of value) {
    if (char === "'" && !inDouble) inSingle = !inSingle;
    else if (char === '"' && !inSingle) inDouble = !inDouble;
    else if (!inSingle && !inDouble) {
      if (char === "[") depth += 1;
      else if (char === "]") depth -= 1;
    }
  }
  return depth <= 0 && !inSingle && !inDouble;
}

function parseStringList(value: string): string[] {
  const quoted = [...value.matchAll(/"([^"]*)"|'([^']*)'/gu)]
    .map((match) => match[1] ?? match[2] ?? "")
    .filter(Boolean);
  if (quoted.length > 0) return quoted;
  return value.split(/\s+/u).filter(Boolean);
}

function toConfig(values: Map<string, string>): Partial<PytestConfig> {
  const config: Partial<PytestConfig> = {};
  const files = values.get("python_files");
  if (files !== undefined) {
    const list = parseStringList(files);
    if (list.length > 0) config.pythonFiles = list;
  }
  const functions = values.get("python_functions");
  if (functions !== undefined) {
    const list = parseStringList(functions);
    if (list.length > 0) config.pythonFunctions = list;
  }
  const classes = values.get("python_classes");
  if (classes !== undefined) {
    const list = parseStringList(classes);
    if (list.length > 0) config.pythonClasses = list;
  }
  return config;
}

function parseIniSection(text: string, section: string): Partial<PytestConfig> {
  const values = new Map<string, string>();
  let active = false;
  for (const raw of text.split(/\r?\n/u)) {
    const line = raw.trim();
    const header = /^\[(.+?)\]$/u.exec(line);
    if (header) {
      active = (header[1]?.trim().toLowerCase() ?? "") === section.toLowerCase();
      continue;
    }
    if (!active || !line || line.startsWith("#") || line.startsWith(";")) continue;
    const entry = /^([A-Za-z_][\w-]*)\s*[:=]\s*(.*)$/u.exec(line);
    if (!entry) continue;
    const key = entry[1];
    const value = entry[2];
    if (key === undefined || value === undefined) continue;
    values.set(key.toLowerCase(), value.trim());
  }
  return toConfig(values);
}

function parseTomlSection(text: string, section: string): Partial<PytestConfig> {
  const lines = text.split(/\r?\n/u);
  const values = new Map<string, string>();
  let active = false;
  for (let index = 0; index < lines.length; index += 1) {
    const line = stripTomlComment(lines[index] ?? "").trim();
    const header = /^\[(.+?)\]$/u.exec(line);
    if (header) {
      active = (header[1]?.trim() ?? "") === section;
      continue;
    }
    if (!active || !line) continue;
    const entry = /^([A-Za-z_][\w-]*)\s*=\s*(.*)$/u.exec(line);
    if (!entry) continue;
    const key = entry[1];
    let value = entry[2];
    if (key === undefined || value === undefined) continue;
    while (!isBalanced(value) && index + 1 < lines.length) {
      index += 1;
      value += ` ${stripTomlComment(lines[index] ?? "").trim()}`;
    }
    values.set(key.toLowerCase(), value.trim());
  }
  return toConfig(values);
}

/** Parse one configuration file. Unknown files return an empty override. */
export function parsePytestConfigFile(path: string, text: string): Partial<PytestConfig> {
  const name = basename(path).toLowerCase();
  if (name === "pyproject.toml") return parseTomlSection(text, "tool.pytest.ini_options");
  if (name === "setup.cfg") return parseIniSection(text, "tool:pytest");
  if (name === "pytest.ini" || name === "tox.ini") return parseIniSection(text, "pytest");
  return {};
}

/**
 * Resolve the effective pytest config from candidate files. pytest honours only
 * the highest-precedence file that exists, so the first match wins.
 */
export function resolvePytestConfig(sources: ConfigSource[]): PytestConfig {
  for (const name of CONFIG_PRECEDENCE) {
    const source = sources.find((item) => basename(item.path).toLowerCase() === name);
    if (source) return { ...DEFAULT_PYTEST_CONFIG, ...parsePytestConfigFile(source.path, source.text) };
  }
  return { ...DEFAULT_PYTEST_CONFIG };
}
