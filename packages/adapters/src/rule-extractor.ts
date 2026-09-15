import type { Evidence, TestTechnique } from "@testknowledge/model";
import type { CandidateExtractor, KnowledgeDraft, ProjectScope } from "@testknowledge/core";
import { runInstructionTexts } from "@testknowledge/core";

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
  return [...new Set([...fromWith, ...fromTry, ...stringList(payload.expectedExceptions)])];
}

/** Raw decorator text for parametrised tests, so the input values stay visible. */
function parametrizeTexts(payload: Record<string, unknown>): string[] {
  return [...new Set([...factList(payload.decorators)
    .filter((item) => typeof item.name === "string" && /parametrize/u.test(item.name))
    .map((item) => (typeof item.text === "string" ? item.text : ""))
    .filter(Boolean), ...stringList(payload.parametrize)])];
}

function applicabilityFor(item: Evidence): { languages: string[]; frameworks: string[]; paths: string[]; symbols: string[]; revision: string } {
  return {
    languages: [...new Set([...stringList(item.payload.languages), ...(typeof item.payload.language === "string" && item.payload.language ? [item.payload.language] : [])])],
    frameworks: [...new Set([...stringList(item.payload.frameworks), ...(typeof item.payload.framework === "string" && item.payload.framework ? [item.payload.framework] : [])])],
    paths: [], symbols: [], revision: item.revision,
  };
}

function techniquesFor(
  payload: Record<string, unknown>,
  assertions: string[],
  fixtureRequests: string[],
  mocks: string[],
  exceptions: string[],
  parametrize: string[],
): TestTechnique[] {
  const techniques: TestTechnique[] = [];
  const calls = factList(payload.calls).flatMap((item) => typeof item.name === "string" ? [item.name] : []);
  const decorators = factList(payload.decorators).flatMap((item) => typeof item.name === "string" ? [item.name] : []);
  if (parametrize.length > 0) techniques.push("parameterized_input");
  if (parametrize.some((value) => /(?:^|[^\w])-?1(?:[^\w]|$)|(?:^|[^\w])0(?:[^\w]|$)|\bNone\b|["']{2}/u.test(value))) techniques.push("boundary_value");
  if (exceptions.length > 0) techniques.push("exception_path");
  if (factList(payload.tryHandlers).length > 0) techniques.push("error_handling");
  if (mocks.length > 0) techniques.push("dependency_isolation");
  if (fixtureRequests.length > 0) techniques.push("fixture_injection");
  if (assertions.some((value) => /==|assertEqual|assert_eq|(?:assert|require)\.Equal|pytest\.approx/u.test(value))) techniques.push("equivalence_assertion");
  if (decorators.some((value) => /(?:^|\.)(?:given|example)$/u.test(value))) techniques.push("property_based");
  if (calls.some((value) => /(?:^|\.)(?:match_snapshot|assert_match|snapshot)$/u.test(value))) techniques.push("snapshot_regression");
  if (calls.some((value) => /(?:^|\.)(?:gather|create_task|TaskGroup)$/u.test(value))) techniques.push("concurrency");
  return [...new Set(techniques)];
}

export class RuleCandidateExtractor implements CandidateExtractor {
  readonly id = "extractor.rules.observed-v5";

  async extract(evidence: Evidence[], _scope: ProjectScope): Promise<KnowledgeDraft[]> {
    const drafts: KnowledgeDraft[] = [];
    for (const item of evidence) {
      const payload = item.payload;
      if (item.sourceType === "issue") {
        const expectedBehavior = typeof payload.expectedBehavior === "string" ? payload.expectedBehavior : "";
        const actualBehavior = typeof payload.actualBehavior === "string" ? payload.actualBehavior : "";
        const reproduction = typeof payload.reproduction === "string" ? payload.reproduction : "";
        if (expectedBehavior && (actualBehavior || reproduction)) {
          const title = typeof payload.title === "string" ? payload.title : item.sourceRef;
          const affectedPaths = stringList(payload.affectedPaths);
          const targetSymbols = stringList(payload.targetSymbols);
          drafts.push({
            kind: "historical_bug",
            title: `${title} 的回归约束`,
            statement: actualBehavior ? `曾观察到：${actualBehavior}` : `复现路径：${reproduction}`,
            trigger: reproduction || `修改 ${[...affectedPaths, ...targetSymbols].join("、") || "相关行为"} 时参考`,
            expectedBehavior,
            oracle: `断言实际行为符合：${expectedBehavior}`,
            risk: "Issue 是缺陷报告证据；在关联回归测试通过前不代表问题已被验证修复",
            path: item.path,
            symbol: targetSymbols[0] ?? "",
            targetSymbols,
            partitions: [],
            preconditions: reproduction ? [reproduction] : [],
            dependencies: [],
            applicability: { languages: [], frameworks: [], paths: affectedPaths, symbols: targetSymbols, revision: item.revision },
            evidenceIds: [item.id],
            confidence: Math.min(item.confidence, 0.65),
          });
        }
        continue;
      }
      if (item.sourceType === "test_configuration" && payload.environmentProfile !== null && typeof payload.environmentProfile === "object") {
        const profile = payload.environmentProfile as Record<string, unknown>;
        const commands = stringList(profile.runCommands);
        const workingDirectories = stringList(profile.workingDirectories);
        const runInstructions = runInstructionTexts(profile);
        const envNames = stringList(profile.environmentVariableNames);
        const serviceImages = stringList(profile.serviceImages);
        if (runInstructions.length + commands.length + workingDirectories.length + envNames.length + serviceImages.length > 0) {
          const environmentStatement = runInstructions.length > 0
            ? `运行指令：${runInstructions.join("；")}`
            : [
              commands.length ? `命令（未配对）：${commands.join("；")}` : "",
              workingDirectories.length ? `工作目录（未配对）：${workingDirectories.join("、")}` : "",
            ].filter(Boolean).join("；");
          drafts.push({
            kind: "environment",
            title: `${item.path} 的测试环境约束`,
            statement: [environmentStatement, envNames.length ? `环境变量名：${envNames.join("、")}` : "", serviceImages.length ? `服务镜像：${serviceImages.join("、")}` : ""].filter(Boolean).join("；"),
            trigger: "准备或运行该项目测试时参考",
            expectedBehavior: "按来源文件记录的命令和环境约束准备测试，不推断未记录的变量值",
            oracle: "实际运行结果必须由外部隔离 runner 或 CI 另行回写",
            risk: runInstructions.length > 0
              ? "这是静态配置事实，不证明环境当前可用"
              : "这是静态配置事实，不证明环境当前可用；来源未提供逐条命令与工作目录配对",
            path: item.path,
            symbol: "",
            targetSymbols: [], partitions: [], preconditions: envNames, dependencies: serviceImages,
            applicability: applicabilityFor(item),
            evidenceIds: [item.id],
            confidence: 0.7,
          });
        }
        continue;
      }
      if (payload.isFixture === true) {
        drafts.push(this.fixtureDraft(item));
        continue;
      }
      if (payload.isSetup === true) {
        drafts.push(this.setupDraft(item));
        continue;
      }
      if (payload.isTest !== true) continue;

      const assertions = textList(payload.assertions);
      const fixtureRequests = stringList(payload.fixtureRequests);
      const mocks = stringList(payload.mocks);
      const factories = stringList(payload.factories);
      const exceptions = exceptionExpectations(payload);
      const parametrize = parametrizeTexts(payload);
      const techniques = techniquesFor(payload, assertions, fixtureRequests, mocks, exceptions, parametrize);
      if (
        assertions.length === 0 &&
        fixtureRequests.length === 0 &&
        mocks.length === 0 &&
        factories.length === 0 &&
        exceptions.length === 0 &&
        parametrize.length === 0
      ) {
        continue;
      }

      const kind = exceptions.length > 0 || mocks.length > 0 || factories.length > 0 || fixtureRequests.length > 0 ? "behavior" : "assertion";
      const parts: string[] = [];
      if (assertions.length > 0) parts.push(`断言：${assertions.join("；")}`);
      if (exceptions.length > 0) parts.push(`期望异常：${exceptions.join("、")}`);
      if (mocks.length > 0) parts.push(`mock：${mocks.join("、")}`);
      if (factories.length > 0) parts.push(`factory：${factories.join("、")}`);
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
        targetSymbols: [],
        partitions: parametrize,
        preconditions: fixtureRequests,
        dependencies: [...new Set([...fixtureRequests, ...factories, ...mocks])],
        techniques,
        applicability: applicabilityFor(item),
        evidenceIds: [item.id],
        observed: { assertions, expectedExceptions: exceptions, mocks, factories, dependencies: fixtureRequests, parametrize },
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
      targetSymbols: [],
      partitions: [],
      preconditions: parameters,
      dependencies: parameters,
      techniques: ["fixture_injection"],
      applicability: applicabilityFor(item),
      evidenceIds: [item.id],
      observed: { assertions: [], expectedExceptions: [], mocks: [], factories: [], dependencies: parameters, parametrize: [] },
      confidence: 0.5,
    };
  }

  private setupDraft(item: Evidence): KnowledgeDraft {
    const applicability = applicabilityFor(item);
    const framework = applicability.frameworks[0] ?? "测试框架";
    return {
      kind: "fixture",
      title: `${item.symbol} 是 ${framework} 生命周期钩子`,
      statement: `项目通过「${item.symbol}」准备或清理测试状态；它由 ${framework} 生命周期调用，不应当作可注入 fixture 使用`,
      trigger: `修改同一测试文件或复用其前置与清理约束时参考`,
      expectedBehavior: "保留框架生命周期顺序和共享状态边界，不手动调用钩子冒充测试准备",
      oracle: "相关测试在框架正常生命周期中完成准备、执行和清理",
      risk: "这是静态识别的生命周期结构；具体状态语义仍需阅读来源或执行证据",
      path: item.path,
      symbol: item.symbol,
      targetSymbols: [], partitions: [], preconditions: [], dependencies: [], techniques: [],
      applicability,
      evidenceIds: [item.id],
      observed: { assertions: [], expectedExceptions: [], mocks: [], factories: [], dependencies: [], parametrize: [] },
      confidence: 0.45,
    };
  }
}
