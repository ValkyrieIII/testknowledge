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
├─ config.toml       # 预留的项目扫描配置；当前 build 通过 --file 显式指定来源
├─ evidence.jsonl    # 确定性来源事实
├─ knowledge.jsonl   # 知识卡权威文件
├─ reviews.jsonl     # 审核轨迹
├─ index.sqlite3     # 派生 FTS5 索引
└─ exports/memory.md  # 面向人的导出内容
```

没有适用的已审核知识时，Context Pack 会返回 `ordinary_agent`，不会注入无来源的通用测试建议。
