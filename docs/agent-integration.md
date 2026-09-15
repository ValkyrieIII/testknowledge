# Agent 接入

TestKnowledge 的 Agent 边界是 MCP：知识核心、JSONL 权威数据和生命周期规则不感知具体 Agent，Codex、Claude Code 与 GitHub Copilot 只负责启动同一个 stdio 服务并消费同一个 `ContextPack`。

## 前置条件

首次接入或源码变化后，在仓库根目录执行：

```powershell
pnpm install
pnpm build
```

共享配置直接启动 `apps/mcp/dist/main.js`，因此不依赖客户端能否在 Windows 上直接执行 `pnpm.cmd`。知识数据默认写入仓库根目录的 `.testknowledge/`。

## Codex

仓库已提供 `.codex/config.toml`。在仓库根目录打开 Codex 后，确认 `testknowledge` MCP 服务可用即可。

## Claude Code

Claude Code 会读取仓库根目录的 `.mcp.json`。首次使用项目级 MCP 服务时，检查配置并在客户端中确认信任；`CLAUDE.md` 约定了查询顺序和生命周期边界。

## GitHub Copilot

Copilot CLI 可在受信任的工作区读取 `.mcp.json`；VS Code Copilot Agent 使用 `.vscode/mcp.json`。
仓库级行为约束位于 `.github/copilot-instructions.md`。两种配置都只启动本地服务，不上传知识数据。

Copilot 云端 Agent 和代码审查运行在远端，不能访问开发机上的 `.testknowledge/`，也不能可靠启动一个只存在于本地工作区且依赖本地产物的 stdio 服务。要支持云端场景，需要另行部署带鉴权的远程 MCP 服务，并在 GitHub 仓库设置中配置允许的只读工具；当前项目没有把本地知识数据上传到远端。

## 推荐调用顺序

1. 测试设计前先调用 `get_test_context`，带上仓库、任务、目标符号和变更文件。
2. 按 `applicability`、证据定位和生命周期判断哪些项目经验可用。
3. 若返回 abstention，明确退回普通代码推理，不用相似候选填空。
4. 只有用户明确要求修改知识库时，才调用构建、审核、合并、回滚、反馈或评估写入工具。
5. `verify_test_knowledge` 只接受同仓库、同版本、显式绑定且成功的外部执行证据；MCP 服务本身不运行测试。

## 能力边界

- MCP 的读取工具带 `readOnlyHint`；本地知识库写入工具单独标记，客户端可据此实施权限策略。
- 三个 Agent 接收到相同结构化结果，不需要为每个 Agent 复制知识或重建索引。
- Agent 的提示词约定不能替代服务端校验；证据引用、生命周期流转和版本绑定仍由核心层强制执行。
