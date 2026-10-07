# TestKnowledge

**面向 Coding Agent 的、可追溯的项目测试知识引擎。**

项目里的测试经验往往散落在测试代码、环境配置、文档和历史缺陷中。Agent 编写新测试时，需要知道已有测试怎么组织、哪些依赖要替换、什么结果才算正确，以及哪些回归问题值得关注。

TestKnowledge 将这些材料整理为带来源的证据与知识，在测试设计前按任务返回结构化上下文。开发者可以检查出处、审核候选、记录外部执行反馈，并在依据变化后重新审查知识。

## 工作方式

```text
项目代码、测试、配置、文档与显式快照
                  ↓
         扫描与来源适配 → Evidence
                  ↓
      ┌───────────┴───────────┐
      │                       │
  Observation             候选知识卡
  可直接观察的事实        LLM 提议或人工录入
      │                       ↓
      │                校验 → 人工审核
      └───────────┬───────────┘
                  ↓
      任务检索与适用范围过滤 → Context Pack
                  ↓
     Coding Agent 设计测试 → 外部执行与反馈
```

系统区分三个层次：

| 层次 | 内容 | 用途 |
| --- | --- | --- |
| **Evidence · 证据** | 来源文件、符号、位置、原文、版本和抽取信息 | 回到原始材料核对依据 |
| **Observation · 观察** | 明确出现的断言、异常、fixture、mock、参数化与环境事实 | 了解项目已有测试做法；查询时由证据投影生成 |
| **Knowledge · 知识** | 带适用条件、预期行为、判断准则和证据引用的知识卡 | 经审核后供 Agent 复用 |

静态观察与知识卡分别呈现。未启用 LLM 时也可以扫描和查询项目事实；行为级知识可以通过显式 LLM 抽取或人工整理补充。

## 当前能力

- **项目接入**：扫描测试与相关生产代码、框架配置，生成测试项目地图；支持显式补充文档、对话、Issue 和执行结果快照。
- **知识整理**：可选 LLM 候选抽取、证据分组、人工单卡录入及知识包导入；候选必须引用已有证据。
- **任务上下文**：结合仓库、语言、框架、目标符号和文件范围，通过精确召回与 BM25F 检索筛选内容。目标项目已有 CodeGraph 索引时，可补充结构影响分析。
- **知识维护**：支持审核、合并、冲突决议、版本变更记录、回滚与证据变化后的失效处理。
- **可观察性**：Web 展示证据、候选分组、知识卡、关系和抽取运行记录，便于查看各阶段结果与失败原因。
- **统一入口**：Web、HTTP API、CLI 和本地 stdio MCP 共享核心引擎与生命周期约束。

### 语言与框架

| 语言 / 框架 | 当前方式与范围 |
| --- | --- |
| Python / pytest | AST 解析；测试、fixture、断言、异常、mock、显式 Factory 和参数化等 |
| Java / JUnit | 保守词法适配；明确的测试入口、断言、异常、mock 和生命周期钩子 |
| Go / testing | 保守词法适配；test、benchmark、fuzz、example 入口及显式测试构造 |
| Rust / test | 保守词法适配；`tests/` 与源码内显式 `#[test]` 等构造 |

Java、Go 和 Rust 尚未采用完整语法解析器，复杂宏、生成代码和自定义测试运行器可能无法识别。扫描只读取材料，不导入或执行目标项目代码。

## 快速开始

需要 **Node.js 24+**、**pnpm 11.7.0**。Python 源码使用 `@lezer/python` 在 Node.js 内解析。以下命令在本仓库根目录执行。

### 1. 安装与构建

```powershell
pnpm install
pnpm build
```

### 2. 扫描目标项目

将示例路径替换为目标仓库的本地路径：

```powershell
pnpm --filter @testknowledge/cli start -- init
pnpm --filter @testknowledge/cli start -- build --repo D:/projects/example
```

自动扫描支持常见测试目录与命名。自定义目录或额外来源可以显式指定：

```powershell
pnpm --filter @testknowledge/cli start -- build --repo D:/projects/example --file tests/test_example.py
pnpm --filter @testknowledge/cli start -- build --repo D:/projects/example --source issue:artifacts/issues.json execution_result:artifacts/ci-results.json
```

`--file` 定义本次构建范围；`--source` 在扫描结果上补充来源。来源路径相对于目标仓库。构建按仓库更新，显式文件清单不是增量追加，未再出现的旧知识可能变为 `stale`。

### 3. 查看与审核

在两个终端中分别启动 API 和 Web：

```powershell
pnpm --filter @testknowledge/api start
```

```powershell
pnpm --filter @testknowledge/web dev
```

打开 [Web 工作台](http://127.0.0.1:5173)，输入 **API 所在机器上的仓库路径**。扫描后可以查看原始证据、知识候选、分组与运行记录，再审核可复用的内容。API 默认地址为 `http://127.0.0.1:4173`，前端开发服务器将 `/api` 请求代理到该地址。

### 4. 查询测试上下文

```powershell
pnpm --filter @testknowledge/cli start -- query --repo D:/projects/example --task "为 parse_config 补充边界测试" --symbol parse_config
```

默认查询仅纳入符合条件的 `reviewed` / `verified` 知识；检查候选时可显式加上 `--include-candidates`。返回的 Context Pack 包含适用知识、观察事实、现有测试、fixture/mock、判断准则、历史回归、运行指令、证据定位和缺失信息说明。

首次扫描可能只有证据与观察，没有可用知识卡。没有适用知识时，系统返回 `ordinary_agent`，并通过 `abstentions` 说明缺失信息；仍可提供已有项目事实供调用方参考。

## 接入 Coding Agent

构建完成后，客户端启动本地 MCP 服务，优先调用 **`get_test_context`**。请求应包含仓库路径、任务描述，并尽量提供目标符号和变更文件。

| 客户端 | 仓库提供的配置 |
| --- | --- |
| Codex | [`.codex/config.toml`](.codex/config.toml) |
| Claude Code / GitHub Copilot CLI | [`.mcp.json`](.mcp.json) |
| VS Code Copilot | [`.vscode/mcp.json`](.vscode/mcp.json) |

各客户端消费同一套 Context Pack。知识构建、审核、合并和反馈属于写操作，应按客户端权限策略授权。Copilot 云端场景需要另行部署可访问的远程服务。

配置说明和推荐调用顺序见 [Agent 接入指南](docs/agent-integration.md)。

## 可选 LLM 抽取

默认构建不调用 LLM。配置 OpenAI-compatible 接口后，通过 `build --llm` 显式启用：

```powershell
$env:TESTKNOWLEDGE_LLM_BASE_URL = "https://your-provider.example/v1"
$env:TESTKNOWLEDGE_LLM_API_KEY = "your-api-key"
$env:TESTKNOWLEDGE_LLM_MODEL = "your-model"
pnpm --filter @testknowledge/cli start -- build --repo D:/projects/example --llm
```

也可以在 Web 中保存配置；环境变量优先于持久化设置。启用后，来源证据片段及模型请求补充读取的材料会发送至配置的模型服务。候选按证据分片生成，模型可通过受约束的只读工具补充仓库材料，读取轨迹与阶段结果用于审计。

模型输出必须引用 Evidence，经过核心校验后仍是 `candidate`。证据分组和知识卡分别审核，确认分组不会自动确认知识。未配置或抽取失败时，系统保留确定性事实处理路径，并记录相关警告。

## 知识的可信边界

| 状态 | 含义 |
| --- | --- |
| `candidate` | 待审核提议，默认不作为可复用知识注入 |
| `reviewed` | 人工审核通过，尚未完成执行验证 |
| `verified` | 已审核，并显式绑定同仓库、同修订的成功执行证据 |
| `rejected` | 已拒绝；需要重写为候选再审查 |
| `stale` | 原有依据已变化或被明确反例推翻，需要重新审查 |

证据、目标代码或相关环境配置变化时，系统会检查是否需要使已审核知识失效。知识存在未解决冲突时，默认从上下文中排除。合并与回滚恢复的卡片重新进入 `candidate`，不会继承旧执行验证。

执行反馈由外部 runner、CI 或开发者提供。接收成功结果不会自动提升状态；普通失败也不会自动推翻知识，只有显式提交可追责的反证评估才触发相应失效。

TestKnowledge 负责提供测试上下文与维护知识，测试生成和执行由外部 Agent 与工具完成。当前支持本地 Issue/CI 快照导入，尚未直连这些平台；检索采用精确匹配与 BM25F，未实现向量检索。项目提供受控行为评估相关机制，实际收益仍需完整实验数据证明。

## 架构与存储

项目采用 TypeScript monorepo，领域模型、核心流程与外部适配分别维护。API、CLI 和 MCP 通过统一组合入口装配引擎，来源适配、存储、索引、抽取器及结构分析均通过接口接入。

```text
apps/
├─ api/          Fastify HTTP API
├─ cli/          命令行入口
├─ mcp/          stdio MCP 服务
└─ web/          Vue 3 工作台
packages/
├─ model/        数据结构与校验
├─ core/         构建、检索、审核与生命周期
└─ adapters/     来源解析、存储、检索及外部工具适配
```

**JSONL 保存权威数据，SQLite FTS5 保存可重建的检索索引。** 默认数据目录为调用工作区的 `.testknowledge/`；包管理器启动时优先按 `INIT_CWD` 定位，也可通过 `TESTKNOWLEDGE_DATA_ROOT` 指定统一目录。

主要文件包括 `evidence.jsonl`、`knowledge.jsonl`、`relations.jsonl`、`project-maps.jsonl`，以及审核、分组、知识变更和抽取运行记录。`settings.json` 保存模型配置与凭据，`llm-cache/` 保存模型响应缓存，`index.sqlite3` 为派生索引。CLI、API 与 MCP 应指向同一数据目录以共享知识。

