# 开发指南

## 环境要求

- Go 1.25.12（`go.mod` 声明 `go 1.25.0` 和 `toolchain go1.25.12`）
- Node.js 20 和 npm
- PostgreSQL 18 + pgvector
- Redis 7

版本变化时以 [go.mod](../../backend/go.mod)、[package.json](../../frontend/package.json) 和 [docker-compose.yml](../../docker-compose.yml) 为准。

## 首次启动

在仓库根目录创建本地环境文件：

```powershell
Copy-Item .env.example .env
```

启动后端前先执行迁移：

```powershell
Set-Location backend
go mod download
go run ./cmd/migrate
go run ./cmd/api
```

另开终端启动前端：

```powershell
Set-Location frontend
npm install
npm run dev
```

根目录 `start.bat` 可在 Windows 上同时打开前后端进程，但不会替代首次数据库迁移。

## 常用验证命令

Go 后端：

```powershell
Set-Location backend
go vet ./...
go build ./...
gofmt -w <changed-go-files>
```

前端：

```powershell
Set-Location frontend
npm run lint
npm run build
```

提交前在仓库根目录运行：

```powershell
git diff --check
git status --short
```

## 临时测试规则

仓库不永久保留或提交测试用例源码。生产代码完成后，才按本次变更创建临时 `*_test.go`、`*.test.ts(x)` 或 `*.spec.ts(x)`；测试范围覆盖公共行为、边界输入、错误条件和外部依赖降级，修改共享契约时同时做 Go 与前端临时契约验证。

测试运行器配置和依赖可以保留。临时测试存在时按需运行：

```powershell
# Go：只运行受影响包，必要时再扩大范围
Set-Location backend
go test <affected-packages> -count=1

# 前端：传入本次创建的临时测试文件
Set-Location ../frontend
npm test -- <temporary-test-path>
npm run test:coverage -- <temporary-test-path>
```

测试通过后先记录命令、结果和必要覆盖率，再按明确路径删除本次临时测试及其专用 fixture/mock；禁止使用宽泛递归删除。提交前在仓库根目录确认以下命令没有输出：

```powershell
git ls-files "*_test.go" "*.test.ts" "*.test.tsx" "*.test.js" "*.test.jsx" "*.spec.ts" "*.spec.tsx" "*.spec.js" "*.spec.jsx" "test_*.py" "*_test.py"
git diff --cached --name-only --diff-filter=ACMR | Select-String -Pattern '(_test\.go|\.(test|spec)\.(ts|tsx|js|jsx)|(^|/)test_.*\.py|_test\.py)$'
```

## 代码组织

### 前端

- 页面只负责布局和业务模块组合。
- API 调用放在 `src/modules/*/services/`，交互状态和业务流程放在模块 Hook 或 Store。
- 模块通过 `index.ts` 暴露公共接口，外部代码避免深层导入。
- 通用 UI 放入 `src/components/`，与业务绑定的组件留在对应模块。

### 后端

- `application` 表达用例、事务和业务规则。
- `adapter/http` 负责请求解析、鉴权、响应和协议错误映射。
- `adapter/postgres` 负责 SQL、扫描和持久化语义。
- `platform` 只承载跨领域基础能力，不放业务规则。
- 新外部依赖通过接口和适配器接入，并在临时测试中替换为 fake 或 mock。

完整协作约束见 [AGENTS.md](../../AGENTS.md)。

## 数据库迁移

新增迁移文件使用 `NNNN_description.up.sql` 命名，并放在 `backend/migrations/`。当前只使用 forward migration：

```powershell
Set-Location backend
go run ./cmd/migrate
go run ./cmd/migrate  # 重复执行应无待应用版本
```

当前共享迁移链是 `0001` 至 `0015`。`0005` 至 `0010` 交付每日题、画像、每日题一致性和错题闭环，`0011` 至 `0014` 交付论坛、学习会话模式、首次聊天幂等和 AI 参数默认值，`0015_auth_version` 交付账户级令牌失效。全新数据库首次应记录 version 1 至 15；version 14 数据库只新增 version 15；复跑应无待应用版本。曾执行旧草稿 10 至 13 或旧错题草稿占用 version 11 的本地数据库，必须按 [迁移策略](../../backend/migrations/README.md) 的专用校准流程处理，不能删除账本后重放。runner 会校验数据库中的版本、名称和未知记录；其他旧开发链仍应重建或设计数据保留方案。

## 环境配置

仓库根目录 `.env` 是本地和部署环境的统一文件名，`.env.example` 是唯一模板。至少应按环境修改：

- PostgreSQL、Redis 和连接池配置
- JWT、Fernet、管理员初始化凭据
- CORS 和管理端允许网段
- 安全日志归档、删除期限，以及自动清理的周期、超时和批次上限
- 管理端数据库备份导入使用流式 JSON 校验和临时分表暂存，暂存总量硬限制为 100 MB；导入完成后临时文件会自动清理，不需要手工回收
- Eino provider 的兼容配置
- 本地存储根目录 `UPLOADS_DIR`；对象存储后端和云存储凭据由管理员保存到数据库，不写入 `.env`
- 西电账户绑定端点和超时
- 微信公众号凭据、回调消息模式和外部请求超时

不要提交 `.env`、API key、密码或真实用户数据。

后台 AI provider 的 `base_url` 可以填写纯主机根地址或完整 API base；纯主机地址会自动补 `/v1`，只要地址中已有路径就会原样使用，因此 `/v1`、`/proxy/v1`、`/v1beta/openai` 均不会被重复改写。非流式调用会自动兼容 Chat Completions 与 Responses，推理模型按大小写不敏感的 `gpt-5*`、`o1*`、`o3*`、`o4*` 前缀识别，也兼容 `provider/model` 命名空间，并优先尝试 Responses。连接测试对推理模型使用 `max_completion_tokens=32`，对旧式 Chat provider 保留 `max_tokens=32`。

管理端的智能体参数覆盖不再提供或发送 Top P。新发现模型保存 Temperature `1.0`、Max Tokens `4096`、超时 `1800` 秒和最大重试 `3` 次作为配置基线；其中 Temperature、Max Tokens 和最大重试默认不启用，输入留空时前两项不写入 provider 请求且应用层不重试，只有显式覆盖才生效。超时留空时使用模型的 `1800` 秒总请求时限；这与 Cherry Studio 流式请求收到数据后重新计时的 idle timeout 并不完全等价。Agent 的 `MaxIterations` 固定使用独立默认值 `8`，不得再从重试次数推导。数值和开关语义参考 Cherry Studio 当前的 [Assistant 默认设置](https://github.com/CherryHQ/cherry-studio/blob/12498d68ecb4fb261670843ca7a8e4e64a37526a/src/shared/data/types/assistant.ts)、[请求超时](https://github.com/CherryHQ/cherry-studio/blob/12498d68ecb4fb261670843ca7a8e4e64a37526a/src/main/ai/constants.ts) 和 [模型重试策略](https://github.com/CherryHQ/cherry-studio/blob/12498d68ecb4fb261670843ca7a8e4e64a37526a/docs/references/ai/model-retry.md)。`0014_ai_generation_defaults` 会清空历史 Top P，并只校准仍使用旧默认值的模型；显式自定义的其他数值不变。数据库中的旧 Top P 列和后端兼容 JSON 字段暂时保留，但运行时一律忽略。

学习会话的 `POST /session/start-chat` 和 `POST /session/{session_id}/chat` 使用真正的模型分片流，而不是等待完整回复后再包装为 SSE。事件顺序为可选的 `session_info`、一次 `task_info`、多次 `message` chunk、一次 `message` done；每个事件写入后立即 flush。Tutor 流式请求直接使用 provider 的 Chat Completions 流，Responses 自动转换继续只用于非流式 Agent。默认模型请求共享进程级 HTTP Transport 和连接池，但通过客户端浅拷贝保留每次运行配置的独立总超时；显式注入的测试客户端仍按请求单独包装。

## 微信公众号测试号联调

公众号回调由微信服务器从公网发起，不能直接填写 `localhost`。本地联调需要同时运行 PostgreSQL、Redis、Go API 和临时 HTTPS 隧道；前端在测试学生或教师绑定时需要运行。建议先使用微信公众平台接口测试号，正式公众号仍需单独验收主体权限。下文以默认 `API_V1_PREFIX=/api/v1` 为例；若修改了该配置，所有回调和调试 API 路径都要同步替换前缀。

先将测试号凭据写入本机 `.env`：

```dotenv
WECHAT_OFFICIAL_ACCOUNT_ENABLED=true
WECHAT_OFFICIAL_ACCOUNT_APP_ID=<test-app-id>
WECHAT_OFFICIAL_ACCOUNT_APP_SECRET=<test-app-secret>
WECHAT_OFFICIAL_ACCOUNT_TOKEN=<3-to-32-ascii-letters-or-digits>
WECHAT_OFFICIAL_ACCOUNT_AES_KEY=
WECHAT_OFFICIAL_ACCOUNT_MESSAGE_MODE=plain
WECHAT_OFFICIAL_ACCOUNT_NAME=微信接口测试号
WECHAT_OFFICIAL_ACCOUNT_HTTP_TIMEOUT_SECONDS=10
WECHAT_MESSAGE_REMINDERS_ENABLED=false
WECHAT_PRIVATE_MESSAGE_TEMPLATE_ID=
WECHAT_NOTICE_TEMPLATE_ID=
WECHAT_QA_MESSAGE_TEMPLATE_ID=
```

`APP_SECRET`、`TOKEN` 和 `AES_KEY` 都是密钥，不得提交、粘贴到 issue 或出现在共享截图中。截图、日志或聊天记录一旦暴露密钥，应先在微信后台重置对应值，再继续联调。

回调模式必须与微信后台的消息加解密设置一致：

| `WECHAT_OFFICIAL_ACCOUNT_MESSAGE_MODE` | 微信后台模式 | 后端接受的回调 | `AES_KEY` |
| --- | --- | --- | --- |
| `plain` | 明文模式 | 仅明文签名和明文 XML | 可留空 |
| `compatible` | 兼容模式 | 明文或 AES 加密 XML | 必填，微信后台生成的 43 字符值 |
| `safe` | 安全模式 | 仅 AES 加密 XML | 必填，微信后台生成的 43 字符值 |

若测试号页面没有消息加解密模式选项，使用 `plain`。不要自行编造 `AES_KEY`，兼容模式和安全模式必须使用微信后台对应的 `EncodingAESKey`。

消息中心结构和北京时间默认值由 `backend/migrations/0003_communication.up.sql` 交付，微信公众号绑定和基础提醒任务由 `0004_delivery_integrations.up.sql` 交付；每日一题、画像、每日题一致性和错题闭环由 `0005` 至 `0010` 交付；论坛、学习会话一致性和 AI 参数默认值由 `0011` 至 `0014` 交付；账户级令牌失效由 `0015_auth_version.up.sql` 交付。全新数据库第一次运行应记录版本 `1` 至 `15`，version 14 数据库应只新增 version 15，第二次运行都应无待应用版本。

```powershell
Set-Location backend
go run ./cmd/migrate
go run ./cmd/migrate  # 应返回 applied_count=0
go run ./cmd/api
```

另开终端建立临时 HTTPS 隧道，例如已安装 `cloudflared` 时：

```powershell
cloudflared tunnel --url http://localhost:8000
```

将命令输出的 HTTPS 根地址拼接固定回调路径，并填入测试号“接口配置信息”的 URL：

```text
https://<temporary-host>/api/v1/integrations/wechat/official-account/callback
```

测试号页面的 Token 必须与 `.env` 中 `WECHAT_OFFICIAL_ACCOUNT_TOKEN` 完全一致。临时隧道停止后不可访问，重新启动通常会生成新域名；URL 每次变化都必须回到测试号后台重新填写并提交验证。JS 接口安全域名不参与服务器回调，基础联调可以留空。

按以下顺序验收，不应把代码构建通过写成真实微信验收通过：

1. 在测试号后台提交 URL 和 Token，确认 `GET` 回调验证成功。
2. 用个人微信扫描测试号二维码关注，确认 `subscribe` 回调到达且收到被动回复。
3. 使用学生或教师账号登录前端，在个人中心生成一次性绑定口令，并向测试号发送完整的“绑定 XXXX-XXXX”命令；两种角色应分别验收一次。
4. 确认微信收到“绑定成功”被动回复，刷新个人中心后显示已绑定和已关注。
5. 使用管理员访问令牌调用 `POST /api/v1/admin/wechat/test-message`，JSON 只传 `{"user_id":"<student-or-teacher-id>"}`；该接口发送服务端固定内容，不接受管理员自定义消息。
6. 取消关注后确认绑定记录仍保留但订阅状态变为未关注；重新关注后状态恢复，必要时再验证解绑和换绑冲突。

同一平台账号每 10 分钟最多生成 3 个绑定口令，超限返回 `429 WECHAT_BINDING_RATE_LIMITED`。口令首次由某条微信消息使用时会按该消息事件 ID 原子预留，不会在数据库绑定前直接删除；进程中断后，同一条微信重试仍可完成绑定，其他消息不能复用该口令。回调处理中使用 6 秒短租约，完成后保存 24 小时去重结果和被动回复；并发重试在处理中返回 503，完成后的重试会重放同一回复。POST 回调整体响应有 4.5 秒硬上限，避免超过微信 5 秒窗口。

基础绑定验收通过后，在测试号后台分别新增三份模板。模板标题可写“新私信提醒”“班级通知提醒”“答疑消息提醒”；每日一题学生提醒和统一题低库存提醒复用“班级通知提醒”模板。模板正文必须使用以下字段名；文字标签可以调整，但不能把 `keyword1`、`keyword2`、`keyword3` 改成其他名称：

```text
发送人：{{keyword1.DATA}}
主要内容：{{keyword2.DATA}}
发送时间：{{keyword3.DATA}}
```

```text
发布人：{{keyword1.DATA}}
通知主题：{{keyword2.DATA}}
发布时间：{{keyword3.DATA}}
```

```text
发送人：{{keyword1.DATA}}
主要内容：{{keyword2.DATA}}
发送时间：{{keyword3.DATA}}
```

把三份模板各自生成的模板 ID 写入 `WECHAT_PRIVATE_MESSAGE_TEMPLATE_ID`、`WECHAT_NOTICE_TEMPLATE_ID` 和 `WECHAT_QA_MESSAGE_TEMPLATE_ID`，再将 `WECHAT_MESSAGE_REMINDERS_ENABLED` 改为 `true` 并重启 Go API。总开关开启时三个模板 ID 都必须配置；技术上允许多个配置使用同一个模板 ID，但正式验收建议保持三份独立模板。随后按时间顺序验证：

1. 学生向教师发送私信，教师收到私信模板卡片；教师向学生回复时学生收到同类卡片。`keyword1` 是发送人，`keyword2` 是主要内容，`keyword3` 是北京时间。
2. 教师发布班级通知，每个发布时成员快照中的学生各产生一个任务；`keyword1` 是发布人，`keyword2` 只展示通知主题，`keyword3` 是发布时间。
3. 学生发起答疑时教师收到答疑模板卡片；教师回复和学生追问均提醒另一方。字段含义与私信相同。
4. 教师开启每日一题自动提醒后，确认当天有 `ready` 且未完成题目的学生只收到公众号模板消息，平台内不生成通知；无题时不创建任务。手动与自动提醒使用固定且相互独立的来源；关闭再开启或定时对账时，自动来源的 `skipped/dead` 任务应恢复入队，已发送任务不得重复。班级统一题日程补题后再降至仅剩一题时，只向教师发送公众号低库存提醒；低库存来源的 `skipped/dead` 任务也应能在对账时恢复。
5. 接收方查看私信或答疑消息、学生确认通知后，在 worker 发送前应将对应任务标记为 `skipped`；解绑、取消关注或停用接收账号也应跳过。答疑已读对学生和教师均按详情响应中的 `through_message_id` 截止，不能误标并发到达的新消息。
6. 网络、微信限频或 5xx 会有限重试；模板 ID、模板字段、AppSecret、IP 白名单或接口权限错误进入 `dead`。通过数据库只核对任务状态和脱敏错误码，不应看到正文、摘要、OpenID、access token 或微信响应正文。

私信和答疑正文会先去除首尾空白并把连续空白折叠为一个空格，再按 Unicode 字符保留前 40 个字符；超过时追加 `…`。通知不发送正文，只发送空白规范化后的主题。摘要、主题、发送人和事件时间均在 worker 实际发送前从源表即时读取，只存在于单次请求内存和发往微信的模板请求中；提醒任务表继续不保存这些字段。模板内容可能出现在微信消息列表或系统锁屏通知中，启用前应按实际隐私要求评估展示范围。

站内消息写入与提醒任务入队位于同一 PostgreSQL 事务，微信 HTTP 调用始终发生在提交后的 worker 中。worker 使用租约和 `FOR UPDATE SKIP LOCKED` 支持多实例接管，并在每次实际发送前以 owner 条件续租；等待期间租约已经过期或已被其他实例接管时不会继续调用微信。如果进程在微信接受消息后、写入 `sent` 前退出，模板消息接口缺少项目可控的幂等键，极端情况下仍可能重复发送一次提醒。`sent`、`skipped` 和 `dead` 任务保留 30 天，worker 每小时最多分 10 批清理 10000 条过期终态任务。

若后续从不含提醒入队代码的应用版本升级，不要让旧实例和已启用提醒的新实例长期混跑。应先执行包含提醒任务表的 forward migration，排空并停止旧实例流量，完成全部新实例部署后再统一设置 `WECHAT_MESSAGE_REMINDERS_ENABLED=true`；否则旧实例仍可提交站内消息，但它不具备提醒入队代码，无法事后自动回填对应任务。

管理员 `test-message` 仍使用客服消息接口和固定文本，受账号权限、频率及用户最近交互窗口约束。私信、通知和答疑业务提醒改用模板消息接口，不依赖管理员测试接口的客服窗口，但必须拥有对应模板消息权限，且模板 ID 和字段结构必须与同一 AppID 下的微信后台模板一致。测试号成功不代表正式账号天然具备相同权限。
