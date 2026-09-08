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

export class RuleCandidateExtractor implements CandidateExtractor {
  readonly id = "extractor.rules.observed-v2";

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
      if (assertions.length === 0 && fixtureRequests.length === 0 && mocks.length === 0) continue;
      const kind = mocks.length > 0 ? "mock" : fixtureRequests.length > 0 ? "fixture" : "assertion";
      const statement = assertions.length > 0 ? `源测试包含断言：${assertions.join("；")}` : `源测试使用：${[...fixtureRequests, ...mocks].join("；")}`;
      drafts.push({
        kind,
        title: `${item.symbol} 的已观察测试做法`,
        statement,
        trigger: `任务涉及 ${item.symbol} 或同一测试上下文时参考`,
        expectedBehavior: "只复用来源中明确出现的测试设置或断言，不推断未记录的业务意图",
        oracle: assertions.join("；") || "检查测试是否保留来源中的设置方式",
        risk: "这是语法观察，不等于行为已经被证明",
        path: item.path,
        symbol: item.symbol,
        evidenceIds: [item.id],
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
      confidence: 0.5,
    };
  }
}
