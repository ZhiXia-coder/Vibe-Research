# docs

- [release-checklist.md](release-checklist.md) — 发布前清单:只能由维护者拍板 / 提供的事项(License、仓库地址、国产模型矩阵真测、模板易变字段核实)与发布时序(审计在 push 之前)。
- [model-access.md](model-access.md) — 模型接入指南:ChatGPT 订阅 / OpenAI API key / 第三方 provider 三步接入、10 项兼容矩阵怎么读、怎么加一家新的 provider、常见问题。
- [agent-engineering-roadmap.md](agent-engineering-roadmap.md) — 工程化 Agent 能力审计、Agent 运行控制台说明，以及数据库任务中心、动态 Mission DAG、RBAC、评估和 HITL 的实施路线。
- 编排器细节(状态机 / validator / hooks / 配置 / MCP / HTTP API / 批量 / 提醒 / 矩阵):[../orchestrator/README.md](../orchestrator/README.md)
- 数据源端点目录(自动生成):[../datasources/CATALOG.md](../datasources/CATALOG.md)
- 计算库契约:[../calc/SPEC.md](../calc/SPEC.md)
- provider 模板字段与约束:[../providers/README.md](../providers/README.md)
