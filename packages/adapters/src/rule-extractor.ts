import type { Evidence } from "@testknowledge/model";
import type { CandidateExtractor, KnowledgeDraft, ProjectScope } from "@testknowledge/core";

function stringList(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

/** Assertions are structured facts ({ text, lineStart, lineEnd }); accept plain strings too. */
function textList(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item) => {
    if (typeof item === "string") return [item];
    if (item !== null && typeof item === "object" && typeof (item as { text?: unknown }).text === "string") {
      return [(item as { text: string }).text];
    }
    return [];
  });
}

function factList(value: unknown): Array<Record<string, unknown>> {
  return Array.isArray(value) ? value.filter((item): item is Record<string, unknown> => item !== null && typeof item === "object") : [];
}

/** Exception types the test expects: `with pytest.raises(E)` and `try/except E`. */
function exceptionExpectations(payload: Record<string, unknown>): string[] {
  const fromWith = factList(payload.withBlocks)
    .filter((item) => typeof item.call === "string" && /raises/u.test(item.call))
    .flatMap((item) => stringList(item.args).filter((arg) => /^[A-Za-z_][\w.]*$/u.test(arg)));
  const fromTry = factList(payload.tryHandlers).flatMap((item) => stringList(item.exceptionTypes));
  return [...new Set([...fromWith, ...fromTry])];
}

/** Raw decorator text for parametrised tests, so the input values stay visible. */
function parametrizeTexts(payload: Record<string, unknown>): string[] {
  return factList(payload.decorators)
    .filter((item) => typeof item.name === "string" && /parametrize/u.test(item.name))
    .map((item) => (typeof item.text === "string" ? item.text : ""))
    .filter(Boolean);
}

export class RuleCandidateExtractor implements CandidateExtractor {
  readonly id = "extractor.rules.observed-v3";

  async extract(evidence: Evidence[], _scope: ProjectScope): Promise<KnowledgeDraft[]> {
    const drafts: KnowledgeDraft[] = [];
    for (const item of evidence) {
      const payload = item.payload;
      if (payload.isFixture === true) {
        drafts.push(this.fixtureDraft(item));
        continue;
      }
      if (payload.isTest !== true) continue;

      const assertions = textList(payload.assertions);
      const fixtureRequests = stringList(payload.fixtureRequests);
      const mocks = stringList(payload.mocks);
      const exceptions = exceptionExpectations(payload);
      const parametrize = parametrizeTexts(payload);
      if (
        assertions.length === 0 &&
        fixtureRequests.length === 0 &&
        mocks.length === 0 &&
        exceptions.length === 0 &&
        parametrize.length === 0
      ) {
        continue;
      }

      const kind = exceptions.length > 0 || mocks.length > 0 || fixtureRequests.length > 0 ? "behavior" : "assertion";
      const parts: string[] = [];
      if (assertions.length > 0) parts.push(`断言：${assertions.join("；")}`);
      if (exceptions.length > 0) parts.push(`期望异常：${exceptions.join("、")}`);
      if (mocks.length > 0) parts.push(`mock：${mocks.join("、")}`);
      if (fixtureRequests.length > 0) parts.push(`依赖：${fixtureRequests.join("、")}`);
      if (parametrize.length > 0) parts.push(`参数化：${parametrize.join("；")}`);
      drafts.push({
        kind,
        title: `${item.symbol} 的已观察测试做法`,
        statement: parts.join("；") || "无观察事实",
        trigger: `任务涉及 ${item.symbol} 或同一测试上下文时参考`,
        expectedBehavior: "只复用来源中明确出现的测试设置或断言，不推断未记录的业务意图",
        oracle: assertions.join("；") || (exceptions.length > 0 ? `期望抛出：${exceptions.join("、")}` : "检查测试是否保留来源中的设置方式"),
        risk: "这是语法观察，不等于行为已经被证明",
        path: item.path,
        symbol: item.symbol,
        evidenceIds: [item.id],
        observed: { assertions, expectedExceptions: exceptions, mocks, dependencies: fixtureRequests, parametrize },
        confidence: 0.4,
      });
    }
    return drafts;
  }

  private fixtureDraft(item: Evidence): KnowledgeDraft {
    const parameters = stringList(item.payload.fixtureRequests);
    const dependency = parameters.length > 0 ? `（依赖：${parameters.join("、")}）` : "";
    return {
      kind: "fixture",
      title: `${item.symbol} 提供的 fixture`,
      statement: `项目已定义 fixture「${item.symbol}」${dependency}，测试应直接注入而不是自行构造等价数据`,
      trigger: `需要 ${item.symbol} 提供的测试数据、客户端或环境时使用`,
      expectedBehavior: "以参数形式注入该 fixture，复用项目既有的测试前置",
      oracle: "测试能通过该 fixture 完成收集并获得所需依赖",
      risk: "fixture 的内部实现可能变化，语义以其定义处为准",
      path: item.path,
      symbol: item.symbol,
      evidenceIds: [item.id],
      observed: { assertions: [], expectedExceptions: [], mocks: [], dependencies: parameters, parametrize: [] },
      confidence: 0.5,
    };
  }
}
