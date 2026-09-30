# TestKnowledge

面向 Coding Agent 的测试知识引擎。它把测试代码和项目文档中的可追踪事实整理成知识卡，在 Agent 编写测试前提供项目特有的 fixture、mock、边界、断言和历史缺陷信息。

## 当前首版

- TypeScript monorepo：Vue 3、Fastify、CLI 和核心领域模型共享类型。
- Source Adapter：Python/pytest AST（含保守的显式 Factory 识别），以及 Java/JUnit、Go testing、Rust test 的保守词法适配；另支持 Markdown 文档和显式外部快照。
- 抽取：确定性 Evidence + 可选 OpenAI-compatible LLM candidate。
- 检索：范围过滤、符号/路径精确召回、BM25F；向量检索暂不默认启用。
- 存储：JSONL 是权威数据，SQLite FTS5 是可重建索引。
- 状态：`candidate`、`reviewed`、`verified`、`rejected`、`stale`；人工审核只能进入 `reviewed`，不能冒充执行验证。进入 `reviewed` 前，卡片及其全部支撑 Evidence 必须属于当前项目修订；`rejected` 必须重写为新候选，不能原地恢复。
- 证据：记录来源、版本、抽取器、抽取时间、原文与置信度。
- Context Pack：结构化返回现有测试、fixture/mock、Oracle、历史回归、运行指令、证据置信度与 `abstentions`。
- 测试手法：15 项稳定枚举；规则只标注可确定识别的手法，LLM 不能自由创建标签。
- 语义候选校验：目标符号、适用路径、依赖和显式代码/错误码锚点必须能在引用证据中找到。
- 消费入口：CLI、HTTP、Web 和本地 stdio MCP，共享同一个核心引擎。
- 组合入口：API、CLI、MCP 统一调用 `createDefaultEngine`；repository、索引、来源适配器、抽取器、
  CodeGraph 和项目证据 provider 均可替换，不在三个协议入口重复硬编码。

查询会通过可替换的 `StructuralContextProvider` 调用本机 CodeGraph JSON 接口，组合任务上下文、
变更文件影响测试和目标符号影响范围。目标仓库没有 `.codegraph/`、索引不可用或调用失败时，
Context Pack 会明确返回 abstention，不会把文本相关性冒充调用链影响分析。
历史回归或运行指令没有来源证据时也会分别声明缺失。

关系层当前确定性生成 `SUPPORTED_BY`、唯一 fixture 匹配的 `USES_FIXTURE`，以及显式扫描生产代码时
唯一符号匹配的 `COVERS`；CodeGraph 查询会补充任务期的 `IMPACTS`。`VERIFIES` 不由调用或覆盖关系推断。
完整关系可通过 `GET /api/relations` 读取，并在 Web 关系视图中按当前仓库核对两端节点、来源证据、
抽取来源、置信度和冲突决议。

Git 历史适配器读取最近 100 条提交，只把提交说明中带明确修复/回归信号的记录作为 `bug_history`。
修复提交确实改动当前测试文件时才建立 `REGRESSION_OF`；提交文本始终按外部证据数据处理。

`runInstructions` 每项包含命令、来源、可选工作目录、置信度和 `verified`。从配置静态提取的命令始终
是 `verified: false`；只有回写的成功执行记录才可标为已验证。

外部隔离 runner 或 CI 可通过 `POST /api/feedback` 回写 `execution_result`。普通反馈本身不会改变知识状态；
只有已处于 `reviewed` 的卡片经 `POST /api/knowledge/:id/verify` 显式引用同仓库、同修订且结果为 `passed` 的执行证据，才会把卡片标记为
`verified` 并建立 `VERIFIED_BY`。若执行方在失败反馈中显式提交带评估人和说明的
`oracleAssessment.verdict: "contradicted"`，关联的 `reviewed`/`verified` 卡会降为 `stale`，建立
`INVALIDATED_BY` 并写入变更审计；系统不会从失败日志猜测 Oracle 已失效。本项目不会因接收反馈而自行执行目标仓库代码。

人工整理的高价值卡可通过 `POST /api/knowledge` 录入，但必须引用同仓库已有 Evidence，且只能以
`candidate` 开始。`POST /api/conflicts` 可记录两张卡的显式冲突；存在 `CONFLICTS_WITH` 的卡默认
从 Context Pack 排除，并返回 `conflicting_knowledge_excluded`，等待人工解决而不是任意选一条。
通过治理入口录入的卡会标记为 `origin: manual`，这只表示录入方式，不代表由人起草；
`proposalProvenance` 另行记录候选来自确定性规则、LLM、人或 Agent，以及实际起草者和说明。仓库重建时，只要它引用的证据仍在当前抽取结果中，就保留原状态，
证据消失或变化后才转为 `stale`。

对应 CLI 命令为 `add-knowledge`、`import-knowledge`、`merge-knowledge`、`history`、`rollback`、`record-conflict`、`record-feedback` 和 `verify`，写操作均通过
`--input <json>` 读取结构化输入，避免把完整证据和审核说明塞进命令行参数。JSON 内的相对仓库路径与
`--repo` 一样按调用工作区解析；核心层再统一标准化，因此 CLI、HTTP 与 MCP 不会为同一路径生成不同仓库身份。

阶段一的 10～20 张人工精选卡可用一个知识包导入，而不必逐张写入。`import-knowledge`、
`POST /api/knowledge/import` 与 MCP `import_test_knowledge_pack` 共用同一约束：一个知识包只对应一个仓库
修订，最多 100 张卡；先校验整包 Evidence 引用和重复身份，再执行一次仓库存储更新。所有卡仍从
`candidate` 开始，并共享一次可回滚的审计操作。包内 `cards` 使用单卡字段，但省略重复的 `repo` 和
`revision` 和逐卡重复的 `proposalProvenance`；顶层另带候选起草溯源、执行导入的 `reviewer` 与 `note`。
导入动作不等于人工审核，所有卡仍保持 `candidate`。单卡或整包重写已有身份时，会清除旧执行验证和旧支撑关系。
仓库内 [QQBot 试点知识包](examples/qqbot-pilot-knowledge.json) 提供 14 张真实 Evidence 绑定的候选卡，
试点过程与当前证据边界见 [QQBot 阶段一试点](docs/pilot-qqbot.md)。

`POST /api/knowledge/merge` 会把两张以上同仓库、同版本的有效卡片合并为一张新卡。新卡必须保留全部
来源 Evidence，并重新从 `candidate` 开始；来源卡转为 `rejected`，同时建立 `MERGED_FROM` 关系。
每次构建、录入、审核、验证、反馈失效、合并、冲突决议和分组拒绝都把变更前后快照写入
`knowledge-changes.jsonl`。可通过 `GET /api/knowledge-changes` 或 CLI `history` 查看；
`POST /api/knowledge/:id/rollback` / CLI `rollback` 按 `operationId` 整组恢复。回滚只接受仍属于当前仓库
版本的 Evidence，恢复卡会清空执行验证并降为 `candidate`，不会继承旧的 `verified`。

冲突可通过 `POST /api/conflicts/:id/resolve` 或 `resolve-conflict` 明确决议。支持保留任一侧、双方拒绝
或仅解除冲突；关系记录不会删除，而会保存决议人、说明和解决时间。

关系层严格区分四个概念：`COVERS` 只表示测试执行路径涉及代码对象；`VERIFIES` 仅在测试证据中直接
观察到断言或期望异常时，连接该测试与知识卡；`VERIFIED_BY` 只连接人工确认过的成功执行证据；
`INVALIDATED_BY` 连接显式判定 Oracle 已被反例推翻的失败执行证据。
生成 `VERIFIES` 不会自动把知识卡状态提升为 `verified`。

语义候选抽取默认关闭。配置 `TESTKNOWLEDGE_LLM_BASE_URL`、`TESTKNOWLEDGE_LLM_API_KEY`、
`TESTKNOWLEDGE_LLM_MODEL` 后，API 请求使用 `useLlm: true` 或 CLI `build --llm` 才会启用。
模型只看到截断的确定性证据，必须引用 Evidence ID；输出仍为 `candidate`，失败会回退规则抽取。
同一抽取器版本、端点、模型、生成参数和证据消息使用内容哈希缓存；缓存不包含 API Key，且只有可解析的
JSON 响应才写入 `.testknowledge/llm-cache/`。证据或模型配置变化会自然产生新键，不覆盖旧响应。

这三项配置也会持久化到 `.testknowledge/settings.json`（首次写入时权限为 0600），环境变量优先于文件，
因此一次性实验仍可用环境变量覆盖。`GET /api/settings` 只回显端点和模型，以及是否已保存 Key；
`PATCH /api/settings` 写文件，省略的字段保留原值，`apiKey: ""` 表示清除。配置在每次请求时读取，
保存后下一次构建即生效，不需要重启进程。文件缺失或格式损坏时按未配置处理，不影响服务启动。

Context 请求包含 `languages`、`frameworks`、可选版本、目标符号和变更文件。调用方未指定语言和框架时，
优先使用当前项目地图的检测结果；没有项目地图时才回退 Python/pytest。
核心编译器会再次执行 applicability 硬过滤；请求显式提供的目标符号或路径若与卡片冲突，该卡不会注入。
请求未提供的范围视为未知并记录 abstention，不会仅因缺少该维度排除其他精确命中的知识。
当调用方只在任务文本中给出函数或类名时，CodeGraph 适配器会从 context 入口点中选择任务里明确出现的
标识符作为目标，再用于影响分析、检索和适用性过滤；不会把所有模糊相关符号自动当成目标。
`impactSummary.targetSymbolSource` 明确记录目标来自请求、CodeGraph 推断或仍未识别。

## 身份与版本

知识卡与证据的 ID 只由自身内容决定：卡片取 `repo + 语义字段`（明确排除 applicability 中的 revision），证据取 `repo + 路径 + 符号 + 位置 + 内容哈希`。项目级 `revision` 仅作为溯源元数据记录，不参与卡片身份计算。因此改动无关文件或只移动行号不会使已审核的卡片失效；支撑证据、唯一匹配的目标函数、mock 目标、fixture 或 pytest 环境配置内容变化时，已审核/已验证卡会转为 `stale` 并清空执行验证，构建结果返回 `knowledge:invalidated_by_evidence_change:<数量>`。
卡片身份使用显式字段投影，而不是直接序列化整个可扩展 Schema；以后新增展示字段或无关默认值不会
自动轮换全部 ID。新增真正参与语义判断的字段时，必须明确更新身份投影并按可审计迁移处理。

> 从旧版本升级后历史 ID 会变化，需要重新执行一次 `build`。

## 运行

```powershell
pnpm install
pnpm build
pnpm --filter @testknowledge/cli start -- init
pnpm --filter @testknowledge/api start
pnpm --filter @testknowledge/web dev
pnpm --filter @testknowledge/mcp start
```

API 默认监听 `http://127.0.0.1:4173`，前端开发服务器默认监听 `http://127.0.0.1:5173`。
MCP 使用 stdio；默认数据目录是调用工作区下的 `.testknowledge`，也可用
`TESTKNOWLEDGE_DATA_ROOT` 指定。Agent 应优先调用 `get_test_context`，其余知识、证据、关系、反馈和
治理工具用于检查或维护。仓库内 `.codex/config.toml` 已为受信任的 Codex 项目注册该服务；重新打开
项目后即可加载，写操作会请求确认。配置使用相对路径，因此可随仓库和 worktree 一起迁移。

Claude Code 与 Copilot CLI 共用仓库级 `.mcp.json`，VS Code Copilot 使用 `.vscode/mcp.json`；它们与
Codex 消费同一套 MCP 工具和 Context Pack。接入方式、调用顺序及 Copilot 云端边界见
[Agent 接入](docs/agent-integration.md)。

启用 LLM 构建后，分组提议会独立写入 `clusters.jsonl`。先通过 Web、CLI `review-cluster` 或 MCP
`review_test_evidence_cluster` 审核分组，再审核对应知识卡；确认分组不会自动确认卡片，拒绝分组会
同时拒绝由它生成的卡片。
Web 知识区默认显示“当前 Agent 待审”，只包含当前身份为 `candidate` 且来源为 Agent 的卡片；也可切换
到全部候选、已审核/已验证、stale 历史或全部视图，避免重建留下的历史身份干扰本轮治理。

每次仓库扫描还会更新一份按仓库稳定寻址的测试项目地图，汇总生产/测试文件、测试目录、配置、环境
来源、生产与测试符号、fixture 以及有证据的运行指令。它通过 Context Pack 的 `projectMap`、Web、
`GET /api/project-maps`、CLI `list-project-maps` 和 MCP `list_test_project_maps` 共享；没有匹配知识卡时，
项目级运行方式仍可进入上下文，但不会被标为已验证。

## 数据目录

```text
.testknowledge/
├─ config.toml       # 预留；当前未读取此文件
├─ evidence.jsonl    # 确定性来源事实
├─ clusters.jsonl    # LLM 候选分组及确定性共享信号
├─ cluster-reviews.jsonl # 分组审核轨迹
├─ knowledge.jsonl   # 知识卡权威文件
├─ relations.jsonl   # 有类型、带证据的关系
├─ reviews.jsonl     # 审核轨迹
├─ knowledge-changes.jsonl # 变更前后快照、操作分组和回滚审计
├─ project-maps.jsonl # 当前仓库版本的测试项目地图
├─ settings.json     # 持久化的 LLM 端点与模型；唯一存放凭据的文件
├─ evaluation-plans.jsonl # 冻结的 A/B/C 任务、模型、工具、预算和阈值
├─ evaluation-observations.jsonl # 外部执行证据绑定的逐任务观察
├─ llm-cache/        # 内容寻址的可解析模型响应；非权威派生缓存
├─ index.sqlite3     # 派生 FTS5 索引
└─ exports/memory.md  # 面向人的导出内容
```

没有适用的已审核知识时，Context Pack 会返回 `ordinary_agent`，不会注入无来源的通用测试建议。

## A/B/C 行为评估

评估不使用卡片数量或 Recall@K 代替测试质量。先通过 CLI `create-evaluation --input <json>`、HTTP
`POST /api/evaluations` 或 MCP 冻结仓库版本、模型、提示词、工具、预算、任务和验收阈值；再把外部隔离
执行产生的 A（普通 Agent）、B（代码图）、C（代码图 + 测试知识）结果作为 `execution_result` Evidence
导入，并用 `record-evaluation` 记录边界覆盖、预埋缺陷检出、有效 Oracle、fixture/mock、无效断言、重复/脆弱测试及成本。

v2 计划的 `promptHash` 覆盖模板与全部任务提示。执行前用 CLI `evaluation-manifest`、HTTP manifest 入口或
MCP `get_test_knowledge_evaluation_manifest` 生成逐任务、逐变体规格；反馈与观察必须携带匹配的
`runSpecHash`。执行器只能把每项的 `agentInput` 交给被评 Agent；同级 `scoring` 只能交给隔离评估器。
`runSetId` 与任务、变体共同确定运行身份；报告只配对同一运行批次，存在多个批次时必须显式选择，
不会把各批次的最新结果拼接成看似完整的 A/B/C 比较。同一 `runId` 的观察不可覆盖；相同重试幂等，
字段变化必须新建运行批次。

`evaluation-report <plan-id>` 只比较 A/B/C 三组结果齐全的配对任务。模型、提示词哈希、工具策略哈希、
预算与行为阈值全部满足时才返回 `improved`；样本不足返回 `insufficient_data`，其余返回
`not_demonstrated`。重复与脆弱测试使用任务预先冻结、对被评 Agent 隐藏的评分口径，不能运行后改答案。
Web 评估面板会同时展示冻结条件、三组样本完整度、行为指标、低质测试计数、C 相对 B 的成本增量
和未满足条件。系统只接收外部执行证据，不自行运行测试。完整字段见 `docs/evaluation.md`。
规划逐项证据、当前状态和需要用户参与的门槛见 `docs/completion-audit.md`。

## 自动扫描项目

构建后可只传仓库路径，也可继续显式指定文件：

```powershell
pnpm --filter @testknowledge/cli start -- build --repo D:/projects/example
pnpm --filter @testknowledge/cli start -- build --repo D:/projects/example --file tests/test_example.py
pnpm --filter @testknowledge/cli start -- build --repo D:/projects/example --source issue:artifacts/issues.json execution_result:artifacts/ci-results.json
pnpm --filter @testknowledge/cli start -- build --repo D:/projects/example --source conversation:artifacts/discussion.json
```

Web 输入 API 所在机器上的仓库路径，点击“扫描仓库”；统一扫描器会组合 pytest 专用发现逻辑与
Java/JUnit、Go testing、Rust test 发现逻辑，收集对应生产代码、测试代码和环境配置，完成后自动刷新卡片。
API 的 `POST /api/build` 支持 `{"repo":"D:/projects/example"}`；`additionalFiles` 可在保留自动扫描结果的同时
加入 `{path,type}` 来源，其中 `path` 必须相对仓库且不能越界。
旧的 `files: [{path, type}]` 仍可使用，显式空数组不合法。
对话只接受显式指定的仓库内 JSON/Markdown 快照；每条消息标记为 `untrusted`，默认置信度较低，规则抽取器
不会直接把它变成知识。仅在显式启用 LLM 时才可整理为带 Evidence 引用的 `candidate`，其中任何指令文本
都按数据处理。

`issue` 来源接受 Issue JSON 数组、单个对象，或带 `issues` / `items` 的导出对象；会保留标题、正文、
状态、标签、链接和显式的 expected/actual/reproduction 字段。只有同时具备 expected 与 actual/reproduction
时，确定性规则才形成低置信度历史缺陷候选卡。`execution_result` 接受包含 `command` 数组、`outcome`
和 `observed` 的 JSON 快照；可选 `execution` 对象可记录 `durationMs`、用例计数、行/分支覆盖率、变异
分数与 killed/survived 等计数，以及最多 100 条失败明细。反馈 API 使用同一 `execution` 结构。
这些字段会进入 Evidence 和 Context Pack 的 `executionSignals`，Web 也会展示；系统不会从自由文本日志
猜测数值。两类导入都只是本地证据：不访问远端、不执行命令，也不会自动把知识标为 verified。

> 执行快照适配器升级为 `source.external-artifact.v5`；评测绑定要求 `runSetId`，并携带模型/提示词/工具策略、
> 实际工具集合及成本字段。重新构建后，旧版执行 Evidence 会由正常的
> 证据失效流程处理，已经评审或验证且依赖旧证据的卡片不会静默沿用。

自动模式递归发现任意层级的 `test/`、`tests/`，读取其中所有 Python 文件、
这些目录的祖先 `conftest.py` 和根 pytest 配置。函数识别仍使用现有 pytest 命名规则。
Python 适配器会把显式 `*Factory` 类调用、`*_factory` helper 及其 `build/create` 形式单独记录为
`factories`，并传入知识卡与 Context Pack；不会把所有普通 `create_*` 调用猜成 Factory。
Java 识别 `src/test` 和常见 `*Test/*Tests/*IT` 文件，Go 识别 `_test.go`，Rust 识别 `tests/` 与源码内
显式 `#[test]`。三者当前只提取明确的测试函数、断言、异常、mock、参数化和生命周期钩子，不推断业务语义；
复杂宏、生成代码和自定义测试运行器需要后续语言专用解析器补强。

各语言适配器独立注册：`JavaJUnitAdapter`、`GoTestingAdapter`、`RustTestAdapter` 可分别替换为完整语法
解析实现。共享词法工具不构成跨语言状态依赖。JUnit 生命周期注解和 Go `TestMain` 记录为 setup hook，
不会冒充 pytest 式可注入 fixture；Go 同时识别 test、benchmark、fuzz 和 example 入口。Git 历史中的
测试路径、建议命令、配置依赖失效和 LLM applicability 使用相同的语言/框架元数据。
不跟随符号链接，并排除版本控制、依赖、虚拟环境、构建和缓存目录。
不会自动扫描其他目录中的生产代码或 Markdown；自定义测试目录仍需显式传文件。
根配置统一适用于所有测试目录；暂不处理嵌套项目独立配置或 pytest 动态收集插件。
扫描只读取源码，不导入或执行目标项目代码。

结果增加 `scan` 摘要（模式、文件数、测试目录、发现的根配置、警告）。
`configFiles` 列出发现的配置，并不表示所有配置都被合并；实际选择遵循现有配置解析器。
`knowledgeCount` 沿用原含义：整个知识库的卡片数，包含其他仓库和过期卡片。
未发现 Python 来源时返回零文件和警告。每次构建仍按仓库全量更新，
不再出现的旧卡会标记为 stale；显式文件清单同样是构建范围，不是增量追加。
扫描或读取失败时不会开始更新知识库。API 构建和审核互斥，冲突请求返回 409。

数据目录仍相对于进程工作目录，使用 pnpm filter 启动时分别位于 CLI/API 包目录；
如需 CLI 与 API 共享数据，从同一目录直接运行各自的 dist 入口。
