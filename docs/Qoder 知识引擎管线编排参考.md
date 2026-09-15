# Qoder 知识引擎管线编排参考

> 本文档记录 Qoder（Qoder CN 桌面端 v0.2.5）内置知识引擎的**运行管线与编排机制**，作为 TestKnowledge 的设计参考。
>
> **数据来源**：全部取自 Qoder 自身写入磁盘的自述式遥测，未做任何反编译或网络抓包。取证对象为 2026-09-15 对 `D:\projects\testing` 的一次 RepoWiki + Knowledge Card 全量生成。
>
> **注意**：本文初稿写于生成进行中，现已按**运行结束后的实测结局**更新。该次运行于 2026-09-15 16:45 结束，历时 **66 分钟**，但**并非正常完成**——195 页中 **140 页因配额耗尽失败**（详见 §11.1）。`run_history.state = "completed"` 在此具有误导性：它只表示"运行终止"，不代表产物完整。
>
> 文中所有**计数**为某一时刻快照；**结构与参数**稳定。

---

## 1. 可靠度分级

本文内容按证据强度分三级，阅读时请区分：

| 级别 | 含义 | 出现位置 |
|---|---|---|
| **【实测】** | 直接读到的明文数据、字段、数值 | 绝大部分 |
| **【推断】** | 由字段名/事件名/结构推测语义，未验证 | 已逐条标注 |
| **【未知】** | 明确没有观测到的部分 | 已逐条标注 |

---

## 2. 存储布局

知识库**不存放在被索引的仓库内**，而在用户级目录：

```
C:\Users\i\.qoder-cn\qoder-knowledge\
  <repoKey>-<hash>\                    # 例：knowledge-testing-e15d27a8f4de1e8a
    cards\cards.v1.db                  # Knowledge Card 库
    wiki\wiki.v1.db                    # RepoWiki 库
    vectors\vectors.v1.db              # 向量索引（运行中构建，实测 6.4 MB）
    diagnostics\
      logs\knowledge-kit.jsonl         # 结构化遥测流
      runs\<domain>\generate\<date>\<runId>\
        manifest.json
        events.jsonl                   # 运行级事件流
        attempts\0001\executions\
          NNNN-<domain>.<kind>.<stage>\
            execution.json             # 单次执行元数据
            events.jsonl               # 执行级事件流
```

`<repoKey>` 由项目目录名派生（`testing` → `knowledge-testing-<hash>`）。

后台守护进程日志：`C:\Users\i\.qoder-cn\logs\qoder-context.log`

### 实测元信息【实测】

```
write_package    @ali/qoder-knowledge-db
writer_version   0.6.0
schema_version   v1
ddl_digest       9dbd1c818caf59c407ed778b5db6cd62dd11d7d06503b705e5b2bc3510634fc6
owner_tag        D:\projects\testing
generator_version 0.5.0                # 注意：与 writer_version 独立演进
```

Agent 侧身份【实测】：

```json
{
  "adapter": "qoder-agent-sdk",
  "library": "@ali/qoder-agent-sdk-next",
  "libraryVersion": "1.0.30",
  "provider": "qoder",
  "configurationHash": "920b179afd8e36a77f76b5334aa210b70577a01318f2b6607371ddfa7d009ccd",
  "model": "auto"
}
```

> `generator_version` 管生成行为（提示词与流水线），`writer_version` 管库表结构。**两者独立演进**——库表变更与生成行为变更解耦。

---

## 3. 状态机与库表

`wiki.v1.db` 的表集合构成一个**可恢复的任务状态机**：

| 表 | 职责 | 关键字段 |
|---|---|---|
| `db_meta` | 库自述 | `ddl_digest`、`writer_version`、`owner_tag` |
| `partition` | 快照分区 | `branch`、`locale`、`baseline_commit`、`baseline_behavior_hash`、`published_snapshot_id` |
| `last_run` | **当前运行状态（单行）** | `state`、`stage`、`attempt`、`last_error`、`target_commit`、`behavior_hash`、`resume_hash`、`config_snapshot` |
| `run_lease` | 运行租约（防并发） | `lease_id`、`expires_at` |
| `run_control` | 外部控制通道 | `request`、`requested_by`、`ack_state`、`ack_reason` |
| `run_history` | 历史运行审计 | `state`、`stage`、`counters`、`failed_items`、`artifact_paths`、`reason_code` |
| `stage_output` | **阶段产出（交接件）** | `stage`、`item_id`、`payload = {disposition, output}` |
| `host_state` | 实时进度 | `name`、`payload.progress` |
| `host_config` | 实例配置 | `{language, autoUpdate, autoExport, citation}` |
| `section` | **Wiki 目录树 + 正文** | `parent_id`、`ordinal`、`title`、`content`、`meta` |

`cards.v1.db` 另有三张业务表：`module`（模块）、`card`（卡片）、`module_card`（挂载关系）、`relation`（关系）。

### 3.1 关键状态字段【实测】

`last_run`（**运行结束后的终态**，Wiki）：

```
state               completed
stage               completed
attempt             0
target_commit       a8acbd243f0495c8daa63d2ae5681c3bb77dae65
generator_version   0.5.0
behavior_hash       a7ddf42f2b8fdfdfbd8f1d7907f1e4f450a2b1f219583ff3c6e13ffd0ba9bc33
resume_hash         e13e46692c3ef67881c48dd57729bdb40972c6d0696adae6c2670bcfba44340e
started_at          2026-09-15T07:39:36.050Z
updated_at          2026-09-15T08:45:38.784Z      ← 历时 66 分 02 秒
```

`partition` —— **运行中 vs 结束后对比**（这张表验证了基线回填机制）：

| 字段 | 运行中 | 结束后 |
|---|---|---|
| `published_snapshot_id` | `""` | `a0f1ed37-8a4e-4974-890d-ebfe206ad167` |
| `baseline_commit` | `""` | `a8acbd243f0495c8daa63d2ae5681c3bb77dae65` |
| `baseline_run_id` | `""` | `120531aa-4ea3-4aa0-a4a8-0633aa6c55ec` |
| `baseline_behavior_hash` | `""` | `a7ddf42f2b8fdfdfbd8f1d7907f1e4f450a2b1f219583ff3c6e13ffd0ba9bc33` |
| `baseline_generator_version` | `""` | （未回填） |

> **结论（原为推断，现已实测）**：`baseline_*` 在**首次全量运行结束时回填**，取值即本次运行的 `snapshot_id` / `target_commit` / `run_id` / `behavior_hash`。下次增量运行以此为比较起点。
>
> 注意 `published_snapshot_id` 与 `last_run.snapshot_id` 相等 —— 说明"发布快照"就是本次运行的快照。
>
> **但 `baseline_generator_version` 未回填**，与其余三个字段不一致。原因【未知】，可能是该版本未实现，也可能只在特定条件下写。

另：`run_history.counters` 在**运行结束后仍为 `{}`**。该字段在本版本中未被使用。

`host_config`：

```json
{ "schemaVersion": 2, "language": "zh", "autoUpdate": true,
  "autoExport": true, "citation": true }
```

### 3.2 租约【实测】

运行中：

```
updated_at  2026-09-15T08:11:37.120Z
expires_at  2026-09-15T08:13:37.120Z
```

**TTL 恰好 120 秒**，随运行心跳续期。

运行结束后：`run_lease` **表为空** —— 租约已释放。生命周期确认为：`运行期间持租约（120s 心跳续期）→ 结束（无论成败）释放`。

---

## 4. 流水线一：full（全量）

由 `stage_output.stage` 与执行目录名共同确认，实际为 **5 个阶段**：

```
readme → overview → plan → catalogue → page
```

| # | 阶段 | 职责【实测产出】 | stage_output | 执行数 |
|---|---|---|---|---|
| 1 | `readme` | 产出全仓**文件清单/物料**（数字键大对象） | 1 | 1 |
| 2 | `overview` | 全局认知 | 1 | 1 |
| 3 | `plan` | 规划 | 1 | 1 |
| 4 | `catalogue` | **目录树 + 每页 prompt + 依赖文件** | 40 | 40 |
| 5 | `page` | 页面正文（并发 3） | **195** | **616** |

> `page` 的 `stage_output` 恰好 195 行 = `section` 总数，且 `item_id` 与 `section.id` **完全一一对应**。即：`stage_output` 是**逐条的终结台账**，每条 section 一行，记 `disposition`（`done` / `failed`）。
>
> `catalogue` 的 40 行则是**批次**（每次执行处理一批），与 section 非一一对应。

### 4.0 执行目录编号是全局连续的【实测】

```
0001 … 0658 共 658 个目录 = 1 + 1 + 1 + 40 + 616
```

编号跨阶段递增，**不是每阶段重新计数**。因此从目录名即可还原整条运行的全部执行序列。

> **616 个 page 执行 ≠ 195 × 2 次尝试**。实测 `maxAttempts: 2`，理论上限为 390。差异原因【未知】，推测与 `max_steps` 撞限后的 `priority_now_handoff` 有关——单次条目尝试可能派生多个执行单元（见 §10.3）。

**顺序有讲究**：`readme` 先于 `overview`——**先静态建立物料清单，再交由 agent 阅读**。对应配置 `material.listDirMaxTokens: 2000`。

### 4.1 执行单元落盘

每个执行单元产生一个带序号前缀的目录：

```
executions/0001-wiki.full.overview/
executions/0002-wiki.full.catalogue-plan/
executions/0003-wiki.full.catalogue/
...
executions/0043-wiki.full.page/
```

命名规则：`NNNN-<domain>.<kind>.<stage>`。`kind` 为 `full` 或（增量时的）其他值。

每个目录内含：

- `execution.json` — `{executionId, purpose, startedAt, finishedAt, status}`
- `events.jsonl` — 该执行的完整事件流

> 取证时仅存在 `attempts/0001/`，说明本次**未发生重试**。

---

## 5. 流水线二：incremental（增量）

从 `config_snapshot.engineConfig.incremental` 读出，是**独立的第二条流水线**，共 4 阶段：

```
commitAnalysis → catalogueAnalysis → pageUpdate → pageAdd
```

设计要点：**把页面工作拆成 `pageUpdate`（改写已有页）与 `pageAdd`（新增页）两类**。

这解决的是"代码变更后，只重算受影响的部分"——先用 commit 差异定位变更，再用 catalogue 分析把影响映射到目录节点，最后按 update/add 分流。

> 【推断】`commitAnalysis` 读 commit 差异、`catalogueAnalysis` 映射到目录节点——由阶段名与顺序推测，未观测到实际执行（本次为 full 模式）。

---

## 6. 阶段配置参数

全部来自 `last_run.config_snapshot`（明文 JSON）。**这是整份文档最有复用价值的部分。**

### 6.1 full

| 阶段 | session | material | execution | validation |
|---|---|---|---|---|
| `overview` | maxSteps 10<br>maxInputTokens 150000<br>maxOutputTokens 16000 | listDirMaxTokens 2000 | maxAttempts 2<br>retryDelayMs 5000 | minContentBytes 200 |
| `plan` | 同上 | 同上 | maxAttempts 2<br>retryDelayMs 5000 | — |
| `catalogue` | 同上 | 同上 | maxAttempts 2<br>retryDelayMs 5000<br>**concurrency 3** | minContentBytes 300<br>**maxDepth 4** |
| `page` | 同上 | 同上 | maxAttempts 2<br>retryDelayMs 3000<br>**concurrency 3** | minContentBytes 250 |

### 6.2 incremental

| 阶段 | execution | validation |
|---|---|---|
| `commitAnalysis` | maxAttempts 2, retryDelayMs 5000 | — |
| `catalogueAnalysis` | maxAttempts 2, retryDelayMs 5000 | — |
| `pageUpdate` | maxAttempts 2, **retryDelayMs 2000**, concurrency 3 | minContentBytes 250 |
| `pageAdd` | maxAttempts 2, **retryDelayMs 2000**, concurrency 3 | — |

session/material 各阶段一致，同 full。

### 6.3 观察

- **所有阶段的 `maxSteps` 都是 10** —— 硬上限，撞到即强制收尾（见 §10）
- `retryDelayMs` 分档：便宜阶段 5000ms，页面写入阶段 2000–3000ms
- 只有 `catalogue` 有 `maxDepth`（4，目录树深度上限）
- 只有产出正文的阶段有 `minContentBytes` 校验

---

## 7. 数据契约：catalogue → page 的接缝

**这是整条流水线的核心接口。** `section.meta` 在全部条目上结构完全一致：

```json
{
  "sectionName": "Python pytest适配器",
  "prompt": "创建Python pytest适配器的详细文档。详细说明如何解析pytest测试文件…",
  "dependentFiles": [
    "packages/adapters/src/python-pytest.ts",
    "packages/adapters/src/python-facts.ts"
  ]
}
```

**机制**：`catalogue` 阶段**先读代码**，然后为每一页：

1. 写出**高度具体的自然语言 prompt**
2. **圈定依赖文件**（静态绑定）

`page` 阶段只拿这几份文件 + prompt 生成正文，**不重读全仓**。

### 7.1 prompt 的具体程度【实测样例】

`python-pytest-adapter` 的 prompt 点名了真实函数与真实配置文件：

> …解释 `extractFunctions` 工具函数的使用，包括工厂调用识别（`isFactoryCall`）和 mock 调用检测（`isMockCall`）。…配置优先级处理（`pytest.ini`、`pyproject.toml`、`tox.ini`、`setup.cfg`）…

说明 catalogue 阶段确实读了代码，不是泛泛而谈。

### 7.2 依赖文件数量分布【实测】

```
1 个文件  25 页        2 个文件  18 页        3 个文件   4 页
4 个文件   6 页        5 个文件   1 页        6 个文件   1 页
```

**绝大多数页面只依赖 1–2 个文件。**

> 结论：Qoder 的上下文组织**不是 Top-K 检索**，而是**在目录规划阶段就把上下文静态切分好**。这与规划文档 §5 的多阶段检索路线是不同的解法。

### 7.3 可追溯性

`host_config.citation: true` 使每个 Wiki 页顶部生成 `<cite>` 块，列出引用的文件（带 `file://` 链接）：

```html
<cite>
**本文引用的文件**
- [python-pytest.ts](file://packages/adapters/src/python-pytest.ts)
- [python-pytest.test.mjs](file://packages/adapters/test/python-pytest.test.mjs)
</cite>
```

---

## 8. 版本与缓存失效

`config_snapshot` 顶层四个键【实测】：

| 键 | 取值【实测】 | 作用 |
|---|---|---|
| `aiConfigurationHash` | `bbca922cee889264…` | 模型配置指纹 |
| `behaviorInputs` | `{locale, repositoryName, authorPages, authorNotes}` | **行为哈希的输入** |
| `perRunInputs` | `{codingIntent: ""}` | 单次运行的额外意图 |
| `engineConfig` | `{schemaVersion:1, full, incremental}` | 全量阶段参数 |

具体值：

```json
behaviorInputs: {
  "locale": "zh-CN",
  "repositoryName": "D:\\projects\\testing",
  "authorPages": [],
  "authorNotes": []
}
```

**三个哈希的分工**：

| 哈希 | 含义 | 备注 |
|---|---|---|
| `behavior_hash` | 抽取器"行为"指纹 | 输入即 `behaviorInputs`（locale / 仓库名 / 作者提供的页面与笔记）【推断：哈希函数未验证】 |
| `resume_hash` | 断点续跑指纹 | 输入**【未知】** |
| `aiConfigurationHash` | 模型配置指纹 | 与 behavior 分离 |

> 设计价值：**抽取器行为变更 ⇒ 缓存自动失效**。`authorPages` / `authorNotes` 是注入自定义规划（相当于 `wiki_plan`）的入口。

---

## 9. 并发、租约、控制与进度

| 机制 | 实现 | 状态 |
|---|---|---|
| 并发生成 | 阶段级 `concurrency: 3` | 【实测】 |
| 防重入 | `run_lease`（TTL 120s 心跳续期） | 【实测】 |
| 外部控制 | `run_control`：`request` / `requested_by` / `ack_state` / `ack_reason` | 【实测表结构】；本次 **0 行，从未被使用** |
| 进度上报 | `host_state.payload.progress = {stage, plannedItemIds, completedItemIds[]}` | 【实测】 |

`host_state` 中的操作信封（供前端读进度）：

```json
{
  "name": "qoder-context.operation.v1",
  "payload": {
    "action": "generate", "state": "running",
    "runId": "120531aa-…", "errorCode": null, "retriable": false,
    "progress": { "stage": "page", "plannedItemIds": null,
                  "completedItemIds": ["0a24a66b-…", "0f76f2cb-…", …] }
  }
}
```

> 【推断】`run_control` 的语义（取消 / 提升优先级）由列名与 `ai.model.limit phase=priority_now_requested` 事件推测，**未实证**。
> 【实测缺失】`plannedItemIds` 恒为 `null`——只上报已完成项，不上报计划总数。

---

## 10. 事件流与可观测性

事件信封结构【实测】：

```json
{
  "schemaVersion": 1, "sequence": 2728, "time": "2026-09-15T08:11:20.425Z",
  "profile": "release", "type": "ai.model.wait", "level": "warn",
  "context": { "sessionId", "runId", "knowledgeRunId", "domain",
               "executionId", "operation", "itemId", "modelCallId", … },
  "data": { … },
  "sessionSequence": 2753
}
```

### 10.1 事件类型【实测】

```
ai.execution.started / ai.execution.completed
ai.model.requested / ai.model.step / ai.model.wait / ai.model.limit
ai.tool.called / ai.tool.completed / ai.tool.failed
ai.usage
```

### 10.2 单次执行的用量（`overview`，共 40 事件）

| 事件 | 次数 |
|---|---|
| `ai.tool.called` | 10 |
| `ai.tool.completed` | 9 |
| `ai.tool.failed` | 1 |
| `ai.model.limit` | 3 |
| `ai.model.wait` | 2 |

工具调用**全部是 `Read`**（10 次）——没有 grep/glob，发现能力由 `readme` 阶段的物料清单提供。

### 10.3 受限与计费事件【实测】

```json
{ "type": "ai.model.limit", "level": "warn",
  "data": { "purpose": "wiki.full.page", "phase": "reached",
            "reason": "max_steps", "workTurns": 10, "maxSteps": 10,
            "estimatedInputTokens": 55148, "inputTokenGuard": 150000 } }
```

三阶段序列：`reached` → `priority_now_requested` → `priority_now_handoff`，末次带：

```json
{ "phase": "priority_now_handoff", "terminalReason": "aborted_tools",
  "phaseCredits": 4.847835168, "phaseApiDurationMs": 21315,
  "phaseByModel": { "auto": { "credits": 4.847835168 } } }
```

另见 `ai.model.wait` 的 `status: "slow"`（阈值 `slowThresholdMs: 30000`）。

### 10.4 守护进程侧的 RPC 轨迹

`qoder-context.log` 中可读到：

```
knowledge.config.save      domain=wiki
knowledge.operation.start  domains=["wiki","card"]
knowledge.branch.resolve   targetBranch=master effectiveBranch=master
                           decision=blocked reason=target_in_progress
GET https://gateway.qoder.com.cn/algo/api/v2/service/wiki/queue
      ?id=…&type=full&currentWorkspaceCount=1
knowledge.lineup.acquired  lineUpId=fe9fd53d-…
```

> 【推断】存在**服务端排队（lineup）**机制，且分支解析会因"目标分支进行中"而 `blocked`。`domains` 表明 Wiki 与 Card 属于同一次 operation 的两个 domain。

---

## 11. 失败模式与实测约束

### 11.1 配额耗尽是主导失败模式【实测——本次真实结局】

运行终态虽是 `state=completed`，但 `run_history.failed_items` 记录了 **140 条失败**，全部属于 `stage = page`，且失败原因 **140/140 完全一致**：

```
Error: page: failed after 2 attempts: AI execution error: AiError:
  Qoder session ended with subtype=error_during_execution
  (error_code=118, errors=You've reached your credit usage limit.
   Please upgrade your subscription plan to get more resources. ...)
```

**根因：账户额度耗尽（`error_code=118`），不是技术故障。**

对账 `stage_output` 中 `stage = page` 的 195 行：

| disposition | 条数 | 含义 |
|---|---|---|
| `done` | 55 | 成功产出正文 |
| `failed` | 140 | 两次尝试后放弃 |
| **合计** | **195** | 每条 section 都有终结记录 |

**成功率 55/195 ≈ 28%。**

要点：

1. **`state=completed` 具有误导性** —— 它只表示"运行已终止"，不表示"产物完整"。判断完整性必须读 `failed_items` 与逐条 `disposition`。
2. `failed after 2 attempts` 说明**重试耗尽后才记失败**：140 × 2 = 280 次尝试被消耗。而额度类错误本质**不可重试**，此处仍重试了一次。
3. 时间分布：前约 11 分钟（15:39→15:50）完成 readme / overview / plan / catalogue；随后约 55 分钟产出 55 页（≈1 页/分钟）；其余时间消耗在失败重试上。
4. 失败是**批量同因**的 —— 额度耗尽后后续页面必然失败，继续调度纯属浪费。

> **对本项目的直接启示**：需要 (a) **成本/额度预检**；(b) **终止性错误的快速失败**（识别 `error_code=118` 这类不可重试错误并跳过重试）；(c) **部分成功的显式记账**（逐条落 `done/failed`，而非只看运行状态）。这三点在规划文档 §6 治理与 §9 验收中尚无对应设计。

### 11.2 单文件读取上限【实测】

```json
{ "type": "ai.tool.failed", "step": 5, "name": "Read",
  "operation": { "kind": "repository.read",
                 "attributes": { "path": "packages/core/src/engine.ts" } },
  "errorCode": "tool_error", "durationMs": 15,
  "errorExcerpt": "Error: File content (25066 tokens) exceeds maximum allowed
                   tokens (25000). Use offset and limit parameters to read" }
```

**Read 工具单文件上限 25000 tokens**，`packages/core/src/engine.ts` 为 25066 —— 仅超 66 个 token 即被拒。

**后果**：`overview` 阶段未能读到 core 主文件，**对 `packages/core` 的理解必然残缺**。这直接解释了为什么 Wiki 在 core 相关页面上质量偏弱。

> **对本项目的直接启示**：单文件 token 上限是硬约束，超限文件必须拆分或分片读取，否则核心模块会被系统性漏掉。

### 11.3 其他约束汇总

| 约束 | 值 |
|---|---|
| 单文件 Read 上限 | 25000 tokens |
| 每阶段步数上限 | `maxSteps: 10`（撞限即强制收尾） |
| 输入 token 护栏 | `inputTokenGuard: 150000` |
| 单次执行尝试次数 | `maxAttempts: 2` |
| 目录深度上限 | `maxDepth: 4` |

### 11.4 产出质量：目录冗余【实测】

运行结束后的稳定值：

```
section 总数 195，不同标题 174  →  21 组标题重复
```

（例：`core-engine`、`rest-api`、`adapter-interface`、`python-pytest-adapter` 等均出现多次。）

> 去重逻辑的缺失是可见缺陷：同一主题会生成多页。**该冗余在运行期与结束后一致（同为 21 组）**，属结构性缺陷而非临时状态。

---

## 12. 信息架构（实测）

Wiki 顶层为 14 个 section：

```
project-overview          getting-started           architecture(6)
core-engine(4)            data-models(6)            adapters(5)
api-reference(3)          web-interface(5)          llm-integration(5)
evaluation-system(5)      deployment-operations(7)  development-guide
extension-development(5)  best-practices
```

括号内为子节点数；无括号表示叶子。

**这是一份标准"代码文档"信息架构**——按软件结构组织，而非按测试决策维度组织。

### 12.1 卡片侧的分类体系

`cards.v1.db` 中 11 张卡的类型：

```
overview            tech_stack          architecture_design
coding_conventions  dependency_management  build_system
configuration_system  error_handling    logging_system
frontend_style      unique_setup_and_commands
```

均为**工程维度**。对照 `packages/model/src/schemas.ts` 中本项目自己的定义：

```ts
KnowledgeKindSchema   = fixture, mock, boundary, assertion,
                        behavior, execution_recipe, historical_bug, environment
KnowledgeStatusSchema = candidate, reviewed, verified, rejected, stale
```

> **两组分类正交**：Qoder 回答"代码怎么组织"，TestKnowledge 回答"这个模块应该怎样测"。
>
> 值得注意的是：Qoder 的 Wiki **准确复现**了本项目 schema 中的 8 种知识类型与 5 种状态（见 `knowledge-card-entity` 页的 prompt），说明其**内容忠实度高**——限制在分类体系与覆盖范围，不在准确性。

### 12.2 卡片侧的覆盖度缺陷【实测】

```
module        1 行     ← 仅"TestKnowledge 工作区根配置"（仓库根）
card         11 行     ← 其中 5 张同标题，仅 card_type 不同
module_card   5 行
relation      0 行     ← 关系层为空
```

**Card 侧是完整成功的**：`cards` 的 `run_history` 为 `state=completed`、`failed_items=[]`、`finished_at=07:44:23Z`（开始于 07:39:34，耗时约 5 分钟）。

> 注意 Wiki 与 Card 是**同一次 operation 下的两个 domain，各有独立的 `run_history` 与失败结局**（见日志 `knowledge.operation.start domains=["wiki","card"]`）。本次 Card 全成、Wiki 大败 —— 粒度隔离生效，一方失败未污染另一方。

`apps/{api,cli,mcp,web}` 与 `packages/{model,core,adapters}` 共 7 个包**均未被建模为模块**。卡片无 `evidence_refs` / `confidence` / `applicability` / `lifecycle_state`（`card.meta` 全为空）。

---

## 13. 对本项目的借鉴清单

### 13.1 强烈建议借鉴

| # | 机制 | 理由 | 对应规划章节 |
|---|---|---|---|
| 1 | **catalogue 阶段静态绑定依赖文件** | 比 Top-K 更省 token、更可控；实测绝大多数页仅需 1–2 文件 | §5 上下文编译 |
| 2 | **`pageUpdate` / `pageAdd` 拆分** | 为"变更后只重算受影响部分"提供了具体粒度 | §6 生命周期治理 |
| 3 | **`behavior_hash` + `baseline_*` 回填** | 抽取器行为变更即整体失效，是版本治理的硬机制 | §3.2、§6 |
| 4 | **阶段配置外置化**（`config_snapshot` 落库） | 参数可审计、可回溯、可复现 | §9 验收标准（固定模型与预算） |
| 5 | **`run_lease` + `run_history` + `stage_output` + `host_state`** | 现成的可恢复任务状态机；当前 `.testknowledge/` 只有 jsonl，无运行态 | §6 |
| 6 | **执行单元落盘**（`executions/NNNN-<stage>/`） | 便于失败定位与断点续跑 | §6 |
| 7 | **逐条终结台账**（`stage_output` 每 section 一行 `done/failed`） | 运行状态不能代表产物完整；必须逐条记账（§11.1 实证） | §6、§9 |
| 8 | **domain 级隔离**（Wiki 与 Card 各自 `run_history`） | 一方失败不污染另一方（本次 Card 全成、Wiki 140 条失败） | §6 |

### 13.2 建议改造后采用

| 机制 | 改造方向 |
|---|---|
| 固定 card taxonomy | 换成测试维度（`KnowledgeKindSchema` 已是正确方向） |
| 文档式信息架构 | 换成测试资产结构：目标符号 / 等价类 / 准备方式 / Oracle / 历史缺陷 |
| `<cite>` 引用块 | 升级为带 `evidence_refs` + `confidence` 的完整证据链 |
| 阶段名（overview/catalogue/page） | 保留编排骨架，阶段语义改为抽取域 |

### 13.3 明确不应照搬

- **卡片无证据链**——与规划 §10"不把模型输出直接当成事实"直接冲突
- **单一 module 覆盖**——模块发现能力不足，需替换为语言无关的模块划分
- **无去重**——需要显式的 section 去重/合并
- **单文件 25000 token 硬上限**——应在自己的适配器中处理超长文件分片，而非静默跳过
- **用运行状态代替完整性判断**——本次 `state=completed` 却丢了 140/195 页（§11.1）。必须逐条记账，不能让聚合状态掩盖部分失败
- **对终止性错误一律重试**——额度耗尽（`error_code=118`）不可重试，仍被重试一次，白烧 140 次尝试。需按错误类型分流

---

## 14. 复现方法

读取 Wiki 库（生成中亦可，需 `readOnly`）：

```bash
cd /d/projects/testing && node -e '
const { DatabaseSync } = require("node:sqlite");
const db = new DatabaseSync(
  "C:/Users/i/.qoder-cn/qoder-knowledge/knowledge-testing-e15d27a8f4de1e8a/wiki/wiki.v1.db",
  { readOnly: true });
// 运行状态
console.log(db.prepare("SELECT state, stage, attempt, target_commit FROM last_run").get());
// 完整引擎配置
const cs = JSON.parse(db.prepare("SELECT config_snapshot FROM last_run").get().config_snapshot);
console.log(JSON.stringify(cs.engineConfig, null, 1));
// 各阶段产出计数
console.log(db.prepare("SELECT stage, COUNT(*) n FROM stage_output GROUP BY stage").all());
// 目录树与正文进度
console.log(db.prepare("SELECT COUNT(*) total, SUM(length(content)>0) done FROM section").get());
'
```

> Node 24+ 内置 `node:sqlite` 即可，无需额外依赖。注意：`prepare()` 中的 SQL 字符串字面量需用**单引号**，在 bash 单引号包裹的 `node -e` 内可用 `String.fromCharCode(39)` 绕过。
>
> 所有数字与状态均为快照，会随生成推进而变化。

---

## 15. 未解问题

| 问题 | 状态 |
|---|---|
| `resume_hash` 的输入与算法 | 【未知】 |
| `behavior_hash` 的哈希函数与粒度 | 【未知】仅已知其输入为 `behaviorInputs` |
| `run_control` 的请求语义与生效路径 | 【推断】未观测到实际使用（0 行） |
| 服务端 lineup 队列的调度策略 | 【未知】仅见 RPC 路径 |
| `incremental` 流水线的实际执行行为 | 【未知】本次为 full 模式 |
| `vectors/` 的用途 | **【已解】** 运行中构建，实测 6.4 MB；但**切分与嵌入策略未观测** |
| `readme` 阶段产出的物料清单规模 | 【部分】为数字键大对象，规模未测 |
| 616 个 page 执行与 195 条目的映射关系 | **【新增·未知】** 超出 `maxAttempts: 2` 的理论上限 390，疑与 `max_steps` 交接有关 |
| `baseline_generator_version` 为何未随其余基线字段回填 | **【新增·未知】** 可能是该版本未实现 |
| `state=completed` 在存在 140 条 `failed_items` 时仍置位的语义 | **【新增·推断】** 意为"运行终止"而非"产物完整"；需以 `failed_items` 为准 |
