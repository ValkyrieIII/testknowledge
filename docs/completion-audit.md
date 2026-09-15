# 建设规划完成度审计

本审计逐项对应 `测试抽取知识库建设规划.md`，以当前工作区代码和本地 QQBot 试点数据为准。
它区分“工程入口已经实现”“静态试点已有证据”和“必须通过外部执行或人工判断才能证明”，不把
lint、类型检查或编译通过当成功能正确性证明。

## 第一版完成定义

| 规划要求 | 当前证据 | 结论 |
| --- | --- | --- |
| 定位目标代码和影响范围 | `StructuralContextProvider` 接入 CodeGraph；Context Pack 返回目标来源、相关路径与 abstention | 工程链路已实现；QQBot `try_record` 查询已得到目标与影响上下文 |
| 找到现有测试、fixture、factory 和运行方式 | Python AST 抽取测试、fixture、显式 Factory、mock、断言与 marker；项目地图和 Context Pack 返回现有测试及带来源的未验证命令 | 静态链路已实现；命令未被冒充为已执行 |
| 返回带证据的边界、风险、Oracle 和历史缺陷 | KnowledgeCard 强制 Evidence 引用，Git/Issue/测试代码分别进入证据层 | 工程链路已实现；QQBot 有 14 张当前候选卡待人工审核 |
| 区分 verified、candidate、stale | 生命周期、证据变更失效、人工审核、执行验证、冲突、合并、回滚和 Oracle 反证均有独立入口与审计 | 已实现；当前 QQBot 为 45 candidate、38 stale、0 verified |
| 无可靠知识时安全回退 | 默认只消费 reviewed/verified，冲突和不适用卡被过滤，无可用知识返回 `ordinary_agent` 与 abstention | QQBot 静态查询已有回退证据 |
| C 的行为质量优于仅代码上下文 B | v2 已冻结同模型、完整提示、逐变体工具、预算、任务和评分条件；`runSetId` 防止跨批次拼接 | **未证明**：没有获授权的隔离执行、预埋缺陷和逐项观察 |

## 分阶段交付

- 阶段一：Python/pytest、BM25F、Context Pack、CLI/HTTP、证据和生命周期均已实现；14 张当前人工包卡片
  已导入但仍待真实人工审核。行为增益目标未完成。
- 阶段二：AST/配置规则已覆盖测试函数、fixture、显式 Factory、mock、断言、marker、命令，以及
  `COVERS`、`USES_FIXTURE` 和统一 Evidence；没有执行测试来验证抽取后的运行效果。
- 阶段三：CodeGraph 影响分析、Git 历史、回归关联、多路径检索、冲突和适用性过滤已实现。
- 阶段四：可选 LLM 候选、EvidenceCluster 双层审核、人工审核/合并/拒绝/回滚、变更失效、执行结果回写
  和安全回退已实现。当前没有配置 LLM 凭据，语义抽取未做真实端点验证；人工审核仍待用户完成。
- 稳定 ID 使用显式语义字段投影；无关 Schema 默认字段不再隐式轮换知识身份。首次加入 Factory 事实形成的
  旧身份继续作为 stale 审计历史保留。
- 阶段五：MCP、CLI、HTTP 和 Web 出口，以及 Codex、Claude Code、Copilot 配置已提供；Java/JUnit、
  Go testing、Rust test 为可替换的保守静态适配器。多语言运行效果没有执行证据，不作为第一版完成声明。
- API、CLI、MCP 通过共享 composition root 装配同一套 repository、索引、来源适配器、抽取器、CodeGraph
  和 Git provider；新增或替换能力不需要在三个入口分别修改。

## 评测完整性边界

- 当前 QQBot v2 计划：`eval_70ee29035965b03d248555f3`，固定模型 `gpt-5.5`，4 个任务。
- `promptHash` 覆盖模板和全部实际任务提示；`toolPolicyHash` 覆盖三个变体各自的白名单。
- 每个 `runSetId × task × variant` 产生确定性 `runId` 和 `runSpecHash`。
- 清单只允许把 `agentInput` 传给被评 Agent；`scoring` 必须由隔离评估器保管。
- Feedback、execution Evidence、observation 和 report 都绑定同一 run set；多个批次不会拼成一组。
- 模型、提示词哈希、工具策略、实际工具集合、Token、工具调用和耗时同时进入 execution Evidence；
  observation 必须逐项匹配，不能只凭运行 ID 自报另一组条件或成本。
- 每个任务冻结重复与脆弱测试的私有评分口径；报告分别比较无效断言、重复和脆弱测试，三项增加都会阻止
  `improved` 结论，三项减少都可构成行为质量改善的一部分。
- 每个确定性 `runId` 只允许一条不可变观察；相同提交幂等，修改必须进入新 run set，不能事后覆盖同一运行。
- 当前 observation 数量为 0，因此报告只能是 `insufficient_data`。

## 当前必须由用户参与的门槛

1. 用真实治理人身份逐张核对 14 张当前 QQBot 候选卡的 Evidence、适用范围与 Oracle，并决定
   `reviewed` 或 `rejected`。Web 默认“当前 Agent 待审”队列已排除旧 stale 身份和规则候选，系统和
   Agent 不代替这项判断。
2. 明确授权是否可以在隔离工作区创建或修改测试资源、设计预埋缺陷并执行 A/B/C。未经授权，项目规则
   禁止这些动作，`seededBugIds` 必须保持为空。
3. 外部执行后由评估者依据私有 `scoring` 记录边界、缺陷、Oracle、fixture/mock、无效断言、重复/脆弱测试和成本；只有
   同批次 A/B/C 完整且 C 相对 B 达到冻结阈值，第一版第 6 项才能判定完成。

在以上证据出现前，准确状态是：**工程闭环已实现，候选治理与行为增益待证明**。
