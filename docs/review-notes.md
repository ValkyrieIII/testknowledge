# 审阅记录（点时间快照）

> 这不是设计文档，是一次只读审阅的发现清单，供下一轮工作接手时核对。
> 审阅方式：读取源码 + 直接核对 `.testknowledge/` 权威数据 + 与目标仓库 `D:\projects\qqbot` 的真实文件对账。
> **本次未修改任何代码、知识数据或配置。**

审阅时的状态：`HEAD = 732701c`（9/9），工作树有 **20 个文件未提交、+3696 / -168**（9/14）。

---

## 1. 环境卡的"命令—工作目录"仍然是错配的（建议优先处理）

上一轮已修复数据层，但**消费端没跟着改**，所以卡片仍然产出错误结论。同一批证据派生出三份产物，只有一份是错的：

| 产物 | 状态 | 实际值 |
|---|---|---|
| 证据 payload | ✅ 正确 | `runInstructions: [{ commandText: "python -m pytest -q" }]`（无工作目录） |
| 持久化项目地图 | ✅ 正确 | `{ commandText: "python -m pytest -q" }` |
| **知识卡 `statement`** | ❌ **错误** | `"命令：python -m pytest -q；工作目录：frontend"` |

**真实情况**（`qqbot/.github/workflows/ci-cd.yml`）：

```yaml
      - name: Run backend tests
        run: python -m pytest -q        # 第 46 行，无 working-directory
      # ... 间隔 14 行 ...
      - name: Build frontend
        working-directory: frontend     # 第 61 行，属于 pnpm build 那一步
```

两个字符串分属**不同的 step**，相隔 14 行。

**缺陷位置**

- `packages/adapters/src/rule-extractor.ts:111-112` — 仍然读旧式扁平数组 `profile.runCommands` / `profile.workingDirectories`，**从未引用 `profile.runInstructions`**（正确的数据就在同一个 payload 里）。
- `packages/adapters/src/rule-extractor.ts:119` — 把四个互相独立的列表用 `；` 拼成一句。这个分隔符在中文里读作"并且"，但四个列表之间没有任何对应关系。
- 上游来源：`packages/adapters/src/test-environment.ts:53-55` — `runCommands` 与 `workingDirectories` 各自独立产生；`:55` 是**全文扫所有 `working-directory:` 行**，与该 step 有没有命令无关。
- 同一行的 `rule-extractor.ts:121` 有同类问题：`preconditions: envNames, dependencies: serviceImages` 也是无关联的列表直接挂在卡上。

**为什么这条要优先**：错误的这份恰好是**唯一会经过人工审核、并进入 Agent 上下文**的那份（`knowledge[].statement`）。而且它读起来完全合理，容易在审核时被放过——一旦放过就固化为"这个项目的后端测试要在 frontend 目录下跑"。这正是本项目自己定义的"给错一张 = 有害"。

**注意校验层拦不住它**：`ungroundedAnchors`（`engine.ts:277`）只检查符号/路径/依赖/锚点是否出现在引用的证据里。`python -m pytest` 和 `frontend` **两个字符串都真的在证据里**，只是不属于同一步。校验能查"有没有出处"，查不了"出处有没有对位"。

**附注**：该证据的 `sourceRef` 是 `.github/workflows/ci-cd.yml:1`，真实位置是第 46 行。请确认这是有意的占位约定还是缺陷。

---

## 2. 溯源字段无法表达"由 agent 起草"

`examples/qqbot-pilot-knowledge.json` 的 14 张卡由 agent 起草（约 6 分钟），但产物本身写着 `reviewer: "ValkyrieIII"`、`note: "…人工整理…"`。

- `packages/model/src/schemas.ts:136` — `origin: z.enum(["extracted", "manual"])`，只有两个取值。
- `packages/core/src/engine.ts:1103`、`:1133` — 人工录入与知识包导入都写死 `origin: "manual"`。
- `CreateKnowledgeBatchRequestSchema` 强制要求 `reviewer` 和 `note`，**没有任何字段可以表达"草案由 agent 生成、尚未经人确认"**。

导入后这 14 张会被系统记为 `origin: "manual"`。鉴于本项目的核心主张是"必须有出处"，建议在导入前先决定：是补一个溯源自段，还是至少把 `note` 改成实际情况。

---

## 3. 这批工作全部未提交

`HEAD` 仍是 `732701c`（9/9 14:54），实际产出集中在 9/14。`README.md` 已经在描述尚未入库的治理层与评估层。继续推进前建议先落一个提交点。

---

## 4. 建议留意的验证模式

上一轮 agent 发现并修复了一个**真实**缺陷（CI 命令错配工作目录），修复本身正确，但**只验证了一个产物就宣布该类问题已解决**——它核对的是持久化项目地图，没有核对同一批证据派生出的知识卡，于是缺陷在卡片里留存至今。

后续复核时，建议把"同一批证据派生了哪些产物"作为清单逐项过，而不是验证单点。

---

## 审阅时确认无误的部分

- 构建产物是新鲜的：`packages/core/dist/engine.js` 含 `mergeKnowledge` / `rollbackKnowledge` / `evaluationReport` 等方法（目录 mtime 偏旧只是 tsc 未更新目录时间戳）。
- `examples/qqbot-pilot-knowledge.json` 的证据引用 **36/36 全部命中**当前 `.testknowledge/evidence.jsonl`，revision 一致，格式符合 `CreateKnowledgeBatchRequestSchema`，可以直接导入。
- 数据根目录统一修复有效：`.testknowledge/` 只有一个，位于仓库根。
