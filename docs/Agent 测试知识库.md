# Agent 测试知识库

# 项目背景

目前的 Coding Agent 会通过 memory、外挂知识库等方式提升对现有仓库的理解程度，避免由于同一类错误多次出现增加的成本

已有的 agent 知识库工具大多面向通用代码任务，但是软件测试任务更依赖程序员经验、业务领域知识，需要专门的知识增强方式

希望设计一个针对软件测试的知识抽取工具，可以接入 claude code/ codex/ github copilot 等 coding agent, 用于提升 agent 编写测试代码的质量

# 项目整体目标

## 前端：知识库可视化界面

可以是一个网页/UI 界面，主要展示测试知识的

（可参考现有知识库的展示网站，如 https://github\.com/trailhq/Graft）

## 后端：知识库的工程化框架

### 知识库数据结构

目前参考腾讯的知识库引擎（[任何错误只犯一次：TencentDB Agent Memory 的团队记忆实践](https://mp.weixin.qq.com/s/-ghlUNmB8HvzX9cFYXlDKg)），将测试知识的组成结构梳理为：[测试领域Agent知识结构梳理](https://vcnimrudrzc9.feishu.cn/wiki/UhoNw3cxBiBPA5kleSBc0bQenDe)

需要完成一个知识库框架，分层管理：

- 交互层：经过总结后人可以看的内容: 对话窗口输出、memory\.md 等

- 中间表示层：向下对资料层的数据进行总结筛选，用标准数据格式统一管理，支持增删改；向上对 agent 提供检索入口，设计合适的算法给出最符合的知识

- 资料层：和项目直接接触，包括会话历史、代码的静态分析结果、代码执行结果、项目文档等



## 工程化后端接口

- 兼容的查询接口，支持 claude code 等多种 agent;

- 兼容的资料层接口，增加一种知识来源稍作修改就能处理；

- 支持多种语言

# How to Start

## 可能用到的技术栈

* [ ] 软件测试相关知识：

    * [ ] 测试方式：单元测试、集成测试、fuzzing\.\.\.\.

    * [ ] 测试用例设计思路：等价类划分、边界值分析、最小覆盖路径分析\.\.\.\.

    * [ ] 各语言对应的测试框架、mock 框架、覆盖率分析库 \.\.\.\.

    * [ ] 静态分析工具、LSP、CodeQL \.\.\.

* [ ] Agent 接口使用

    * [ ] Cli 命令行及参数

    * [ ] Memory、tools、skill 导入

* [ ] 现有 Agent 知识库参考：构建方式、接口使用

    * [ ] 

## 现阶段目标

* [ ] 从熟悉的语言开始：Java/python/go/rust \.\.\.

* [ ] 从简单的数据格式开始做起：memory\.md \-\> bm25/向量查询，然后再加静态分析等工具

* [ ] 参考现有的知识库，构建一个 demo

# 参考资料

- 腾讯知识库相关：

    - [Harness不是目的，知识才是护城河 —— 一个AI工程交付团队的知识沉淀实践](https://mp.weixin.qq.com/s/JV4-oPP0jjsBCZ4tW3Gy1g)

    - [任何错误只犯一次：TencentDB Agent Memory 的团队记忆实践](https://mp.weixin.qq.com/s/-ghlUNmB8HvzX9cFYXlDKg)

- Qoder 知识引擎：

    - [AI\-Native 软件工程领域自迭代知识引擎](https://qoder.com/zh/blog/qoder-knowledge-engine)

    - [企业知识中心 \- Qoder](https://docs.qoder.com/zh/account/enterprise/knowledge-base)

- Agent 知识库相关：

    - Graft:持久化的代码上下文 https://github\.com/NanoNets/Graft

    - CodeGraph： https://github\.com/colbymchenry/codegraph

    - Copilot Memory https://docs\.github\.com/zh/copilot/concepts/agents/copilot\-memory

    - Codebase memory mcp: https://github\.com/DeusData/codebase\-memory\-mcp

    - Gbrain：https://github\.com/garrytan/gbrain

    - GitNexus：https://github\.com/abhigyanpatwari/GitNexus





