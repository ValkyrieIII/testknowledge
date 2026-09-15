# A/B/C 行为评估

评估比较三种固定条件：

- A：普通 Agent；
- B：Agent + CodeGraph；
- C：Agent + CodeGraph + TestKnowledge。

系统只冻结条件、接收外部执行证据并计算报告，不启动 Agent，也不执行测试。执行应在隔离环境完成，结果先通过 `record-feedback` 写成 `execution_result` Evidence，并在 `evaluation` 字段绑定计划、任务、变体和运行。

## 1. 冻结计划

创建计划时必须一次性给出仓库版本、模型、完整提示词模板、工具清单、预算、任务真值和判定阈值。计划按内容寻址并标记为 `frozen`，不能就地修改；调整条件会产生新计划。v2 的 `promptHash` 同时覆盖通用模板以及每个任务的实际提示，不再只哈希模板。

```json
{
  "repo": "D:/projects/example",
  "revision": "build-revision",
  "model": "fixed-model",
  "promptTemplate": "固定的测试生成提示词",
  "tools": ["read_file", "search_files", "edit_file", "run_isolated_test", "codegraph_explore", "get_test_context"],
  "variantTools": {
    "A_ordinary_agent": ["read_file", "search_files", "edit_file", "run_isolated_test"],
    "B_codegraph": ["read_file", "search_files", "edit_file", "run_isolated_test", "codegraph_explore"],
    "C_codegraph_testknowledge": ["read_file", "search_files", "edit_file", "run_isolated_test", "codegraph_explore", "get_test_context"]
  },
  "budget": {
    "maxTokens": 12000,
    "maxToolCalls": 30,
    "maxDurationMs": 900000
  },
  "tasks": [
    {
      "id": "task-01",
      "prompt": "为 create_order 补充测试",
      "targetSymbols": ["create_order"],
      "changedFiles": ["src/order.py"],
      "criticalBoundaryIds": ["inventory-zero", "inventory-equal"],
      "seededBugIds": ["bug-no-rollback"],
      "requiredOracleIds": ["order-unchanged", "inventory-unchanged"],
      "fixtureMockCriteria": ["reuse-order-fixture", "mock-payment-only"]
    }
  ],
  "acceptance": {
    "minimumCompleteTasks": 3,
    "minimumTaskWinRate": 0.67,
    "maximumTaskLossRate": 0,
    "maximumTokenIncreaseRatio": 0.5,
    "maximumToolCallIncreaseRatio": 0.5,
    "maximumDurationIncreaseRatio": 0.5
  }
}
```

`tools` 是计划允许的工具全集；`variantTools` 冻结每个变体实际可用的白名单，并参与
`toolPolicyHash`。旧计划省略 `variantTools` 时按三组共享同一工具集合解释，不能用于证明代码图或测试知识的
独立增益。

执行前使用 `evaluation-manifest <plan-id> --run-set <id>`，或对应 HTTP/MCP 入口，把 v2 计划展开为每个任务、每个变体的运行规格。每个规格给出唯一 `runId`、`runSpecHash`，并把完整实际提示、模型、工具白名单与预算封装在 `agentInput`。执行器只能把 `agentInput` 交给被评 Agent；同级 `scoring` 是预先冻结的评分答案，只供隔离评估器使用，必须保持隐藏，避免答案泄漏。`runSetId` 使用可移植的字母、数字、点、下划线、冒号或连字符，且与任务、变体共同决定 `runId`；反馈和观察不能自定义运行身份。v1 历史计划没有运行规格完整性绑定，只能保留为历史，不能继续接收观察。

## 2. 记录观察

每个任务分别记录 A、B、C。`model`、`promptHash`、`toolPolicyHash` 和 `runSpecHash` 必须等于运行清单；
执行 Evidence 必须同时记录实际使用过的工具名、Token、工具调用次数和耗时，观察必须与这些字段逐项一致。
工具名不得超出对应变体白名单，用量不得超过冻结预算。所有命中项只能来自任务预先声明的 ID，避免运行后修改答案集。

对应的 `record-feedback` 输入必须包含：

```json
{
  "repo": "D:/projects/example",
  "revision": "build-revision",
  "sourceRef": "isolated-run-001/result.json",
  "command": ["外部隔离执行器及其参数"],
  "outcome": "passed",
  "observed": "执行结果摘要",
  "execution": {
    "durationMs": 420000,
    "testCounts": { "total": 12, "passed": 12, "failed": 0, "skipped": 0, "errors": 0 },
    "coverage": { "linesPercent": 91.4, "branchesPercent": 84.2, "coveredFiles": ["src/order.py"] },
    "mutation": { "scorePercent": 78.6, "killed": 22, "survived": 6, "timedOut": 0, "noCoverage": 1 },
    "failures": []
  },
  "evaluation": {
    "planId": "eval_...",
    "runSetId": "pilot-01",
    "taskId": "task-01",
    "variant": "C_codegraph_testknowledge",
    "runId": "evalrun_...",
    "runSpecHash": "运行清单返回的 runSpecHash",
    "model": "fixed-model",
    "promptHash": "计划返回的 promptHash",
    "toolPolicyHash": "计划返回的 toolPolicyHash",
    "usedTools": ["read_file", "get_test_context", "run_isolated_test"],
    "tokenUsage": 7000,
    "toolCalls": 18,
    "durationMs": 420000,
    "duplicateTestCount": 0,
    "brittleTestCount": 0
  }
}
```

`execution` 可省略或只提供已有字段。百分比统一使用 `0`～`100`，不会把 `0`～`1` 比例自动换算；
失败明细必须显式提供 `testId` 与 `message`。系统不从 `observed` 或日志正文猜测统计值。

若该次失败明确证明某张知识卡的 Oracle 已不成立，可同时绑定 `knowledgeId` 并提交人工或执行系统作出的结构化评估：

```json
{
  "outcome": "failed",
  "knowledgeId": "kn_...",
  "oracleAssessment": {
    "verdict": "contradicted",
    "assessor": "reviewer-or-runner-id",
    "note": "可复核的反例及判定依据"
  }
}
```

这会把已处于 `reviewed` 或 `verified` 的卡片降为 `stale`，建立 `INVALIDATED_BY` 关系并留下前后快照。
普通失败、执行错误和 `inconclusive` 不触发生命周期迁移；系统不会从自由文本自动推断 Oracle 失效。

```json
{
  "planId": "eval_...",
  "runSetId": "pilot-01",
  "taskId": "task-01",
  "variant": "C_codegraph_testknowledge",
  "runId": "运行清单返回的 evalrun_...",
  "model": "fixed-model",
  "promptHash": "计划返回的 promptHash",
  "toolPolicyHash": "计划返回的 toolPolicyHash",
  "runSpecHash": "运行清单返回的 runSpecHash",
  "usedTools": ["read_file", "get_test_context", "run_isolated_test"],
  "executionPassed": true,
  "coveredBoundaryIds": ["inventory-zero", "inventory-equal"],
  "detectedSeededBugIds": ["bug-no-rollback"],
  "effectiveOracleIds": ["order-unchanged", "inventory-unchanged"],
  "fixtureMockCorrect": true,
  "invalidAssertionCount": 0,
  "duplicateTestCount": 0,
  "brittleTestCount": 0,
  "tokenUsage": 7000,
  "toolCalls": 18,
  "durationMs": 420000,
  "evidenceIds": ["ev_..."],
  "recordedBy": "reviewer",
  "note": "隔离运行记录"
}
```

任务中的 `duplicateCriteria` 和 `brittlenessCriteria` 是评分者判断重复、脆弱测试的冻结口径，不传给被评 Agent。报告按运行批次配对 A/B/C，不能把不同 `runSetId` 的最新结果拼在一起。只有一个已记录批次时可以省略选择；存在多个批次时，CLI `evaluation-report <plan-id> --run-set <id>`、HTTP 或 MCP 调用必须明确选择。Web 同样按所选批次显示计数和报告，并单独展示无效断言、重复测试和脆弱测试。

同一个 `runId` 的观察不可修改。完全相同的重复提交会幂等返回原记录；任何字段变化都会被拒绝。需要修正执行条件或重跑时必须使用新的 `runSetId`，原批次继续作为不可变证据保留。

观察必须引用同仓库、同版本的 `execution_result` Evidence；计划、任务、变体、运行、运行规格哈希以及通过/失败字段都要与证据一致。

## 3. 判定

报告只使用 A/B/C 均齐全的任务，并以 B 为基线判断 C：

- 计算执行通过率、边界覆盖率、缺陷检出率、有效 Oracle、fixture/mock 正确率和无效断言；
- 统计 C 相对 B 的逐任务胜、负、平；
- 检查 Token、工具调用和耗时增幅；
- 至少一个行为指标必须严格改善，且不能用更差的执行通过率或更多无效断言换取；
- 未达到最小完整任务数时只能得到 `insufficient_data`。

这个报告证明的是“已记录证据是否满足预先冻结的判据”，不是对未执行任务的推断。
