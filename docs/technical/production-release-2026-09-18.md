# 2026-09-18 生产部署记录

## 发布结果

- 站点：<https://mathstudyplatform.site/>。
- 前后端发布版本：`v2.0.0`，镜像 revision 均为 `16d3a2d8e1e4dbf1280da44d5acdc2b10792fdcf`。
- 正式数据库从迁移 13 升至 28，执行 15 项迁移；再次执行为 `applied_count=0`。
- 前端、API、向量 worker、PostgreSQL、Redis 健康检查通过；API detailed health 中 Qdrant 健康。
- `/health` 的版本字段仍由应用返回 `1.0.1`，本次发布身份以镜像 revision 为准。

## 服务器上的部署入口

服务器原有 `/root/MathStudyPlatform` 工作区有未提交的 Compose 修改及两个脚本的文件模式修改，本次未覆盖这些修改。新发布使用独立目录：

| 用途 | 服务器路径 |
| --- | --- |
| 源码 | `/opt/msp/releases/16d3a2d8` |
| 当前源码链接 | `/opt/msp/current` |
| API、前端、worker Compose | `/opt/msp/config/app.yaml` |
| 应用环境文件，权限 0600 | `/opt/msp/config/runtime.env` |
| 向量部署变量与资源限制 | `/opt/msp/config/vector.env`、`vector-small.yaml` |
| 向量与加密密钥目录 | `/opt/msp/secrets` |
| 运维入口 | `/opt/msp/manage.sh` |
| Nginx 配置 | `/etc/nginx/sites-available/mathstudyplatform.conf` |

```sh
/opt/msp/manage.sh app ps
/opt/msp/manage.sh vector ps
/opt/msp/manage.sh app logs --tail 100 backend vector-worker-1
docker exec msp_vector_worker_1 wget -qO- http://127.0.0.1:8091/ready
docker exec msp_vector_worker_1 msp-vector-worker status
```

应用 Compose 复用现有 `mathstudyplatform_msp_network`，PostgreSQL 和 Redis 仍由旧部署配置管理。**不得在新应用 Compose 上使用 `--remove-orphans`**：它会把既有数据库服务视为 orphan。旧目录中的升级脚本不管理此次独立向量拓扑，后续升级应按新部署配置编排。

数据库凭据已轮换，并同步至新运行环境和原目录的 `.env`。原 Fernet 密钥保持不变。凭据不写入本文或 Git；禁止输出完整 Compose 配置、容器环境或密钥文件。

## 向量拓扑与资源边界

- 使用仓库 `deploy/vector/compose.yaml` 和加固 Qdrant Dockerfile，镜像 `msp-qdrant:1.14.1-p4-20260918`。
- 三个 Qdrant peer，同机部署，TLS 覆盖 REST、gRPC 和节点间通信；3 shard、3 replica、写一致性 2。
- API 仅持有只读 key，worker 持有写 key；通过 TLS gateway 访问。
- peer 仅在内部网络开放，gateway 仅绑定 `127.0.0.1:16333`。
- 服务器约 4 核、4 GiB 内存。每个 peer 上限 512 MiB；API 768 MiB；单个 worker 512 MiB、并发 1；前端 256 MiB；gateway 128 MiB。
- API、worker、Qdrant 使用非 root、只读根文件系统、移除 capabilities 和禁止提权；容器日志设置轮转。
- worker 管理监听仅在其容器内部 loopback，未发布宿主端口。
- 同机三 peer **不提供宿主机故障容灾**。当前配置面向小规模上线，需随数据量监测内存、磁盘与队列。
- 内部向量叶证书有效期一年，须在 2027-09-18 前续签并验证。应用到 PostgreSQL 仍沿用现有本机 Docker 网络连接，未在此次变更中切换为数据库 TLS。

## 防御增强

- 启用 SSH fail2ban：5 次失败/10 分钟，初始封禁 1 小时，递增至最长 24 小时。
- SSH 限制认证尝试、认证宽限时间及未认证连接数，禁用 X11 和 agent forwarding；保留现有登录方式，未更改 root 登录密码。
- 保留 UFW 默认拒绝入站，公网规则只允许 80、443、10001；数据库、缓存、应用回源均绑定 loopback。
- Nginx 增加 API、认证、向量检索限流及连接数限制，限流返回 429。
- 拦截点文件、`/metrics`、`/health/detailed`、`/debug/`；上传仍经 API 授权。
- 增加 HSTS、安全响应头及最小 CSP，保留流式响应所需的超时和关闭缓冲设置。
- 启用 unattended security upgrades；未重启宿主机。系统登录时已提示需要重启，仍需安排维护窗口。
- 当前 root 密码曾在聊天中提供，建议用户在验证自己的密钥登录后轮换密码；此次未擅自禁用其登录通道。

## 已执行验证

- 本地：`go test ./... -count=1`、`go vet ./...`、`go build ./...`、前端 `npm run lint`、`npm run build` 均成功。仓库按约定不保留测试源文件；Go 命令结果不能视为行为测试覆盖率证明。前端构建仍有大 chunk 和 Browserslist 数据过期提示。
- 切换前将旧库备份恢复到隔离库，验证全部迁移和重复运行；切换后再次验证正式库迁移。
- 停写后备份数据库和 uploads；正式备份在另一隔离库成功恢复。两个临时库及临时数据库角色已删除。
- 外网首页 200；验证码入口 200；匿名资源检索 401；敏感文件 403；管理诊断入口 404。
- 登录限流探针：14 次空请求中 11 次 400、3 次 429。
- Qdrant：无 key 401，只读 key 写入 403，集群返回 3 peer；临时 collection 以 3/3/2 创建，写入和只读向量查询成功；不信任 CA 的连接失败。临时 collection 已删除。
- worker ready 为 `ok`，任务队列为空，无 dead job 或 expired lease。
- 宿主监听和 Docker 端口映射确认内部端口仅 loopback/容器网络。执行机存在 TUN 代理，不能把本地 TCP connect 成功作为公网端口暴露证据；直接 HTTP 探测内部端口未收到响应。

## 备份与回滚

- 切换前备份：`/opt/msp/backups/release-20260918T053026Z`。
- 含 PG custom dump、uploads、旧 `.env`/Compose/Nginx、旧容器信息及运行环境。目录为 root 私有，容器信息包含敏感环境，禁止公开。
- 旧镜像保留标签：`msp-backend:rollback-20260918`、`msp-frontend:rollback-20260918`。
- 加密运维包：`/opt/msp/backups/release-20260918-bundle.tar.gz.enc`；解密材料独立存放在服务器 root 私有目录。已解密并验证压缩包可读取。
- 备份仍在同一宿主机，尚未建立异机备份。
- 无自动 down migration。回滚前停止 API 与 worker 写入，评估旧镜像与新 schema 的兼容性；不兼容时按部署手册恢复备份数据库和 uploads，并恢复匹配的数据库凭据、Fernet 密钥、镜像和 Nginx 配置。不要直接运行旧脚本覆盖当前拓扑。

## 尚待业务配置和验收

上线时 `embedding_model_versions` 为空，尚无 active embedding 模型或索引 generation。向量基础设施已可用，但尚未完成真实文档的解析、embedding、发布、语义检索及撤权全过程验收。需在管理员模型设置中配置并测试 embedding 来源，再按 [小范围上线手册](vector-small-deployment.md) 完成知识库入库、对账和发布。不得把基础设施测试宣称为真实语义检索已验收。
