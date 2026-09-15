# QQBot 阶段一试点

## 目的

该试点用于推进建设规划中的“10～20 张高价值测试知识卡”和真实查询闭环。目标仓库为
`D:\projects\qqbot`；TestKnowledge 只读取该仓库，所有运行数据保存在本项目的 `.testknowledge/`。

本次没有创建、修改或运行目标仓库测试，也没有把静态检查当成功能正确性证明。

## 冻结快照

- 试点仓库修订：`d3c3af603373a220dc8e2bc51dd7eba51cb9212f6ad498fff17db57947dc433d`
- 检测语言与框架：Python、pytest
- 扫描来源：52 个文件、1 个测试目录、1 个 pytest 配置、6 个环境文件
- 当前抽取结果：260 条 Evidence、31 张有效规则候选卡、69 条重建后关系
- 人工知识包：14 张 Evidence 绑定候选卡，作为一个操作导入
- 当前权威状态：90 张卡、105 条关系；其中 45 张为 `candidate`、45 张为 `stale`
- 当前人工包：14 张 Agent 起草、人工待审的卡全部为 `candidate`；适配器演进前的 14 张旧身份保留为
  `stale` 审计历史，不进入默认上下文，也不应再次审核

旧身份来自首次把 `factories` 纳入观察事实模型时的显式身份迁移。当前身份计算已经改为固定字段投影；
以后新增无关 Schema 默认字段不会再次制造整批伪身份变化。

知识包位于 `examples/qqbot-pilot-knowledge.json`。它聚焦生产凭据、测试环境隔离、隐私最小化、时间与
百分位边界、状态退役、迁移幂等、依赖独立降级、指标聚合 Oracle、非阻塞队列、停机排空和写入失败隔离。

## 查询证据

任务“为 `EventRecorder.try_record` 补测试，覆盖队列满时的行为”使用目标符号 `try_record`：

- 默认不包含候选时返回 `ordinary_agent`，原因为 `no_applicable_reviewed_or_verified_knowledge`；
- 显式包含候选时返回 `evidence_augmented`；
- 人工卡“观测入队在过载时必须立即丢弃而不等待”通过 `exact + bm25f` 命中，精确字段为
  `symbol + targetSymbols`，分数 2.20，高于规则候选。

这个结果证明了静态抽取、知识包导入、审计、精确召回和安全回退链路已经连通，但没有证明知识能提高
生成测试的行为质量。

## 已冻结评估计划

- 当前协议：`evaluation.v2`
- 当前计划 ID：`eval_70ee29035965b03d248555f3`
- 提示词策略哈希：`07ef650b929cf24a36a2e5e0c087308215ba6cf1f1d1234e9acd278c9cb5f93c`
- 固定模型：`gpt-5.5`
- 任务：队列过载、就绪依赖隔离、迁移幂等、观测隐私，共 4 项
- 单任务预算：12,000 Tokens、30 次工具调用、900 秒
- A：普通读取、搜索、编辑与隔离执行工具
- B：A + `codegraph_explore`
- C：B + `get_test_context`
- 工具策略哈希：`c69f3faa87ae3da37bd821d9911d3ca3c99cd09ffffa71c6b1c4de4ac21baaf7`

计划源文件为 `examples/qqbot-evaluation-plan.json`。三组白名单分别冻结并共同参与哈希，避免把所有变体
实际拿到相同工具后仍宣称完成了归因比较。v2 提示词哈希同时覆盖模板与 4 项实际任务提示；以
`qqbot-pilot-01` 展开后得到 12 项唯一运行规格，每项都有不同的 `runId` 和 `runSpecHash`。清单把被评
Agent 可见的模型、完整提示、工具、预算和目标范围封装在 `agentInput`，把边界、缺陷、Oracle 与
fixture/mock 评分答案保留在同级 `scoring`，隔离执行器不得把后者传给被评 Agent。
四项任务还分别冻结了 `duplicateCriteria` 与 `brittlenessCriteria`，最终报告单独统计无效断言、重复测试
和脆弱测试，不再遗漏建设规划中的低质测试指标。
反馈、执行 Evidence 和逐项观察还必须绑定 `runSetId=qqbot-pilot-01`；最终报告只比较该批次内部的
A/B/C，不能与以后重跑产生的其他批次混合。

旧计划 `eval_6810f9989cd3f2da43d36aef` 按 `evaluation.v1` 保留为历史快照；它没有逐运行规格完整性绑定，
不能继续接收观察。计划 `eval_431edb4798f6eea22bbfe994` 是加入低质测试评分口径前的 v2 快照，也不作为
当前试点结果来源。当前没有注入缺陷，`seededBugIds` 明确为空；在用户授权创建
测试/评估资源前，不把假想 mutation 当成已存在的缺陷证据。

## 试点发现并修复的问题

1. CI 环境卡曾把独立扫描的命令列表和工作目录列表错误拼成伪配对。现在卡片生成器优先逐条读取
   `runInstructions`；`python -m pytest -q` 不再被标成从 `frontend` 执行。重建后旧错误卡保留为
   `stale` 审计历史，新卡只保留证据中真实存在的命令—目录关系。
2. 工作区脚本会改变 Node 进程目录，导致 CLI、API、MCP 和相对输入文件指向不同位置。现在统一以调用
   工作区（`INIT_CWD`，直接启动时回退 `cwd`）解析数据、仓库和输入路径。
3. 适用范围曾要求请求同时提供目标符号和变更文件，缺一就排除知识。现在只对请求实际提供的维度执行
   冲突过滤，未知维度保留为 abstention。
4. SQLite 精确索引曾只保存主 `symbol`。现在额外索引 `targetSymbols` 与 applicability symbols。
5. 根目录中符合 pytest `python_files` 规则的文件曾被标为生产代码；扫描器现按项目 pytest 配置进行
   二次分类。
6. 评测报告曾可能从不同运行批次各取最新 A/B/C 观察。现在 `runSetId` 参与确定性运行身份、Evidence
   绑定与报告筛选；多个批次必须显式选择，不能拼接比较。
7. Python 测试结构中 Factory 曾只表现为普通调用。现在显式 `*Factory`、`*_factory` 及其
   `build/create` 形式会作为独立事实进入 Evidence、知识卡和 Context Pack；QQBot 当前静态证据识别出
   两处生产依赖 `session_factory`，未在测试函数中发现可形成知识卡的 Factory 调用。

## 尚未完成的证明

- 14 张卡已纠正为 `proposalProvenance.source=agent`，但尚未由用户逐张核对证据并审核，因此不能进入默认 Context Pack。
- 没有同修订的隔离执行 Evidence，任何卡都不能标为 `verified`。
- A/B/C 计划已冻结但尚未执行；不能声称 C 相比 B 提升缺陷发现、有效断言、边界覆盖或成本表现。

## 需要用户参与后才能继续

1. 在 Web 知识区使用默认“当前 Agent 待审”视图，它只显示当前 14 张 Agent `candidate`，不会混入
   stale 历史；填写真实治理人和本次审核说明，逐张展开来源证据。只把表达、适用范围和 Oracle 均与
   证据一致的卡片审核为 `reviewed`，其余拒绝。系统不会代替用户完成这项判断。
2. 明确授权在隔离工作区创建或修改测试资源并执行测试，再确认预埋缺陷方案。当前项目规则禁止未经授权创建、修改或运行测试，因此评估计划的 `seededBugIds` 保持为空，A/B/C 观察也保持未记录。
3. 如需把通过人工审核的卡提升到 `verified`，由外部隔离 runner/CI 回写同仓库、同修订、显式绑定卡片的成功执行 Evidence，再单独人工确认验证；普通通过不会自动晋级。

以上参与完成前，第一版定义中的“行为质量优于仅代码上下文”仍未获得执行证据，项目状态应保持“工程闭环已实现，行为增益待证明”。
- 当前试点只验证 Python/pytest 的真实仓库链路；Java、Go、Rust 仍只有静态适配器和编译检查。
