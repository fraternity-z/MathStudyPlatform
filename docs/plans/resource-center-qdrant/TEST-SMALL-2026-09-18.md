# 小范围向量核心回归验收（2026-09-18）

结论：当前版本的小范围核心流程通过。本轮未发现必须修改的生产代码问题，仅校准部署、迁移与进度文档；不继续扩展原 P6 高级能力。

## 环境与边界

- 全新隔离 PostgreSQL 18、单节点 Qdrant 1.14.1，使用一份原创 TXT、一个 chunk。
- 正式 HTTP handler、PostgreSQL repository、解析/切块、worker、Qdrant adapter、检索和引用实现；对象存储使用正式本地 RuntimeManager/LocalStorage。
- 文档与查询 embedding 使用固定二维 Mock。HTTP Bearer 解析与角色门禁使用正式 handler，Authenticator 返回固定教师 Principal；未复测 JWT 签名、数据库会话状态或真实模型语义质量。
- 属于小数据功能 smoke，不代表容量、长期稳定性、HNSW 大规模召回或生产部署验收；未执行本轮 generation 全量 reconcile。

## 实跑结果

| 项目 | 结果 |
|---|---|
| 空库执行当前迁移 | `0001`–`0028`，`applied_count=28` |
| 重复执行迁移 | `applied_count=0` |
| HTTP TXT 上传 | 返回 202 |
| worker 入库、collection/索引初始化、向量写入 | 成功，文档 published，1/1 chunk |
| hybrid 相似度检索 | 命中唯一正文 |
| 引用读取 | HTTP 200 |
| 错误维度 collection 契约 | `ErrVectorInvalid`，拒绝不兼容 schema |
| Qdrant 不可达 | `fts_only`、`vector_unavailable`，仍返回一条词法结果 |
| 撤回后的旧引用 | HTTP 404 |
| purge | 该资源向量点数为 0 |

后端工作目录中执行临时 `TestSmallLiveVectorHTTPClosure`，最终日志为 PASS（2.45 秒）；定向 qdrant、application/resource、postgres、http/resource 包检查通过，其中前三个包无持久测试文件，不作为新增功能覆盖证据。`go build ./...` 通过。测试源码依项目规范在验证后删除，不报告未经测量的覆盖率。

本地脱敏证据保存在忽略目录 `.tmp/small-vector-live-20260918/logs/` 的 `acceptance.log`、`related-tests.log`、`go-build.log`；不包含真实模型凭据或真实教学材料。

## 非关键问题与清理

- Windows 原生 Qdrant 在深层 `.tmp` storage 创建 collection 时返回 `os error 3`；换用本轮全新短路径 `C:\qv-small-20260918` 后通过。原生小范围测试应使用短数据目录，本轮不扩展宿主机路径策略改造。
- 测试夹具曾因 pgx 不接受多语句 prepared statement 失败，拆分参数化调用后通过；未修改生产实现。
- PostgreSQL 和 Qdrant 已停止，25432/26433/26434 端口无监听；退出前 Qdrant collection 数为 0，临时 Go 测试源码已删除。
- 自动审批策略拒绝递归删除本轮隔离数据目录，未重试或绕过。`.tmp/small-vector-live-20260918` 的 PG/Qdrant/上传 fixture 和 `C:\qv-small-20260918` 仍有物理残留，只占本地磁盘，不参与应用运行或 Git 交付；不把清理受限列为核心功能失败。

RLS、角色拆分、多集群、分布式扩展、弹性伸缩及其他原 P6 高级项暂缓，保留原任务计数和 M6 状态，不以本次 smoke 宣称全部高级能力完成。
