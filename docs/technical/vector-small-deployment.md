# 向量检索小范围上线与维护

本手册面向单站点、小范围上线。用户已明确无需跨区域部署；跨区容灾、共享 shard、多集群不是此次上线前置条件。继续使用每个知识库、每个 generation 独占的 collection，以及现有 PostgreSQL、私有对象存储、Qdrant 和 worker。已有 P4 本地故障、备份恢复验证仍有效，但只适用于其原有测试条件，不能外推为宿主机故障容灾承诺。

现有 [P4 运维手册](vector-operations.md) 和三 peer 演练配置保留供参考；本手册不要求为了小范围上线新增多区域基础设施，也不直接修改已有 collection 的分片、副本契约。缩减拓扑须先匹配实际部署参数并单独验证。shadow 流量、双写、按比例灰度和零停机跨模型切换尚未实现，不作为当前能力描述。

## 上线前检查

- 记录应用镜像或提交、数据库迁移版本、知识库 UUID、当前模型版本 UUID/revision、generation UUID 和 collection 名称。迁移按应用版本向前执行，保留上一可用镜像，不自动执行 down migration。
- 确认 API、worker 使用匹配的 PostgreSQL、Fernet key、私有对象存储和 Qdrant 配置；API 使用只读向量凭据，worker 使用写入凭据。密钥由受保护文件或既有加密配置提供，不放命令行、文档或 Git。
- 保留当前独占 collection；确认新代和旧代并存、快照及恢复需要的磁盘空间。worker 并发先沿用已验证设置，以实际队列、延迟和模型费用判断是否调整。
- 验证 API 登录、普通用户检索和引用、无权用户拒绝访问、worker `/ready`、队列及对账。管理端口仅受控访问；非 loopback 监听须使用 TLS 与 token 文件。
- 完成一次可解密备份及隔离恢复检查，并记录实际恢复耗时。P4 的 RPO/RTO 是原演练基线，不是此次实际部署的自动验收结果。

下文命令在加载正确部署配置的受控终端运行。`msp-vector-worker` 是现有部署二进制名称（源码入口 `backend/cmd/vector-worker`）；全部 `*_UUID` 替换为规范小写 UUID，`REPORT_SHA256` 替换为已保存验收记录的 64 位小写十六进制 SHA-256。示例不包含真实身份或凭据。

## 模型维护切换

模型激活与索引发布是两个动作。管理员激活新 `resource_embedding` 版本会立即退休旧 active 模型；`QueryEmbedder` 只读取当前 active 模型，并要求它与检索代的模型版本、维度和距离契约一致。因此，从新模型激活到新代 promote 之间，仍使用旧模型的知识库会降级到 `fts_only`，已有旧代的已授权全文检索仍可用。该行为以 PostgreSQL/FTS 正常为前提。全局模型激活会影响所有仍引用旧模型的知识库，应逐库完成重建与验收。

同一不可变模型版本下 rebuild 不会产生上述模型身份不匹配；旧代继续服务，新代在 `ready` 等待发布。依赖故障仍可能触发现有降级。

1. 安排维护窗口，暂停资料上传、替换、发布、删除及其他内容变动，等待现有入库任务收敛。暂停由现有运维入口或访问控制落实，CLI 不提供自动维护开关。紧急撤权仍须立即生效，之后重新评估回退资格。
2. 保存旧模型完整配置、revision、版本 UUID、旧 generation UUID 和备份。保留旧模型及渠道记录不变；为新模型准备独立配置，避免修改旧模型依赖的来源记录。模型/渠道更新时间也是身份校验的一部分，即使字段改回原值，也不能假定旧版本可再次激活。
3. 在管理员模型界面先 test，再 activate 新 embedding 配置，确认激活结果。activate 本身也会重新探测来源。只做同模型重建时跳过模型激活。
4. 对每个受影响知识库先检查 rebuild 输出的模型版本，再实际建立新代，并记下返回的 `generation_id`：

```sh
msp-vector-worker rebuild --knowledge-base KB_UUID
msp-vector-worker rebuild --knowledge-base KB_UUID --apply
msp-vector-worker status
```

`rebuild` 不带 `--apply` 只解析当前模型并报告，不验证知识库全部构建条件，也不创建任务。`--apply` 后须有正常运行的 worker 消费任务。`status` 是全局只读快照，最多显示 100 个 generation 和 100 条失败任务；按返回的知识库和 generation 身份确认目标，不把列表缺失当作构建完成。

5. 等待目标 generation 为 `ready`，排除 dead/failed 任务和未完成构建，然后执行完整对账：

```sh
msp-vector-worker reconcile --generation NEW_GENERATION_UUID
```

只有报告完整且 missing/mismatched/extra 全为 0 才可继续。若发现差异，先定位依赖或任务故障；需要现有修复机制时可用 `reconcile --generation NEW_GENERATION_UUID --apply`，等待修复任务收敛后重新只读对账。不能把一次修复请求成功当成已经对账清零。

6. 在隔离验证或受控验收中核对新模型质量、文档覆盖、引用身份和权限，保存报告及摘要。正式搜索入口仍使用当前已发布代，不能把维护期间旧代的 FTS 结果当作新代向量质量证据。质量方法见[质量评估手册](vector-quality-evaluation.md)。之后先预检再发布：

```sh
msp-vector-worker promote --generation NEW_GENERATION_UUID --actor ADMIN_UUID --evidence-sha256 REPORT_SHA256
msp-vector-worker promote --generation NEW_GENERATION_UUID --actor ADMIN_UUID --evidence-sha256 REPORT_SHA256 --apply
msp-vector-worker status
```

promote/rollback 的 CLI 预检会验证 collection 和完整零差异对账，但不执行数据库切换事务，不能保证 `--apply` 一定成功。实际事务还检查有效管理员及知识库管理权限、模型仍 active、目标状态、竞争构建和当前文档完整性，并原子写入审计。证据摘要不代替报告本身。

7. 确认目标为 `active`，用普通用户验证检索恢复、引用正确、无权用户仍被拒绝；观察降级、队列、错误和延迟后恢复内容变动。记录维护起止和实际 FTS 降级时长。

## 回退检查

已发布新代后，旧代从退休时起保留 7 天，`status` 返回 `retain_until`。回退只适用于仍在保留期的 `retired` 代；它必须包含所有当前有效文档，无其他 `building`/`ready` 竞争代，并通过完整零差异对账。内容新增、替换、删除或撤权可能使旧代不再合格，保留 7 天不等于保证 7 天内任意时刻均能回退。

跨模型回退先在管理员界面按保存的旧配置 test/activate，确认激活的是原旧模型版本 UUID，再运行下列命令；rollback 不会代为激活模型。旧模型、渠道或契约被修改后，同 revision 重新激活可能被拒绝；换一个 revision 会产生不同身份，不能让旧代满足模型检查。此时保留 FTS/维护窗口，按可用配置重建并重新验收，禁止直接改数据库状态绕过门禁。

```sh
msp-vector-worker reconcile --generation OLD_GENERATION_UUID
msp-vector-worker rollback --generation OLD_GENERATION_UUID --actor ADMIN_UUID --evidence-sha256 REPORT_SHA256
msp-vector-worker rollback --generation OLD_GENERATION_UUID --actor ADMIN_UUID --evidence-sha256 REPORT_SHA256 --apply
msp-vector-worker status
```

同模型回退不需要重新激活模型。跨模型重新激活旧模型至旧代回退完成之间，新发布代也会出现模型不匹配的 FTS 降级。若新代尚未 promote，旧代仍是 active，不能对它执行要求 `retired` 的 rollback；先恢复旧模型后核验旧代服务，并单独处理失败或未完成的新构建。当前没有取消 generation 的通用 CLI，存在竞争构建时停止回退并排查，不使用臆造命令或手工改状态。

回退后重新验证用户权限、引用、检索模式和队列，再恢复内容变动。无法满足回退条件时从当前业务真相重建；不要借回退恢复已删除或已撤权内容。

## 单站点备份恢复

沿用 [vector-backup.py](../../scripts/vector-backup.py) 的 PG custom archive、私有对象导出、逐节点 collection snapshot、摘要清单和 age 加密 bundle。备份前停止 API、worker 及其他对象写入者；节点列表必须覆盖实际所有 Qdrant 节点。工具接受一个或多个节点，不要求跨区域，也不自动实施云对象版本或跨区复制。

```sh
python3 scripts/vector-backup.py backup --bundle /secure/backup.age --objects /private/object-export --nodes https://peer1:6333 --api-key-file /run/secrets/backup-key --ca-file /run/secrets/ca.crt --recipients-file /run/secrets/age-recipients --writers-stopped
python3 scripts/vector-backup.py verify --bundle /secure/backup.age --identity-file /run/secrets/age-identity
python3 scripts/vector-backup.py restore --bundle /secure/backup.age --identity-file /run/secrets/age-identity --objects /isolated/uploads --writers-stopped --empty-target
```

以上为单节点参数示例，多节点需逐一补齐 `--nodes`。使用 Python 3、匹配数据库主版本的 PG 客户端及 age；数据库连接经 `PGSERVICE`/`PGPASSFILE`/`PGDATABASE` 配置，恢复时明确指向隔离空库。对象恢复目录也必须为空，明文临时文件位于受保护存储，Windows 使用预设私有 ACL。备份文件和解密身份分开保管，至少留一份不依赖运行数据卷的加密备份。

恢复先还原对象和 PG，并恢复匹配的 Fernet key、存储配置和模型来源，保持向量读取关闭；再创建匹配 Qdrant 环境，逐库 rebuild、对账、验收和 promote，最后开放读写。快照不代替 PG/对象业务真相核对。任一步失败保持隔离；实际恢复演练须覆盖普通用户与撤权用户，而不只统计 point 数量。

## 实现依据

- [worker 参数与维护分派](../../backend/cmd/vector-worker/main.go)：命令、作用域、默认只读、rebuild 和有界 status。
- [运维预检](../../backend/cmd/vector-worker/operations.go)及[事务发布检查](../../backend/internal/adapter/postgres/resource_operations.go)：完整对账、管理员、竞争代和审计。
- [generation 生命周期](../../backend/internal/adapter/postgres/resource_ingestion_generations.go)：独占 collection、文档覆盖、ready 审批门及 7 天保留。
- [模型激活仓储](../../backend/internal/adapter/postgres/admin_embedding_repository.go)及[查询 embedding](../../backend/internal/adapter/llm/resourceretrieval/embedding.go)：唯一 active 模型、来源身份校验与查询契约匹配。

本手册核对当前代码契约，不代表已经在真实上线环境执行模型切换或恢复验收；实际执行记录由上线负责人保存。
