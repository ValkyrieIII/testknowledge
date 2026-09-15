import { createHash } from "node:crypto";
import type { Evidence } from "@testknowledge/model";
import type { ProjectScope, SourceAdapter, SourceFile } from "@testknowledge/core";

type Language = "java" | "go" | "rust";
type Framework = "junit" | "go-testing" | "rust-test";
type CallFact = { name: string; text: string; lineStart: number; lineEnd: number };
type FunctionFact = { name: string; parameters: string[]; rawParameters: string; lineStart: number; lineEnd: number; annotations: string[]; body: string };

const hash = (value: string): string => createHash("sha256").update(value).digest("hex");

function languageOf(path: string): { language: Language; framework: Framework } | null {
  if (path.endsWith(".java")) return { language: "java", framework: "junit" };
  if (path.endsWith(".go")) return { language: "go", framework: "go-testing" };
  if (path.endsWith(".rs")) return { language: "rust", framework: "rust-test" };
  return null;
}

function blockEnd(lines: string[], start: number): number {
  let depth = 0;
  let opened = false;
  for (let index = start; index < lines.length; index += 1) {
    for (const character of lines[index] ?? "") {
      if (character === "{") { depth += 1; opened = true; }
      if (character === "}") depth -= 1;
    }
    if (opened && depth <= 0) return index + 1;
  }
  return start + 1;
}

function precedingAnnotations(lines: string[], start: number): string[] {
  const result: string[] = [];
  for (let index = start - 1; index >= 0; index -= 1) {
    const value = (lines[index] ?? "").trim();
    if (!value) continue;
    if (!value.startsWith("@") && !value.startsWith("#[")) break;
    result.unshift(value);
  }
  return result;
}

function parameterNames(raw: string): string[] {
  return raw.split(",").map((part) => part.trim()).filter(Boolean).map((part) => {
    const withoutDefault = part.split("=")[0]?.trim() ?? part;
    const rustName = withoutDefault.match(/(?:^|\s)([A-Za-z_]\w*)\s*:/u)?.[1];
    const tokens = withoutDefault.replace(/<[^>]*>/gu, "").split(/\s+/u);
    return rustName ?? tokens.at(-1)?.replace(/[^A-Za-z0-9_]/gu, "") ?? "";
  }).filter(Boolean);
}

function functions(lines: string[], language: Language): FunctionFact[] {
  const patterns: Record<Language, RegExp> = {
    java: /^\s*(?:(?:public|protected|private|static|final|synchronized|abstract|native|default)\s+)*(?:[A-Za-z_$][\w$.[\]<>?,]*\s+)+([A-Za-z_$][\w$]*)\s*\(([^)]*)\)\s*(?:throws\s+[^{]+)?\{/u,
    go: /^\s*func\s+(?:\([^)]*\)\s*)?([A-Za-z_]\w*)\s*\(([^)]*)\)[^{]*\{/u,
    rust: /^\s*(?:pub(?:\([^)]*\))?\s+)?(?:async\s+)?(?:unsafe\s+)?fn\s+([A-Za-z_]\w*)\s*\(([^)]*)\)[^{]*\{/u,
  };
  return lines.flatMap((line, index) => {
    const match = line.match(patterns[language]);
    if (!match?.[1]) return [];
    const lineEnd = blockEnd(lines, index);
    return [{
      name: match[1], parameters: parameterNames(match[2] ?? ""), rawParameters: match[2] ?? "", lineStart: index + 1, lineEnd,
      annotations: precedingAnnotations(lines, index), body: lines.slice(index, lineEnd).join("\n"),
    }];
  });
}

function calls(body: string, lineStart: number): CallFact[] {
  const lines = body.split("\n");
  return lines.flatMap((line, index) => [...line.matchAll(/\b([A-Za-z_$][\w$]*(?:(?:\.|::)[A-Za-z_$][\w$]*)*)!?\s*\(/gu)].map((match) => ({
    name: match[1]!, text: line.trim(), lineStart: lineStart + index, lineEnd: lineStart + index,
  })));
}

function assertions(body: string, language: Language, lineStart: number): CallFact[] {
  const patterns: Record<Language, RegExp> = {
    java: /\b(?:assert[A-Z]\w*|Assertions\.assert[A-Z]\w*)\s*\(/u,
    go: /\b(?:t|tb|b)\.(?:Error|Errorf|Fatal|Fatalf|Fail|FailNow)\s*\(|\b(?:assert|require)\.\w+\s*\(/u,
    rust: /\b(?:assert|assert_eq|assert_ne|debug_assert|debug_assert_eq|debug_assert_ne)!\s*\(/u,
  };
  return body.split("\n").flatMap((line, index) => patterns[language].test(line) ? [{ name: "assertion", text: line.trim(), lineStart: lineStart + index, lineEnd: lineStart + index }] : []);
}

function testMetadata(fn: FunctionFact, language: Language, frameworkAvailable = true): { isTest: boolean; isFixture: boolean; isSetup: boolean; expectedExceptions: string[]; parametrized: string[] } {
  const annotations = fn.annotations.join("\n");
  if (language === "java") {
    const isTest = frameworkAvailable && /@(?:[A-Za-z_$][\w$]*\.)*(Test|ParameterizedTest|RepeatedTest|TestFactory)\b/u.test(annotations);
    const isSetup = frameworkAvailable && /@(?:[A-Za-z_$][\w$]*\.)*(BeforeEach|BeforeAll|AfterEach|AfterAll)\b/u.test(annotations);
    const expectedExceptions = [
      ...[...fn.body.matchAll(/\bassertThrows\s*\(\s*([A-Za-z_$][\w$.]*)\.class/gu)].map((match) => match[1]!),
      ...[...annotations.matchAll(/\bexpected\s*=\s*([A-Za-z_$][\w$.]*)\.class/gu)].map((match) => match[1]!),
    ];
    return { isTest, isFixture: false, isSetup, expectedExceptions, parametrized: /@(?:ParameterizedTest|ValueSource|CsvSource|MethodSource|EnumSource)\b/u.test(annotations) ? fn.annotations : [] };
  }
  if (language === "go") {
    const test = /^Test[A-Z_]/u.test(fn.name) && /\*testing\.T\b/u.test(fn.rawParameters);
    const benchmark = /^Benchmark[A-Z_]/u.test(fn.name) && /\*testing\.B\b/u.test(fn.rawParameters);
    const fuzz = /^Fuzz[A-Z_]/u.test(fn.name) && /\*testing\.F\b/u.test(fn.rawParameters);
    const example = /^Example(?:[A-Z_]|$)/u.test(fn.name) && fn.rawParameters.trim() === "";
    const isSetup = fn.name === "TestMain" && /\*testing\.M\b/u.test(fn.rawParameters);
    return { isTest: test || benchmark || fuzz || example, isFixture: false, isSetup, expectedExceptions: [], parametrized: [] };
  }
  return { isTest: /#\s*\[\s*(?:tokio::)?test(?:\s*\([^\]]*\))?\s*\]/u.test(annotations), isFixture: false, isSetup: false, expectedExceptions: /#\s*\[\s*should_panic/u.test(annotations) ? ["panic"] : [], parametrized: [] };
}

function mockNames(callFacts: CallFact[], language: Language): string[] {
  const patterns: Record<Language, RegExp> = {
    java: /(?:^|\.)(?:mock|spy|when|verify|doReturn|doThrow)$/u,
    go: /(?:^|\.)(?:NewMock\w*|NewController|EXPECT)$/u,
    rust: /(?:^|\.|::)(?:mock|expect_\w+)$/u,
  };
  return [...new Set(callFacts.map((call) => call.name).filter((name) => patterns[language].test(name)))];
}

/** Shared lexical implementation; each exported framework adapter remains independently replaceable. */
class LexicalFrameworkAdapter implements SourceAdapter {
  constructor(readonly id: string, private readonly language: Language, private readonly framework: Framework) {}

  supports(file: SourceFile): boolean {
    return languageOf(file.path)?.language === this.language && (file.type === "test_code" || file.type === "production_code");
  }

  async collect(file: SourceFile, scope: ProjectScope): Promise<Evidence[]> {
    const lines = file.text.split(/\r?\n/u);
    const frameworkAvailable = this.language !== "java" || /\borg\.junit(?:\.|\b)/u.test(file.text);
    const extractedAt = new Date().toISOString();
    const result: Evidence[] = [];
    const add = (symbol: string, start: number, end: number, sourceType: Evidence["sourceType"], payload: Record<string, unknown>): void => {
      const content = lines.slice(start - 1, end).join("\n");
      const contentHash = hash(content);
      result.push({
        id: `ev_${hash(`${scope.repo}:${file.path}:${symbol}:${start}:${contentHash}`).slice(0, 24)}`,
        sourceType, sourceRef: `${file.path}:${start}`, repo: scope.repo, revision: scope.revision,
        path: file.path, symbol, lineStart: start, lineEnd: end, contentHash, extractedAt,
        extractor: this.id, content, confidence: 0.85, payload: { language: this.language, framework: frameworkAvailable ? this.framework : "", ...payload, snippet: content },
      });
    };
    add("", 1, Math.max(1, lines.length), file.type, {
      isTestModule: file.type === "test_code",
      imports: lines.map((line) => line.trim()).filter((line) => /^(?:import|use|package)\b/u.test(line)),
    });
    for (const fn of functions(lines, this.language)) {
      const metadata = testMetadata(fn, this.language, frameworkAvailable);
      const callFacts = calls(fn.body, fn.lineStart);
      const assertionFacts = assertions(fn.body, this.language, fn.lineStart);
      const sourceType = metadata.isTest || metadata.isFixture || metadata.isSetup ? "test_code" : file.type;
      add(fn.name, fn.lineStart, fn.lineEnd, sourceType, {
        isTest: metadata.isTest,
        isFixture: metadata.isFixture,
        isSetup: metadata.isSetup,
        isTestModule: file.type === "test_code",
        annotations: fn.annotations.map((text) => ({ name: text.match(/[A-Za-z_]\w*/u)?.[0] ?? text, text })),
        parameters: fn.parameters.map((name) => ({ name })),
        assertions: assertionFacts,
        calls: callFacts,
        withBlocks: [],
        tryHandlers: [],
        expectedExceptions: metadata.expectedExceptions,
        fixtureRequests: [],
        mocks: mockNames(callFacts, this.language),
        parametrize: metadata.parametrized,
      });
    }
    return result;
  }
}

/** Conservative JUnit adapter for explicit annotations, assertions, mocks, and lifecycle hooks. */
export class JavaJUnitAdapter extends LexicalFrameworkAdapter {
  constructor() { super("source.java-junit.lexical-v1", "java", "junit"); }
}

/** Conservative Go testing adapter for tests, benchmarks, fuzz targets, examples, and TestMain. */
export class GoTestingAdapter extends LexicalFrameworkAdapter {
  constructor() { super("source.go-testing.lexical-v1", "go", "go-testing"); }
}

/** Conservative Rust adapter for explicit test attributes, assertions, panic expectations, and mocks. */
export class RustTestAdapter extends LexicalFrameworkAdapter {
  constructor() { super("source.rust-test.lexical-v1", "rust", "rust-test"); }
}
