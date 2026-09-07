# P4 生产就绪

> 状态：`DONE`（本地准生产范围）
> 负责人：Codex；开始日期：2026-09-07
> 本轮执行：按项目负责人要求推进 P4，功能完成后集中执行效果与故障验收。
> 验收边界：项目负责人已明确“先完成本地准生产演练，外部上线另行安排”；以下生产要求在本轮以本地准生产实现/演练验收，正式环境接入独立跟踪。
> 里程碑：M4 生产就绪
> 前置依赖：[P3 检索与 RAG 集成](03-retrieval-and-rag-integration.md) `DONE`
> 后续阶段：[P5 性能与质量](05-performance-and-quality.md)
> 模型配置：生产模型及其向量契约仍由管理员在管理端测试并激活；部署配置不得硬编码或覆盖管理员选择。
> 执行约束：P2-A 暂停门已于 2026-09-06 明确解除；当前阶段仍须满足上述前置里程碑后才能启动。

## 1. 阶段目标

把 MVP 从单机开发能力提升为可安全部署、可观测、可恢复、可升级和可值守的生产系统。生产环境使用 Qdrant cluster 或经批准的 Qdrant Cloud，不使用开发单节点作为生产拓扑。

## 2. 预计影响范围

- 生产 Compose/编排、网络、TLS、secret、账号和资源配额配置。
- `backend/cmd/vector-worker` 的多实例、优雅停止、健康与 readiness。
- metrics、tracing、structured logging、audit 和告警。
- PostgreSQL、对象存储、Qdrant collection/generation 的备份、恢复与重建工具。
- 发布、升级、蓝绿 generation 切换、回滚和事故运行手册。
- 管理端处理状态、dead job、backlog、reconcile 和重建可见性。

## 3. 工作清单

- [x] **P4-01 生产拓扑落地**：按 D-010 部署 Qdrant cluster/Cloud，定义依赖版本、分片、副本、资源、节点、存储和可用区边界。
- [x] **P4-02 网络与身份安全**：配置私网、TLS、服务账号、最小权限、管理员渠道凭据加密、secret 注入、证书轮换和访问审计，禁止默认账号/明文凭据或部署侧覆盖 active 模型。
- [x] **P4-03 Worker 高可用**：验证多实例 claim/lease、并发上限、优雅停止、滚动升级、backpressure 和异常接管。
- [x] **P4-04 指标与 tracing**：覆盖 API、outbox、job、parser、embedding、Qdrant、FTS、rerank、final auth、reconcile 和 generation 切换。
- [x] **P4-05 安全审计日志**：记录操作者、资源、版本、动作、结果和 trace；正文、向量、密钥、Token 与敏感 ACL 不入日志。
- [x] **P4-06 Dashboard 与告警**：建立延迟、错误率、backlog age、dead、租约超时、向量漂移、降级率、质量探针和容量告警。
- [x] **P4-07 备份策略**：按 D-009 落地 PostgreSQL custom archive、对象存储版本/备份、Qdrant collection/storage snapshot；明确 point 可重建边界。
- [x] **P4-08 恢复与重建演练**：从 PostgreSQL 和对象存储重建 collection，验证 vector config、payload index、checksum、数量、generation、权限和 RPO/RTO。
- [x] **P4-09 升级与蓝绿切换**：验证 schema/client/服务升级、双 generation 构建、质量门禁、原子切换和旧 generation 保留/清理。
- [x] **P4-10 降级与故障演练**：分别中断 Qdrant、embedding、rerank、对象存储、PostgreSQL 和 worker，验证 D-008、告警和恢复。
- [x] **P4-11 运行手册**：形成 backlog、dead job、lease、reconcile、重建、证书/密钥轮换、容量和事故响应手册。
- [x] **P4-12 生产验收**：在批准的本地准生产范围完成安全扫描、备份恢复、滚动升级、故障演练、容量 smoke 与本地告警回执；外部上线和正式值班交接另行安排。

## 4. 生产安全门禁

1. 生产 Qdrant 不暴露公网管理端口，所有链路使用已批准的 TLS 和服务身份。
2. 密钥只从受控 secret 来源注入，不写入 `.env.example`、日志、错误、任务 payload 或备份说明。
3. 文档解析运行在有资源限制的隔离边界，防止恶意文档消耗 CPU、内存、磁盘或触发外部访问。
4. PostgreSQL 最终鉴权不可因缓存、降级或 Qdrant 故障被绕过。
5. 备份加密、访问、保留和销毁符合 D-009；恢复环境同样受权限控制。
6. 观测 label 不包含用户 ID、资源原文、原始 query 或错误全文等高基数/敏感数据。
7. 只有管理员可测试、激活或切换生产模型；运行进程只读 active 不可变版本，所有变更必须审计且可回退。

## 5. 关键演练

| 演练 | 通过条件 |
|---|---|
| Worker 滚动重启 | 无 job 丢失；租约接管后最终收敛；无重复向量 |
| Qdrant 故障 | API 按 D-008 降级，告警及时，恢复后 reconcile 清零差异 |
| Embedding provider 故障 | 队列受控增长，无无限重试或敏感错误泄露 |
| PostgreSQL 恢复 | 恢复业务真相、任务和 active generation，应用按顺序恢复 |
| Collection 丢失 | 从 PostgreSQL+对象存储重建并在 RTO 内切换 |
| 错误 generation 发布 | 质量门禁阻止切换，或可原子切回旧 generation |
| 凭据轮换 | 新旧凭据有受控窗口，业务不中断，旧凭据按期失效 |

## 6. 验证计划

- 临时多实例测试覆盖租约接管、滚动停止和并发 worker；结束后删除测试源码。
- 在准生产执行 snapshot 备份、恢复、collection 重建和 generation 回滚，记录实际 RPO/RTO。
- 使用故障注入逐项验证依赖中断、告警和降级；不能只以单元 Mock 代替。
- 运行漏洞扫描、依赖审计、配置扫描和敏感信息扫描。
- 执行全量测试、race、vet、build、前端 lint/build，以及 API/worker/浏览器 smoke。
- 验证 dashboard 指标与实际故障一致，无高基数或敏感 label。

## 7. 阶段退出条件

- 生产拓扑、TLS、服务账号和网络隔离通过安全评审。
- Worker 重启无丢任务，dead/backlog/reconcile 有可执行运维闭环。
- PostgreSQL、对象存储和 Qdrant 恢复/重建达到 D-009 的 RPO/RTO。
- 全部关键故障演练达到 D-008，告警和运行手册可由非开发人员执行。
- generation 蓝绿发布与回滚完成一次实操。
- 准生产容量 smoke、依赖审计和敏感信息检查通过。

## 8. 完成记录

本轮证据见 [2026-09-07 验收报告](TEST-ACCEPTANCE-2026-09-07.md)，运行步骤见[向量运行手册](../../technical/vector-operations.md)。三节点 TLS、双 worker、运维审计/指标、加密备份与恢复重建、蓝绿回滚、真实故障与本地告警回执均通过，P4 12/12 完成；外部生产上线和正式值班签字不在本轮范围。

| 字段 | 内容 |
|---|---|
| 状态 | `DONE`（本地准生产） |
| 负责人 | Codex |
| 开始日期 | 2026-09-07 |
| 完成日期 | 2026-09-07 |
| 验证命令/演练 | Go race/vet/build、前端 lint/build、Docker 镜像构建、双 worker 与三 peer、PG恢复重建、Prometheus/Alertmanager、Trivy/govulncheck、差异与敏感信息检查 |
| 验证结果 | 通过；详细负载、耗时、Mock 与真实依赖边界见验收报告 |
| 覆盖率 | 新增核心函数 82.4%–100%；PG 原子操作入口 84.2%，不是历史全仓覆盖率 |
| 交付物 | 生产拓扑、观测、告警、备份恢复、升级回滚、运行手册 |
| 回滚或降级验证 | ready/promote/rollback、过期与不完整旧代拒绝、PG失败关闭、FTS/融合回退、节点与worker恢复通过 |
| 遗留风险 | 正式环境证书/账号/备份调度/告警渠道、生产规模 RPO/RTO 和跨故障域由外部上线独立验收；本轮不外推 |
