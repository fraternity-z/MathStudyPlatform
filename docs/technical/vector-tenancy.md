# 小范围部署的资源租户边界

本阶段使用同一 PostgreSQL 和同一 Qdrant 实例，知识库各自独占 collection。没有跨区域、集群分片或租户管理界面；管理员通过受控数据库变更管理成员、部门、ACL 和额度。

## 身份与授权

迁移 `0025_resource_tenancy.up.sql` 给现有用户补齐默认租户成员关系；新用户通过 `resource_default_membership` 触发器加入默认租户。建立独立租户时，应显式添加需要的成员，并按需要移除默认成员关系。全局 ADMIN 身份本身不能跨租户读取或修改资源。

`tenant_memberships` 的 active 状态、有效期，以及用户/租户的 active 状态共同决定有效成员关系。`valid_until`、ACL 的 `valid_from`/`valid_to` 按项目既有 UTC 无时区时间约定存储；比较使用 `statement_timestamp() AT TIME ZONE 'UTC'`，截止时间相等时已失效。

`resource_kb_access` 统一计算 user、role、tenant、owner、department 的组合授权，匹配的 deny 优先于 allow、owner 和旧 content_acl。部门必须属于同一租户且 active，并有明确部门成员记录；无关部门的 deny 不影响用户。role 使用用户现有角色，但必须先通过目标租户成员校验。已有默认知识库为教师保留 publish、管理员保留 manage 权限。

`0028_resource_access_decisions_and_tenancy_audit.up.sql` 增加 `resource_kb_access_decision` 和 `resource_content_access_decision`，返回 `allowed`、稳定原因码及租户/知识库上下文，用于受控 SQL 排障和授权解释。原 `resource_kb_access`、`resource_content_access` 布尔谓词继续作为业务查询兼容入口；可解释结果不作为普通 HTTP API 开放，也不能由客户端据此扩大访问范围。

检索范围从当前用户和知识库解析 tenant、generation、collection，不接受客户端租户或索引路由。召回、最终内容授权、引用及邻居读取共用当前 SQL 权限条件。旧资源列表、详情、统计、收藏和修改也执行 `resource_content_access`；无文档的历史公开资源仍向同租户成员开放，知识库 deny 继续生效。入库文档还必须具备有效文档和知识库成员关联。

数据库以复合外键约束知识库、资源、文档、版本、分块、manifest、generation 和 job 的租户关系；collection 名称全局唯一。当前采用应用入口和统一 SQL 函数授权，没有启用 PostgreSQL RLS，数据库账户属于受信服务边界。

`resource_tenancy_audit` 只记录租户成员、部门、部门成员、知识库 ACL、资源知识库关联以及租户状态/额度六类白名单配置变更。审计中的 `session_user`、`current_user` 是数据库身份，不等同应用用户 actor；应用层人员归因仍使用既有业务审计。当前服务账号必须视为可信账号，尚未拆分普通应用、后台 worker 与运维角色，也没有 RLS 作为数据库内第二道隔离。

## 上传、后台任务与额度

文档上传 multipart 可选 `knowledge_base_id`，省略时保持默认知识库。目标知识库的 publish 权限在暂存登记和最终登记时再次验证。存储键包含用户、知识库、客户端请求 ID 和文件校验和；登记幂等键按知识库与创建者隔离。

后台 worker、reconcile、清理和运维快照覆盖全部租户，并保持 job/version/generation 的同租户连接与 lease fencing。带 actor 的运维修改还需目标知识库 manage 权限，并写入既有审计表。运维快照和无 actor 的重建接口仅供受控后台/CLI 使用，不能作为公共 HTTP 接口开放。

失败任务和 generation 运维读模型显式携带 tenant 与 knowledge base 上下文；重试查询按 generation ID 和 tenant ID 关联任务，再检查该 generation 所属知识库的 manage 权限。

租户默认上限为 10,000 份未删除入库文档、5 GiB 登记源文件字节、100 个活跃入库任务；分别由 `tenants.resource_document_limit`、`resource_byte_limit`、`resource_job_limit` 配置。存储字节包含已软删除但仍保留的源文档。暂存上传也占用租户任务额度。全局 1,000 个任务/暂存上限仍保留。额度检查与登记共享短事务锁，避免并发争用最后额度；幂等重试不重复扣额度。

额度不计历史外链资源，也不是物理磁盘/向量存储用量计量；重建和修复不按新文档重复计费。资源返回 `INGESTION_QUOTA_EXCEEDED`（429）、无目标知识库权限返回 `INGESTION_FORBIDDEN`（403）。

## 授权解释与审计增量（2026-09-18）

在受控数据库会话中，可使用参数化查询 `SELECT * FROM public.resource_kb_access_decision($1,$2,'read')` 或 `SELECT * FROM public.resource_content_access_decision($1,$2,'read')` 排障；前两个参数分别是用户 ID 和目标 ID。`allowed` 调用既有布尔授权函数取得，解释分支不参与线上召回热路径。有效 permission 仅为 `read/publish/manage`，其他值（含 NULL）拒绝。资源解释的 `knowledge_base_ids` 表示受阻的知识库范围，不是用户可读知识库列表。函数只解释 ACL，不替代调用方对发布、删除、版本和 manifest 的校验。

审计保留白名单字段的变更前后值，UPDATE 白名单值未变则不新增记录；租户表只审计状态和额度的 UPDATE。部门名称等非白名单字段不保存。记录与原变更同事务，删除主体不级联删除审计；数据库 owner/superuser 仍可改表或停用触发器，不能据此宣称审计不可篡改。部署前先备份，再使用正式迁移入口应用 `0028`；回退使用备份和匹配应用版本，不手工移除仍被调用的函数。

`0028` 的空库迁移、升级、授权原因码、原布尔谓词兼容、六类审计触发器以及失败任务/代际的同租户运维关联已完成本轮验证，证据汇总见[授权隔离验收](../plans/resource-center-qdrant/TEST-P6-AUTH-2026-09-18.md)。该结论只覆盖本轮授权解释、审计和运维查询切片；RLS、数据库角色拆分、完整跨租户矩阵及 P6 其他高级能力仍在开发或验证中。

## 本地验证证据（2026-09-16）

独立 PostgreSQL 18 实例仅监听 `127.0.0.1:55436`，测试数据库 `tenant_verify_complete`，本地测试账户 `postgres`，测试实例使用 trust，不涉及正式数据库。数据目录 `.tmp/vector-p6-tenant-pg`。全部 `0001` 至 `0025` 迁移使用单事务在空库执行成功。

临时测试 `TestP6TenantIsolation` 在事务内创建两个租户，退出 rollback；真实执行注册、幂等重试、两个租户的后台领取/分块/完成/发布、范围解析、关键词召回与最终授权。验证跨租户上传/范围/详情/收藏拒绝，全局管理员无成员关系拒绝，列表隔离，无关部门 deny 不误拒、匹配部门 deny 和 user deny 优先、未来 deny 尚未生效、成员暂停与 UTC 有效期失效、文档/字节/暂存额度拒绝、暂存幂等、过期上传清理、运维写入拒绝、复合外键拒绝跨租户关联、撤下发布后无法再次返回内容。

临时 Mock `TestP6TenancyQueryFailure` 验证权限和额度查询失败时拒绝继续。运行 `go test ./internal/adapter/postgres -run TestP6Ten -v -count=1` 通过；新增 `resource_tenancy.go` 两函数语句覆盖率均为 100%，整个 PostgreSQL 包本次定向覆盖率为 7.8%，不代表全库覆盖率。覆盖文件保存在忽略目录 `.tmp/p6-tenant.cover`。测试源文件按项目规则在验证后删除、不提交。

回退应使用部署前数据库备份和匹配的应用版本；不要先删除授权函数再运行本版本应用。当前只提供正向迁移。

## 终审补充（2026-09-16）

粗召回、关键词召回和最终分块授权统一调用 `resource_content_access`，资源通过其他 active 知识库关联继承的 deny 同样生效。公共重试请求在 `CanRetry` 判断之后、创建 generation 之前，于入库事务锁内检查租户队列额度与全局 1,000 上限；未引用的暂存上传占位一并计入，既有文档及源文件字节不重复扣除。pending/running 的幂等重试直接返回。受控后台 rebuild、reconcile、purge 属于运维批量任务，不套用公共请求入队额度，不应因新文档额度限制而阻塞删除或修复。

临时 `TestP6ClosePostgres` 在上述本地数据库事务中验证：主知识库允许、第二 active 关联知识库 deny 时，粗召回、关键词和最终授权均拒绝；删除 deny 后均恢复。租户任务上限 1 时，A 失败、B 占槽导致 A 重试返回 `ErrIngestionQuotaExceeded`，B 终态后 A 重试成功，再次请求保持幂等；文档/字节额度已满不阻止重试。暂存占位和全局 1,000 上限也真实拒绝。事务退出 rollback。`TestP6CloseQuotaMock` 覆盖查询失败、租户满、全局满和允许分支；新增 `checkIngestionRetryQuota` 语句覆盖率 100%。定向测试与 `go build ./...` 通过，日志及覆盖文件位于 `.tmp/p6-close-validation.log`、`.tmp/p6-close.cover`；临时测试源已删除。
