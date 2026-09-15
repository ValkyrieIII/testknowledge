import { createHash } from "node:crypto";
import type { Evidence } from "@testknowledge/model";
import type { ProjectScope, SourceAdapter, SourceFile } from "@testknowledge/core";

const hash = (value: string): string => createHash("sha256").update(value).digest("hex");

function unique(values: string[]): string[] {
  return [...new Set(values.filter(Boolean))];
}

type DocumentedRunInstruction = { commandText: string; workingDirectory?: string };

const commandPattern = /^(?:(?:uv\s+run\s+)?pytest|python\s+-m\s+pytest|mvn(?:w)?\s+[^#\r\n]*\btest|(?:\.\/)?gradlew?\s+[^#\r\n]*\btest|go\s+test|cargo\s+test)(?:\s|$)/u;

function documentedRunInstructions(lines: string[]): DocumentedRunInstruction[] {
  let stepWorkingDirectory: string | undefined;
  const instructions: DocumentedRunInstruction[] = [];
  for (const line of lines) {
    if (/^\s*-\s+(?:name|uses)\s*:/iu.test(line)) stepWorkingDirectory = undefined;
    const workingDirectory = /^\s*working-directory\s*:\s*["']?([^"'#\s]+)/iu.exec(line)?.[1];
    if (workingDirectory) stepWorkingDirectory = workingDirectory;

    const candidate = line.trim().replace(/^-?\s*run\s*:\s*/iu, "");
    if (candidate === "|" || candidate === ">" || !commandPattern.test(candidate)) continue;
    instructions.push({ commandText: candidate, ...(stepWorkingDirectory ? { workingDirectory: stepWorkingDirectory } : {}) });
  }
  return [...new Map(instructions.map((instruction) => [`${instruction.workingDirectory ?? ""}\u0000${instruction.commandText}`, instruction])).values()];
}

export class TestEnvironmentAdapter implements SourceAdapter {
  readonly id = "source.test-environment.static-v2";

  supports(file: SourceFile): boolean {
    return file.type === "test_configuration" && !file.path.endsWith(".py");
  }

  async collect(file: SourceFile, scope: ProjectScope): Promise<Evidence[]> {
    const envNames = unique([
      ...[...file.text.matchAll(/\$\{([A-Z][A-Z0-9_]*)/gu)].map((match) => match[1] ?? ""),
      ...[...file.text.matchAll(/\b(?:os\.getenv|environ\.get)\(\s*["']([A-Z][A-Z0-9_]*)/gu)].map((match) => match[1] ?? ""),
      ...[...file.text.matchAll(/^\s*([A-Z][A-Z0-9_]*)\s*=/gmu)].map((match) => match[1] ?? ""),
    ]);
    const lines = file.text.split(/\r?\n/u);
    const path = file.path.replaceAll("\\", "/");
    const profiles = path.endsWith("pom.xml") || /(?:^|\/)build\.gradle(?:\.kts)?$/u.test(path)
      ? { languages: ["java"], frameworks: ["junit"], defaultCommands: [path.endsWith("pom.xml") ? "mvn test" : "./gradlew test"] }
      : path.endsWith("go.mod") ? { languages: ["go"], frameworks: ["go-testing"], defaultCommands: ["go test ./..."] }
        : path.endsWith("Cargo.toml") ? { languages: ["rust"], frameworks: ["rust-test"], defaultCommands: ["cargo test"] }
          : /(?:^|\/)pytest\.ini$/u.test(path) || (path.endsWith("pyproject.toml") && /\[tool\.pytest\.ini_options\]/u.test(file.text)) || (/(?:^|\/)(?:tox\.ini|setup\.cfg)$/u.test(path) && /\[(?:pytest|tool:pytest)\]/u.test(file.text))
            ? { languages: ["python"], frameworks: ["pytest"], defaultCommands: ["pytest"] }
            : { languages: [], frameworks: [], defaultCommands: [] };
    const documented = documentedRunInstructions(lines);
    const documentedCommands = documented.map((instruction) => instruction.commandText);
    const runCommands = unique([...documentedCommands, ...profiles.defaultCommands]);
    // A directory is only ever published attached to the step that declares it, via
    // `runInstructions`. Scanning `working-directory:` across the whole file would produce a bare
    // list of directories that the source never associated with anything — and any reader, human
    // or model, will pair that list with the adjacent command list and invent a working
    // directory for a test command. That is exactly how a CI command came to be documented as
    // running from `frontend`.
    const serviceImages = unique(lines.flatMap((line) => {
      const match = /^\s*image\s*:\s*["']?([^"'#\s]+)/iu.exec(line);
      return match?.[1] ? [match[1]] : [];
    }));
    const defaultInstructions = profiles.defaultCommands.filter((commandText) => !documentedCommands.includes(commandText)).map((commandText) => ({ commandText }));
    const runInstructions = [...documented, ...defaultInstructions];
    const summary = { runCommands, runInstructions, environmentVariableNames: envNames, serviceImages };
    const contentHash = hash(file.text);
    return [{
      id: `ev_${hash(`${scope.repo}:${file.path}:${contentHash}`).slice(0, 24)}`,
      sourceType: "test_configuration",
      sourceRef: `${file.path}:1`,
      repo: scope.repo,
      revision: scope.revision,
      path: file.path,
      symbol: "",
      lineStart: 1,
      lineEnd: Math.max(1, lines.length),
      contentHash,
      extractedAt: new Date().toISOString(),
      extractor: this.id,
      content: JSON.stringify(summary),
      confidence: 1,
      payload: { environmentProfile: summary, runCommands, languages: profiles.languages, frameworks: profiles.frameworks },
    }];
  }
}
