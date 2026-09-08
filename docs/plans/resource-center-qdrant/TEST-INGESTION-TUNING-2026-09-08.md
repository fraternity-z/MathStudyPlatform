# P5 入库批处理与背压验证记录（2026-09-08）

本次完成 P5-04 的工程边界验证切片。用户要求收尾当前阶段并停止继续推进，因此固定本次已准备的实验范围；P5-04 与整个 M5 仍未完成，不据此发布生产调优参数。

## 1. 环境、输入与验证口径

- 环境：Windows amd64，Go `go1.25.13 windows/amd64`，当前工作区生产实现。
- 依赖：内存 Mock 仓储、对象存储、解析器、embedding 与向量端口；适配器测试使用 Mock `HTTPDoer`，没有真实模型、数据库或 Qdrant 调用。
- 数据：自行生成中文数学片段、公式及 Markdown 文档；覆盖 1、8、32、33、65、4096 个 chunk，另有 3 个 60000 字节 chunk 和 110001 字节超限 chunk。使用真实确定性切块器处理一篇重复生成的原创中文文档。
- 上传使用 UTF-8 文本、Markdown、PDF/DOCX 魔数，以及伪造魔数、错误 MIME、NUL、非法 UTF-8 等输入。PDF/DOCX 场景只验证上传入口类型识别，完整格式解析属于其他验收范围。
- 向量为确定性三维非零数组，另构造错误维度、错误模型、零向量、NaN、Infinity。模型 ID 和凭据均为测试虚构值。
- 工程调用次数、上下文取消、状态转换与并发上界由断言验证。测试耗时不用于报告模型吞吐、真实资源消耗或生产 SLO。

## 2. 批处理与资源预算

以下每项均运行正式 `IngestionWorker.ProcessOne`；每批 embedding、upsert 与 GetPoints 次数相等，最终执行一次 CountPoints，只有写入确认及逐点身份/载荷验证通过才完成任务。

| active batch | 1 chunk | 8 chunks | 32 chunks | 33 chunks | 65 chunks | 4096 chunks | worker 实际单批上界 |
|---|---:|---:|---:|---:|---:|---:|---:|
| 8 | 1 | 1 | 4 | 5 | 9 | 512 | 8 |
| 32 | 1 | 1 | 1 | 2 | 3 | 128 | 32 |
| 64 | 1 | 1 | 1 | 2 | 3 | 128 | 32 |

表中数字为每种端口操作的批次数。每批 `Wait=true`，对象每次打开后关闭一次；每个成功任务完成一次。64 不会提高当前 worker 批次上限，不建议仅为这条入库链路将 active batch 从 32 调大。

补充预算证据：

- 总输入限制为 **110000 字节**。3 个 60000 字节的重建 chunk 被分为 `[1,1,1]`；单个 110001 字节 chunk 在 embedding 前拒绝，错误为不可重试的 `invalid_document`。
- 重建仓储已经返回可用 chunk 时，未再次读取对象或调用解析器。该断言验证避免重复解析，不代表实际重建吞吐。
- DocumentEmbedder 直接接收 8/32/64 个输入时，各用一次 HTTP 请求；超过对应 active batch 的输入在 HTTP 前拒绝。worker 的 32 上限与适配器的 active batch 上限分开验证。
- dimension=65536、active batch=256 时，适配器实际 batch=16，将每批向量值数限制在 `1<<20`。这是代码预算验证，没有测量 HTTP 解码峰值 RSS。
- 20 个待处理 Mock 任务下，worker 并发配置为 1/2/8 时，实际最大解析并发分别为 1/2/8，仍留在仓储的任务分别为 19/18/12。阻塞解析期间没有提前领取额外任务。
- 6 个同时进入的文档 embedding 调用实际最大 HTTP 并发为 1；请求开始间隔满足配置的 100 ms（测试容忍计时粒度，断言下限 95 ms）。该值属于单进程单 DocumentEmbedder 实例，不是跨副本全局配额。
- 一个文档 HTTP 请求阻塞时，同一 Mock HTTP 客户端上的正式 QueryEmbedder 可完成查询；另一个文档等待者在 30 ms 上下文截止后退出且未发 HTTP。只证明查询不共用文档 slot，不证明共享供应商限流、网络或 Qdrant 负载下的查询 SLO。

## 3. 错误、取消与状态围栏

| 场景 | 实测结果 |
|---|---|
| 对象不可用、元数据 checksum 变化、解析失败、0/4097 chunks | 没有完成任务；按 source/parse 边界返回不可重试分类；成功打开的 reader 关闭 |
| 仓储准备失败、Qdrant upsert/GetPoints/CountPoints Mock 失败 | 没有完成任务；保留可重试失败分类 |
| collection schema 不兼容 | `vector_schema_mismatch`，不可重试 |
| embedding 模型/数量/维度错误，NaN/Infinity/零向量 | embedding_failed；未调用 upsert |
| GetPoints 缺点、错误 ID、重复 ID、generation payload 改变、总数不符 | 未完成任务，进入可重试失败分类 |
| 正常失败转换 | 原 JobID、Owner、Attempt 传回仓储；首次失败下次可用时间延后 10 秒 |
| attempt=99 | 退避上限 1280 秒；保留实际 attempt=99，不在本轮 Mock 中代替数据库裁定 max_attempts |
| completion 失去 lease | lease_lost 增加；不记成功，不另写失败转换 |
| heartbeat 返回失去 lease | 取消解析，lease_lost 增加；不完成/失败覆盖任务状态 |
| job timeout=1 秒 | `processing_timeout`，可重试，任务未完成 |
| 1/2/8 worker 外部取消 | 全部在途任务退出，inflight=0；不写完成/失败终态 |
| purge 成功或 collection 已不存在 | 正常完成，未请求 embedding |
| purge 删除失败或验证残留 | 不完成任务 |
| 上传边界 | 24 个子场景覆盖类型、内容、大小声明、身份、标题、Reader、模型、存储、queue full 和取消 |

上传有效路径验证注册 `QueueLimit=1000`；队列满返回 `ErrIngestionQueueFull`。队列计数和 max_attempts 终态实际由 PostgreSQL 仓储执行，本次不把 Mock 参数透传结果当作数据库并发正确性证据。上传声明超过 50 MiB 被入口拒绝；本轮没有生成 50 MiB 实体文件或测量多个上传的内存峰值。

HTTP 重试结果：429 / 503 在配置重试 10 / 3 时均最多 4 次请求（初次加 3 次重试）；408 配置重试 1 为 2 次；503 配置 0 为 1 次；401 / 400 各 1 次。模型 revision 在重试前变化时，只发初次请求，后续以不可重试 `MODEL_CONTRACT_MISMATCH` 停止。取消停止后续请求；非法成功响应（零向量）不重试。输入为空、空白、NUL、非 UTF-8、非 NFC、超 token 字节估计和超总字节均在 HTTP 前拒绝。

状态围栏测试证明应用层传递 lease 并遵循仓储拒绝结果；真实数据库 owner/attempt/lease 事务条件仍需读取对应集成证据，不使用本报告替代。

## 4. 执行结果与覆盖率

7 个顶层测试函数、**101 个子场景**全部通过；随后同一切片 `-race` 通过。

```powershell
go test ./internal/application/resource ./internal/adapter/llm/resourceretrieval -run TestGoalP5Ingestion -count=1 -v -coverprofile=goal_p5_ingestion_coverage.out
go test -race ./internal/application/resource ./internal/adapter/llm/resourceretrieval -run TestGoalP5Ingestion -count=1
go tool cover '-func=goal_p5_ingestion_coverage'
go build ./internal/application/resource ./internal/adapter/llm/resourceretrieval
```

上述相关包构建也已通过。本次 PowerShell 将未加引号的 `-coverprofile=...out` 参数解析为无扩展名输出，实际覆盖率文件为 `backend/goal_p5_ingestion_coverage`，汇总命令读取该真实文件；后续执行应给整个 `-coverprofile=...` 参数加引号。

| 覆盖率对象 | 语句覆盖率 |
|---|---:|
| ProcessOne | 94.3% |
| process | 93.0% |
| writeBatch | 100.0% |
| complete | 80.0% |
| ingestionEmbeddingHash | 100.0% |
| ingestionPayloadMatches | 87.5% |
| classifyIngestionFailure | 83.3% |
| validateDocumentUpload | 100.0% |
| Upload（含本轮未测的 durable staging 分支） | 63.4% |
| DocumentEmbedder.Embed | 81.1% |
| validateDocumentInputs | 100.0% |
| validateDocumentVectors | 87.5% |
| resource 整包 | 31.6% |
| resourceretrieval 整包 | 54.6% |
| 两包合计 | 35.9% |

只把本次重点函数覆盖率与整包口径分别报告，没有达到整包 80% 覆盖目标。全部测试为临时验证材料；交付仅保留此报告，测试源文件、测试 fixture、覆盖率产物按项目规范清理。

## 5. 参数结论与未完成边界

保持默认 worker 并发 2、active batch 32 的既有配置；现有串行 embedding、110000 字节批次、32 chunks worker 批次、有限重试和 lease 拒绝路径在本轮通过。本次没有调整生产参数或激活模型。

P5-04 剩余事项包括真实目标模型调用成本/吞吐、解析器实际 CPU/内存、Qdrant wait/ordering 性能对比、跨副本背压、重建与在线检索混合负载、backlog age/消化速率和重建专用速率预算。重建目前与普通入库共用 worker，本轮只验证复用 chunk 和文档/查询调用隔离，没有证明重建不会争用数据库、向量或供应商容量。按用户收尾指令保留这些边界，不继续发起实验。
