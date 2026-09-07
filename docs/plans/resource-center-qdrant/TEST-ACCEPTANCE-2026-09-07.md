# P4 本地准生产验收（2026-09-07）

## 范围

项目负责人本轮要求推进下一阶段，功能完成后集中效果测试，并明确选择“先完成本地准生产演练，外部上线另行安排”。因此本记录完成 P4 的本地准生产交付，不宣称外部上线、云对象跨区复制、正式值班签字或跨宿主机 HA 已完成。

环境：现有 Ubuntu 26.04 WSL 中独立 Docker 29.1.3；三个 Qdrant 1.14.1 peer、3 shard/3 replica/write consistency 2、TLS REST/peer、TLS 透传网关；PostgreSQL 18.6 隔离数据库；两个非 root、只读根文件系统、有资源限制的 worker 容器。临时证书与随机密钥仅用于本地环境。管理员生产模型配置未修改、未调用真实收费模型。

## 实现与证据

| 项目 | 结果 |
|---|---|
| 迁移 | `0001`–`0022` 首次与重复执行通过；新增发布审批门和事务运维审计 |
| 网络/身份 | 三个 TLS peer 均加入集群；无 key 拒绝；read-only key 可以读但不能写；自定义 CA、错误 CA、重定向阻断和文件密钥互斥/长度/格式通过 |
| 入库与双 worker | 10 份小型原创数学 TXT、真实 PG/Qdrant、两个 worker/总并发 4；embedding 与对象读取使用受控替身，验证确定性向量与发布一致性 |
| 发布与回滚 | 新代完成后保持 ready、旧代继续 active；非管理员与非法证据拒绝；promote/rollback 成功；不完整和超保留期旧代拒绝，失败不改变 active |
| 空库边界 | 无任务的重建也进入 ready，创建空 collection/schema 后可验收与切换，不永久停在 building |
| 租约/重试 | 过期租约被新实例领取，旧 owner 不能续租；失败任务摘要可见、显式 retry-job 通过；成功操作留下 3 条原子审计，失败操作不留伪成功记录 |
| 权限/引用 | 正式 SearchService + PG FTS/引用读取通过；下线后旧引用拒绝；恢复重建后 5 条引用均绑定新代 |
| 外部服务错误 | 真实 HTTP Mock 返回 503/断连时，query embedding 回退 FTS、rerank 回退融合；最终 PG 不可用时无正文返回；trace ID 与阶段数据可关联 |
| 本地对象卷故障 | 正式 LocalStorage 读写后移走对象目录，读取返回固定安全错误且不暴露目录；恢复后正文和 checksum 一致。云供应商实际故障不计入本地验证 |
| 容器依赖故障 | 中断真实 PostgreSQL 或全部 Qdrant，worker `/ready` 503、`/live` 200；依赖恢复后两个实例重新 ready |
| 单节点故障 | 停止一个 Qdrant peer，经网关发现窗口后仍可读写；恢复后各节点核对到 10001 点 |
| 备份恢复 | PG custom archive + 私有对象导出 + 各 peer collection snapshots；12 份节点快照、14 项文件清单，age 加密、完整校验、损坏密文拒绝；隔离空库恢复与 5 张核心表计数、对象字节核验通过 |
| Collection 丢失恢复 | 使用恢复的 PG，经 verify-full TLS 连接重建丢失 collection；9 个有效点、零对账差异、5 条当前引用通过，管理员 promote 成功 |
| 监控告警 | 13 条 Prometheus 规则经 promtool 校验；真实 Prometheus 采集两 worker TLS/token 指标，停止 worker 后 Alertmanager 向本地 webhook 发出 firing，恢复后发出 resolved，共 2 批回执 |
| 镜像升级 | 固定 Qdrant 服务端二进制 SHA-256 `3bb2c5cf9c7fea5558a012dc92f8bbc5cf4ab5710a1dadf6a4ecde32edab843f`；更新系统运行库、移除非必要 Web UI 后三个 peer 逐节点滚动，重新加入集群，正式混合检索复验通过 |

## 容量与恢复口径

- 10000 向量、1024 维、5 并发、100 次检索，P95 **22.92 ms**。这是本地集群容量 smoke，向量为合成数据，不是语义质量测量，也不替代 P5 的目标规模基准。
- 完整备份 **9.788 s**，隔离 PG/对象恢复 **0.483 s**，恢复后丢失 collection 的重建与切换 **8.577 s**。恢复数据为 10 份小文档/9 个有效点，不能外推到十万或百万档 RTO。
- D-009 本地流程目标为每日备份、RPO 24 小时、RTO 60 分钟，演练内满足目标。实际生产备份调度、保留销毁、云对象版本和生产规模 RPO/RTO 在外部上线时执行，不声称已运行满 24 小时或已建立生产 PITR。

## 工程与安全

临时 Go 测试覆盖公共/边界/错误路径，外部模型用 Mock；全仓 race 测试通过。核心定向覆盖：文件密钥读取 100%、拓扑核验 100%、TLS 客户端 92.9%、阶段指标与共享 schema 100%、运维状态/命令 85.7%/82.4%、原子操作入口 84.2%。这些是受测函数覆盖，不是整个历史仓库覆盖率。

后端 `go test -race ./...`、`go vet ./...`、`go build ./...`，前端 lint/build 均通过；前端保留既有大块体积和 Browserslist 数据过期提示，本轮未修改产品页面。Python 工具另有 6 组边界验证，覆盖路径穿越、链接拒绝、非空恢复目标、校验和、质量探针及重定向拒绝。

原始 Qdrant 镜像扫描发现系统包和 Web UI 依赖高危项；使用固定原引擎与更新 Debian 运行库的精简镜像消除本次扫描中的可修复 HIGH/CRITICAL。后端更新 OpenSSL 系统包和 `golang.org/x/crypto v0.55.0` 及其必需依赖，修复同类镜像扫描项。Trivy 使用 `--scanners vuln --severity HIGH,CRITICAL --ignore-unfixed`，两个修复镜像均为 **0 项**；该口径不表示所有等级、未修复漏洞或 Rust 二进制全部依赖均被穷尽证明安全。`govulncheck` 未发现当前调用链可达漏洞。

末次复核的本地镜像 ID：backend `sha256:7e99b9f64d26d5872ab3bb0d16e6cba1adb7b11263b0852640c714901a0694ca`；Qdrant `sha256:b69e86fe8c683e78b27f21c8456ad9d3be3cb602284d2d0c95c98cf0382b33dc`。两个镜像均包含非 root 运行配置，末次扫描均为上述范围 0 项。交付文件敏感信息检查通过，未发现本轮临时密钥材料；临时 Go 测试源码已删除，删除后生产代码构建通过。

## 交付与外部边界

交付 `deploy/vector/` 集群/worker/监控配置与精简镜像 Dockerfile、加密备份工具、在线质量探针、运维命令、指标审计、`0022` migration 和[运行手册](../../technical/vector-operations.md)。测试源码、fixture、私钥、临时数据库/容器和代理不作为交付物。

管理员真实模型的 P3 质量结论仍引用 [2026-09-06 验收](TEST-ACCEPTANCE-2026-09-06.md)。云对象存储仍要求按供应商导出/恢复到相同私有命名空间；本轮验证的是本地对象导出，不把替身或本地文件验证记成真实云服务验收。单宿主机三节点也不等于跨可用区容灾。外部上线需接入真实证书/secret 管理、最小权限数据库账号、备份调度、正式告警渠道与组织验收；这些已按项目负责人要求移到独立上线范围。
