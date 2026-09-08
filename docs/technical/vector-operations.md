# 资源向量生产运行手册

本手册对应 P4。代码和交付配置不代替生产环境验收；实际演练结果见专项 P4 完成记录。当前模型继续由管理员唯一 active 不可变版本决定。

## 拓扑与身份

部署基线为三个 Qdrant `v1.14.1` peer、三个 shard、每 shard 三副本、写入至少两副本确认，以及两个独立 worker，每实例并发 2。保留现有 API 单实例边界，不扩大 Session 取消机制的承诺。超过 10 万向量或超过冻结吞吐时必须先完成 P5 容量验证。

`deploy/vector/compose.yaml` 是隔离的三 peer 准生产演练入口。同一 Docker 宿主机没有宿主机/可用区容灾能力；正式生产须把三个 peer 分别放在三个故障域，使用独立持久卷、私网 DNS 和受控负载均衡。每节点初始 2 CPU/2 GiB，存储至少保留 20% 空闲及一次完整蓝绿代、快照所需空间。宿主机和故障域丢失的 HA 承诺仍在 P6。

三个 peer 的 REST 和内部 6335 通信均启用 TLS。API 使用只读 key，worker 使用写入 key，备份身份单独受控；管理端口不向公网发布，示例 gateway 只绑定宿主机 loopback。gateway 透传 TLS，证书 SAN 必须覆盖客户端实际访问名称以及所有 peer 名称。正式 CA、私钥和所有口令由 secret 管理系统提供，禁止提交到仓库。配置只接受证书校验，不提供跳过验证开关，Qdrant 请求拒绝重定向。

生产镜像通过 `deploy/vector/Dockerfile` 构建：固定官方 1.14.1 引擎 digest，更新 Debian 安全包，仅复制服务端和配置，不包含 Qdrant Web UI。构建后扫描并记录结果镜像 digest，正式部署用 `VECTOR_QDRANT_IMAGE` 指定不可变引用；每次重新构建都需重新扫描，不能沿用历史零漏洞结论。gateway 使用带 CA/主机名验证的 TLS 健康探测和 Docker DNS 刷新；节点中断存在数秒发现窗口，应用仍按 D-008 处理窗口内失败。非 Docker 部署应替换 resolver 为实际私网 DNS。

Qdrant 和 worker 均使用 UID/GID 1000 运行。新命名卷继承镜像目录权限；从 root 运行的旧 Qdrant 迁移时，逐节点停止后由受控初始化身份将该节点 storage/snapshots 卷所有权迁移到 1000，再启动并确认副本就绪，禁止直接递归修改共享宿主机目录。

`VECTOR_SECRET_DIR` 内提供 `qdrant-api-key`、`qdrant-read-key`、`ca.crt`、`tls.crt`、`tls.key`。Worker 另需 `postgres-password`、`jwt-key`、`admin-password`、`fernet-key`、`worker-token`，文件应仅对指定运行身份可读。生产使用每节点独立证书；示例共用文件只是准生产目录约定。`*_FILE` 与对应明文环境变量不能同时配置；运行时只在内存读取，不回填进程环境。Fernet key 必须与 API 及备份数据匹配，不能重启时重新生成。

Compose 文件型 secret 保留源文件权限；worker UID 1000 必须能读取所挂载文件，不能假设 Compose 的 secret 声明自动修复所有权。共享给节点/worker 的演练文件可按受控运行组授予 0640；独立 PostgreSQL TLS 私钥按数据库身份设为 0600。证书须包含标准 SKI/AKI、CA BasicConstraints/KeyUsage 与正确 SAN，不能靠放宽 TLS 验证兼容不完整测试证书。

```sh
docker compose -f deploy/vector/compose.yaml config --quiet
docker compose -f deploy/vector/compose.yaml up -d
docker compose -f deploy/vector/worker-compose.yaml config --quiet
docker compose -f deploy/vector/worker-compose.yaml up -d
```

`VECTOR_RUNTIME_ENV` 是外部非敏感配置文件，至少指定真实 `QDRANT_URL=https://vector-gateway:6333`、PostgreSQL 地址、库名、运行账号、`UPLOADS_DIR=/app/uploads`。API 使用同样 CA/3/3/2 参数及 read key。PG 使用 `PGSSLMODE=verify-full` 与 `PGSSLROOTCERT`；由数据库管理员创建非 superuser 业务账号，迁移单独使用迁移身份。对象存储继续使用管理员加密配置，S3/Qiniu 使用私有 HTTPS 和限制到文档命名空间的身份。不得把测试存储或测试模型写成生产默认配置。

解析器运行在 worker 的非 root、只读根文件系统、CPU/内存/PID 限制内，临时目录有容量上限。生产节点必须限制 worker 出网到已批准模型/对象存储和数据库，不允许文档解析触达任意内部服务。部署覆盖已有集群策略时，adapter 拒绝改变旧 collection；先重建，验收后切换。

## Worker

`/live` 仅反映进程存活；`/ready` 和兼容的 `/health` 反映 PG/Qdrant 依赖及停止状态。依赖中断不应触发无休止的存活重启。非 loopback 监听必须同时配置管理 TLS 与至少 32 字节 token，所有管理路径都需 `Authorization: Bearer ...`。Compose worker 关闭继承自 API 的错误健康探测；由编排平台/监控使用鉴权 TLS 探测配置存活与就绪。token 不得放命令行；HTTP 客户端从受保护文件读取。

`/operations` 与 `msp-vector-worker status` 展示队列和最多 100 条失败任务、100 个 generation 的安全元数据；不返回原文、对象 URI、向量、模型凭据或 ACL。范围更大时使用有审计的数据库只读查询，不把这个有界列表当完整导出。多个实例共享同一队列，dashboard 对数据库 gauge 用 `max`，不重复求和。

积压先看 oldest wait、pending/dead、expired lease、分阶段 P95、embedding 和对账失败，再检查数据库/模型/对象存储。不要修改租约 owner/attempt 或直接删除 outbox。停止实例会取消外部任务；租约到期后其他实例可接管，确定性 point ID 与提交围栏避免重复发布。滚动时一次只停一个实例，确认接管与队列收敛再继续。

```sh
msp-vector-worker status
msp-vector-worker retry-job --job JOB_UUID --actor ADMIN_UUID --evidence-sha256 INCIDENT_SHA256
msp-vector-worker retry-job --job JOB_UUID --actor ADMIN_UUID --evidence-sha256 INCIDENT_SHA256 --apply
```

`retry-job` 只接受失败/dead 且当前仍有效的任务；重试仍经过原有权限、版本、租约检查。actor 必须是当前有效管理员；运维 CLI 本身只允许受控服务账号/堡垒机运行，禁止向用户直接开放。变更和 `resource_operations_audit` 在同一事务提交。审计只记录 actor、动作、目标、时间、证据摘要；审计库写入权限限服务身份，审计查询限值班/安全人员。

## 发布与回滚

显式 rebuild 保留旧代服务，新代构建完整后进入 `ready`，不会自动替换生产索引。先冻结质量报告、核对向量契约和完整对账，再计算报告 SHA-256，作为 promote 的验收记录。报告由受控审批流程保存，摘要不是报告内容或审批人的替代物。

```sh
msp-vector-worker rebuild --knowledge-base KB_UUID
msp-vector-worker rebuild --knowledge-base KB_UUID --apply
msp-vector-worker reconcile --generation GENERATION_UUID
msp-vector-worker promote --generation GENERATION_UUID --actor ADMIN_UUID --evidence-sha256 REPORT_SHA256
msp-vector-worker promote --generation GENERATION_UUID --actor ADMIN_UUID --evidence-sha256 REPORT_SHA256 --apply
```

promote/rollback 默认 dry run，切换前都必须完成无 missing/mismatched/extra 的对账。事务再次核对当前 active 模型、当前文档 manifest 和任务完成状态。旧代保留 7 天；rollback 仅允许保留期内、模型仍 active、包含所有当前有效文档且无竞争构建的旧代，不能借回滚恢复已删除/撤权内容，也不能借运维命令激活另一个模型。命令为 `rollback --generation OLD_UUID --actor ADMIN_UUID --evidence-sha256 REPORT_SHA256 --apply`。新增资料使旧代不完整时拒绝回滚，重新 rebuild。

升级先备份，使用不可变镜像 tag/digest，运行 forward migration，再滚动 worker 和 API。不要自动 down migration。`0022` 增加发布审批门与运维审计；回退旧二进制会绕过待验收门，因此存在待发布 generation 时禁止直接回退到 P3 worker，应先停止构建、保留数据并恢复经过验收的 P4 镜像。

## Recovery

D-009 本地演练基线：每天一次完整加密备份，RPO 24 小时；在 10 万向量基线内，以 60 分钟为恢复目标，实际耗时必须测量。PG/对象是业务真相，Qdrant point 可重建。更严格业务 RPO 需另外配置 PG WAL/PITR 和对象版本复制。备份保留 30 天，每月恢复抽查一次；异地加密副本与解密身份分别保管，不在同一故障域。

备份前停止 API、worker 和对象写入，记下开始/结束时间，再采集 PG custom archive、私有对象文件完整导出、每个 Qdrant 节点的 collection snapshot。分布式 collection snapshot 是节点本地快照，不能仅备份负载均衡命中的一个节点，也不能把单节点 full-storage snapshot 当集群灾备。备份工具要求逐节点 HTTPS 地址，SHA-256 清单和 age 加密覆盖整个 bundle。

```sh
python3 scripts/vector-backup.py backup --bundle /secure/backup.age --objects /private/object-export --nodes https://peer1:6333 https://peer2:6333 https://peer3:6333 --api-key-file /run/secrets/backup-key --ca-file /run/secrets/ca.crt --recipients-file /run/secrets/age-recipients --writers-stopped
python3 scripts/vector-backup.py verify --bundle /secure/backup.age --identity-file /run/secrets/age-identity
python3 scripts/vector-backup.py restore --bundle /secure/backup.age --identity-file /run/secrets/age-identity --objects /isolated/uploads --writers-stopped --empty-target
```

依赖 Python 3、匹配主版本的 PostgreSQL 客户端、age。连接用 `PGSERVICE`/`PGPASSFILE`/`PGDATABASE`，恢复必须明确隔离目标 `PGDATABASE`；禁止把带口令连接串写命令行。明文临时目录必须在受控加密磁盘上，Linux 模式 0700，Windows 需预先设置私有 ACL；成功失败均删除临时明文。S3/Qiniu 须先导出与停写时刻一致的完整私有对象及版本记录，并在恢复时回到相同命名空间；本工具不声称自动管理云厂商版本/跨区复制。

恢复拒绝非空业务数据库和非空对象目录。先恢复对象，再单事务恢复 PG。恢复匹配的 Fernet key、私有存储配置与管理员 active 模型后，保持向量读取关闭，重新建立 Qdrant 集群并对知识库执行 rebuild，核对维度、metric、payload index、manifest/hash、数量、授权和引用；验收后 promote，再开放读写。快照恢复可按 Qdrant 官方流程逐节点执行，不能替代业务真相复核。任一步失败保持隔离，禁止在不完整恢复目录上开启服务。

## Faults

| 故障 | 用户行为与处置 |
|---|---|
| Qdrant 断开 | 查询回退 FTS；worker 有界重试；恢复后对账清零，验证当前引用 |
| embedding 中断 | 查询回退 FTS、入库有限退避至 dead；不替换管理员模型 |
| rerank 中断 | 回退融合结果，不输出供应商错误原文 |
| 对象存储中断 | 新任务失败/重试，已授权 PG 文本可继续读取；不跨存储回退 |
| PG 中断 | 最终鉴权失败关闭，禁止返回缓存或向量原文；恢复后再对账 |
| worker 停止 | API 接收受 1000 槽背压约束；租约超时由另一个实例接管 |

每类演练记录故障开始、告警触发、用户结果、恢复和对账结束。恢复演练必须同时验证普通用户与撤权用户，不能只核对向量数量。

## 监控与审计

导入 `deploy/vector/dashboard.json`，挂载 `alerts.yaml` 为 `/etc/prometheus/vector-alerts.yaml`。`prometheus.yaml` 给出 TLS/token 采集配置，正式部署替换私网目标并接入已有 Alertmanager。API 指标经现有受控 TLS 代理导出，不新增公网指标入口。Prometheus/Grafana/Alertmanager 运行身份和访问控制沿用现有监控平台。

覆盖 queue/outbox/dead/expired lease、分阶段延迟、降级、对账、容量和质量探针。主机容量告警依赖 node-exporter 的真实挂载点，必须按部署调整 `/var/lib/qdrant`。正文、query、完整错误、用户 ID 等不进入 metric label。入库审计日志把 HTTP request ID 与 job ID 关联，worker trace 用 job ID + attempt 关联解析、模型、向量及提交；集中日志按相同 job ID 查询。生产日志采集应加密传输、限制访问并按保留策略清理。

告警接收器尚须按实际组织的接收渠道配置；没有真实告警投递/确认回执时不得标记值班交接完成。审计记录保留默认 90 天，导出到受控审计存储后由运维执行到期销毁，不在普通任务清理中删除。

## Quality

`scripts/vector-quality-probe.py` 是生产巡检工具，使用私有冻结 JSON（1-20 条 `query` 与 `expected_resource_ids`），调用正式鉴权搜索及引用接口，要求无降级、Recall@5 >= 0.90、逐条引用身份和 hash 匹配。token 从文件读取，输出只有数值指标，不输出 query、结果正文、token 或 ID。用短期专用低权限巡检账号 token，不硬编码登录信息。由现有调度器每日运行，输出到 node-exporter textfile 目录；失败/过期规则会触发告警。它是轻量在线探针，不替代 P5 的代表性质量评估。

P5 新增 `scripts/vector-quality-evaluate.py`，按独立标注、摘要冻结的私有数据集生成 Recall/MRR/nDCG、引用、授权白名单、检索空结果及正常/降级分组报告。使用方式、退出码、样本格式见[质量评估手册](vector-quality-evaluation.md)。当前已完成工具与原创合成材料的真实 PG/HTTP、Mock 向量依赖验证；Tutor 无答案、真实模型质量和容量 SLO 需分别验收，不据此自动 promote generation。

## Capacity

先确认是否容量不足，再增加并发；并发会同时放大 PG 连接、模型费用和 Qdrant 内存占用。默认两个 worker 总并发 4，每实例 PG pool 不超过 12。达到 20% 磁盘余量、持续 backlog 或 P95 超标时停止新增容量，保留 FTS 降级，执行 P5 负载评估。生产容量/SLO 只能引用相同拓扑、数据量、模型和负载的实测结果。

## 凭据轮换

只读 API key 与写 key 分离。新 key 先在受控节点/代理建立窗口，滚动更新对应 API/worker secret 并验证，最后撤销旧 key。Qdrant 静态 key 轮换需要逐节点重启或受控 JWT/RBAC 方案，不承诺单个字段同时接受两把 key。证书必须保留有效 SAN/CA 链，REST 可按 cert TTL 重载，peer TLS 通过逐节点重启更新。Fernet key 轮换须事务重加密全部已保存渠道/存储凭据并备份旧 key；本阶段不提供直接替换 key 的捷径。

官方契约：[Qdrant 1.14.1 配置](https://github.com/qdrant/qdrant/blob/v1.14.1/config/config.yaml)、[分布式部署](https://qdrant.tech/documentation/operations/distributed_deployment/)、[快照](https://qdrant.tech/documentation/operations/snapshots/)。
