# P6 小范围向量隔离验证

2026-09-16，本轮独立验证现有 Qdrant adapter 与 `VectorRetriever`，未修改业务实现。范围为单节点、小样本租户与知识库隔离，不包含高可用、跨区域、容量或真实模型质量验收。

## 环境

- Docker Desktop Linux engine named pipe 不存在，无法使用容器；项目和用户 `.cache` 中未找到现成 Qdrant 二进制。
- 从 [Qdrant 官方 v1.14.1 release](https://github.com/qdrant/qdrant/releases/tag/v1.14.1) 下载 `qdrant-x86_64-pc-windows-msvc.zip`，运行版本 `1.14.1` / build `530430fa`。下载文件 SHA-256：`52f3e58a73709b81f13b035fac144089b7317da259ae2e6e71c949c536081854`。
- 实例仅绑定 `127.0.0.1`，HTTP `16343` / gRPC `16344`，分布式模式关闭、遥测关闭。数据与程序均在专属 `.tmp/p6-vector-isolation-20260916`，未读取正式密钥或访问业务集合。
- QueryEmbedder 为 Mock，固定二维 `[1, 0]`；manifest resolver 为 Mock，不将本轮称为真实 PostgreSQL 权限验证。

## 已通过场景

| 验证 | 证据与结果 |
|---|---|
| 真实 Qdrant + 正式 adapter + 正式 VectorRetriever | 两个租户，各自随机 UUID 知识库和 generation，使用规范 `resource_<KB UUID 无连字符>_<generation UUID 无连字符>` collection |
| 同正文、同向量隔离 | 每个 collection 写入 8 个 `[1, 0]`，正文均为“相同正文”；1 个有效点，另外 7 个分别污染 tenant、KB、generation、model、visibility、resource、index_generation；每次仅返回当前 scope 的 1 个有效候选 |
| 请求 filter 与 endpoint | loopback HTTP Mock 检查 tenant_id、knowledge_base_id、generation_id、published 与 resource allowlist，collection 路由和 9 字段 payload 投影均符合契约 |
| 错误 payload 拒绝 | tenant、KB、generation、model、resource、visibility、index_generation 错误，以及无效 chunk/version UUID，均不产生候选，也不会进入 manifest resolver |
| manifest 最终身份校验 | 缺失 manifest 或 chunk/resource/version/generation/model 不匹配，均不产生候选；这是仓储端口 Mock 故障注入，非 SQL 集成 |
| 现代/兼容 endpoint | 两个租户分别通过现代 query 与 query 404 后 legacy search 回退；上述有效/错误组合合计 64 个子场景 |

## 命令与清理

临时入口：`TestP6RealQdrantIsolation`、`TestP6VectorBoundary`；真实实例测试要求显式环境开关 `P6_VECTOR_LOCAL=1`。

```text
go test ./internal/adapter/qdrant -run 'TestP6(RealQdrantIsolation|VectorBoundary)' -count=1 -race -v
ok mathstudy/backend/internal/adapter/qdrant 3.846s
```

真实 Qdrant 子测试通过，耗时约 0.30 秒；64 个故障注入子场景全部通过，未产生模型调用。没有据此声称大包/全仓覆盖率达到 80%。

结束时通过测试 cleanup 删除两个本轮 collection，查询该隔离实例 collection 数量为 0；按确切可执行路径停止本轮 Qdrant 进程。临时 Go 测试源码已删除，未暂存或提交任何文件。

自动审批拒绝删除已停止实例的专属 `.tmp/p6-vector-isolation-20260916` 目录，理由为 `blocked by policy`。未绕过或重试，程序、压缩包和空集合实例的存储残留仍在该忽略目录，不参与交付或应用运行；物理清理未完成。

本轮不单独运行全仓构建，业务实现没有变化；总体构建及 PostgreSQL 多租户端到端验收由主任务合并验证。
