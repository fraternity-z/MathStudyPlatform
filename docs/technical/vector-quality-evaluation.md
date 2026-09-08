# 向量检索质量回归评估

`scripts/vector-quality-evaluate.py` 是 P5 的持续运维评估工具，使用 Python 3 标准库，通过正式鉴权搜索与引用接口读取数据。它与 P4 的小型 `vector-quality-probe.py` 独立，后者的巡检格式、指标和调度契约不变。

## 冻结输入

在受控目录准备 UTF-8 JSON 数据集与单独的账号 token 映射文件。文件各不超过 8 MiB，数据集包含 1–1000 个样本。使用独立标注的授权集合，不能从本次搜索返回值反推正确答案或允许集合。

数据集顶层字段为 `format: 1`、非空 `version`、`cases` 数组。每条样本字段如下：

| 字段 | 约束与含义 |
|---|---|
| `kind` | `positive`、`no_answer` 或 `permission` |
| `query` | 非空查询，不超过 2000 字符 |
| `actor` | token 映射中的逻辑账号名，映射值为其短期访问 token |
| `knowledge_base_id` | 已存在知识库 UUID，传递给正式 API |
| `expected_resource_ids` | 去重后的相关资源 UUID 列表；正例非空，其他两类必须为空 |
| `allowed_resource_ids` | 当前账号可见的完整候选资源白名单；包含所有相关资源；可为空；最多 1000 个 |
| `expected_degraded` | 必填布尔值，表示当前受控运行条件下是否预期降级 |
| `expected_mode` | `hybrid`、`fts_only`、`vector_only` 或 `none`，必须与实际 API 模式一致 |

完成标注后计算文件原始字节 SHA-256，将摘要单独纳入受控验收记录；运行时必须传入该摘要，修改数据后不能直接沿用旧摘要。所有样本和账号在首个请求前验证；摘要不匹配、缺账号或非法标注均拒绝执行。数据集与 evaluator 源码摘要都会写入结果，用于核对版本。

P5-01 的代表性冻结还需要另外记录文档类型、长度、语言、权限分布、更新率、查询分布、原始语料清单及 checksum。工具校验通过仅说明输入可执行，不代表语料具备教学代表性。账号凭据、查询、原文及原始标注保存在受控位置，不进入 Git。

## 执行

```sh
python scripts/vector-quality-evaluate.py --api-base https://api.example.invalid/api --dataset /secure/frozen.json --dataset-sha256 APPROVED_DATASET_SHA256 --tokens-file /secure/actors.json --ca-file /secure/ca.crt --report /secure/retrieval-report.json
```

`--api-base` 使用实际 HTTPS API 前缀；不接受 URL 内凭据、查询串、fragment 或重定向。使用系统 CA 时省略 `--ca-file`，没有跳过证书验证开关。token 映射文件的结构为 JSON 对象，键是逻辑账号名，值是 token；凭据只在内存及 HTTPS 请求头使用，不写进命令参数和报告。

调用顺序与数据集相同，每个样本只执行一次搜索，随后逐条读取主结果和邻接结果的引用；不缓存授权、元数据或引用。搜索可能通过当前管理员 active 配置产生 embedding/rerank 费用；真实调用必须符合已批准的语料和费用边界。工具不发起 Tutor 请求，不切换模型、修改索引、制造故障或改变 ACL。外部依赖全部由部署环境提供，故障及撤权场景由受控演练准备。

每次请求超时 15 秒、响应限制 1 MiB，必须带有 `Cache-Control: no-store`。文件型输入上限和顺序执行限制单次任务资源；它不是并发压测程序。

## 门禁口径

固定 `K=5`，相关性按资源二值标注，重复 chunk 占用排名位置但只获得一次相关增益。Recall 分母为全部已标注相关资源数；MRR 使用首个相关资源的倒数排名；nDCG 使用二值 DCG 与最多五个相关资源的理想排序归一化。失败的正例仍计入分母，得分为零。

总正例、正常正例、预期降级正例分别检查 Recall@5 ≥ 0.90、MRR@5 ≥ 0.85、nDCG@5 ≥ 0.85。分组门禁避免正常样本掩盖降级路径退化。报告同时列出是否达到阈值，以及缺失的场景覆盖。

全量通过还要求以下条件：

- 至少一个正常正例、一个降级正例、一个无答案样本、一个权限样本，以及实际成功核验的引用；缺失场景不能作为通过。
- 主结果和邻接结果均在该样本的授权白名单中；无越权资源返回。
- 每条引用知识库与请求一致、引用对象与再次解析结果一致、搜索正文与解析正文一致、原文 SHA-256 与 `quote_hash` 一致。
- 降级标志和实际检索模式均符合冻结预期。
- `no_answer` 样本的主结果和邻接结果都为空。这是严格的**检索空结果**门禁；如果返回无关但有权访问的候选，会明确失败。

`no_answer` 不衡量 Tutor 面对无关候选时能否拒答，`permission` 只验证当前账号搜索输出和返回引用，不代表直接访问被拒引用、撤权竞态或完整 ACL 矩阵已验证。报告固定标记 `tutor_no_answer: not_evaluated`。这些检查须在完整 P5-09 验收中补齐，不能把本工具成功当作整个 P5/M5 通过。

报告保存搜索请求的 P50/P95/P99 和样本数；引用读取耗时不计入搜索耗时。失败请求没有成功响应耗时，单次顺序运行没有代表性并发或稳定性时长，因此报告固定标记 `capacity_slo: not_evaluated`，不能代替 D-005 容量和 soak 验收。

## 输出与自动化

报告原子替换，包含摘要、时间、计数、指标、阈值、场景缺失及失败的样本序号/固定错误码，不包含账号、资源 ID、query、正文、凭据、服务地址或供应商异常。

退出码 `0` 表示本次检索门禁通过；`1` 表示评估已完成但门禁未通过；`2` 表示输入、连接配置或报告写入等执行问题。调用方必须同时检查**本次退出码**、`success` 和已批准数据摘要，不能仅检查磁盘上可能遗留的上次成功报告。报告路径禁止与输入路径重合。Linux 设置私有 umask；Windows 的输入和报告目录应使用受控 ACL。

失败定位从 `failures[].case` 回查受控数据集的 1-based 行序号。`request_failed` 表示请求、状态码或 JSON 解析失败，不复制潜在敏感底层错误。`quality_passed: false` 可直接结合总体及分组排名指标定位阈值回归；`missing_coverage` 指出尚缺场景。

## 2026-09-08 工程验证

本轮用户确认“尚未准备，先推进工具与验证”。9 个临时 unittest 测试方法及其参数化子场景通过，外部 HTTP/引用接口全部使用 Mock。覆盖正常与降级正例、无答案、权限白名单、邻接引用、重复命中、手算排名指标、失败分母、模式分组退化、错误及超大响应、TLS 地址约束、禁止重定向、no-store、摘要冻结、缺账号、原子输出和脱敏。

命令为 `python -m trace --count --summary --missing --coverdir .tmp/vector-p5-coverage --ignore-dir <本机 Python 安装目录> --module unittest discover -s scripts -p test_vector_quality_evaluate.py`。当前环境未安装第三方 coverage，使用标准库 trace，评估器可执行行覆盖率为 99%；不将该值写作分支覆盖率或全仓覆盖率。临时测试源码、fixture 和覆盖产物在交付前删除，保留本记录及持续运维工具。

`python scripts/vector-quality-evaluate.py --help`、后端 `go test ./... -count=1` 和 `go build ./...` 通过；后端本次没有持久测试源码，不把该命令当新的 Go 功能复测。

后续项目负责人授权“没有真实语料，你直接自己编写测试即可”。已用 24 篇原创材料完成正式 HTTPS/真实 PG/检索应用与 Mock 向量依赖的 125 个场景、288 次引用核验及错误、权限竞态与切块测试，见[合成验收](../plans/resource-center-qdrant/TEST-SYNTHETIC-2026-09-08.md)。精确词条指标与中文改写 FTS 0/24 分开记录，不再以真实教学语料缺失阻断后续测试；真实 Qdrant/模型质量、Tutor 无答案、目标容量和 soak 仍待验证，M5 未通过。
