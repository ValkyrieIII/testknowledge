# TestKnowledge

面向 Coding Agent 的测试知识引擎。它把测试代码和项目文档中的可追踪事实整理成知识卡，在 Agent 编写测试前提供项目特有的 fixture、mock、边界、断言和历史缺陷信息。

## 当前首版

- TypeScript monorepo：Vue 3、Fastify、CLI 和核心领域模型共享类型。
- Source Adapter：Python/pytest 与 Markdown 文档。
- 抽取：确定性 Evidence + 可选 OpenAI-compatible LLM candidate。
- 检索：范围过滤、符号/路径精确召回、BM25F；向量检索暂不默认启用。
- 存储：JSONL 是权威数据，SQLite FTS5 是可重建索引。
- 状态：`candidate`、`verified`、`rejected`、`stale`。

## 身份与版本

知识卡与证据的 ID 只由自身内容决定：卡片取 `repo + 语义字段`，证据取 `repo + 路径 + 符号 + 位置 + 内容哈希`。项目级 `revision` 仅作为溯源元数据记录，不参与身份计算。因此改动无关文件不会使已审核的卡片失效；只有内容真正变化时才会产生新的 `candidate`，并把旧卡标记为 `stale`。

> 从旧版本升级后历史 ID 会变化，需要重新执行一次 `build`。

## 运行

```powershell
pnpm install
pnpm build
pnpm --filter @testknowledge/cli start -- init
pnpm --filter @testknowledge/api start
pnpm --filter @testknowledge/web dev
```

API 默认监听 `http://127.0.0.1:4173`，前端开发服务器默认监听 `http://127.0.0.1:5173`。

## 数据目录

```text
.testknowledge/
├─ config.toml       # 预留；当前未读取此文件
├─ evidence.jsonl    # 确定性来源事实
├─ knowledge.jsonl   # 知识卡权威文件
├─ reviews.jsonl     # 审核轨迹
├─ index.sqlite3     # 派生 FTS5 索引
└─ exports/memory.md  # 面向人的导出内容
```

没有适用的已审核知识时，Context Pack 会返回 `ordinary_agent`，不会注入无来源的通用测试建议。

## 自动扫描项目

构建后可只传仓库路径，也可继续显式指定文件：

```powershell
pnpm --filter @testknowledge/cli start -- build --repo D:/projects/example
pnpm --filter @testknowledge/cli start -- build --repo D:/projects/example --file tests/test_example.py
```

Web 输入 API 所在机器上的仓库路径，点击“扫描仓库”；完成后自动刷新卡片。
API 的 `POST /api/build` 支持 `{"repo":"D:/projects/example"}`；
旧的 `files: [{path, type}]` 仍可使用，显式空数组不合法。

自动模式递归发现任意层级的 `test/`、`tests/`，读取其中所有 Python 文件、
这些目录的祖先 `conftest.py` 和根 pytest 配置。函数识别仍使用现有 pytest 命名规则。
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
