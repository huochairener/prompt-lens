# AI 提供商配置（多提供商 / 多协议 / 运行时切换）

项目的 AI 调用不再把 base URL 写死在代码里。所有提供商都描述在
[`config/ai-providers.json`](../config/ai-providers.json)，由
`lib/ai/providers/` 统一加载、解析、路由。

## 1. 目录结构

```
config/ai-providers.json          # 出厂基线：提供商 + 非对话服务的 base URL
lib/ai/providers/
├── types.ts                      # 协议、提供商、覆盖项、消息等类型
├── config.ts                     # 基线 + 环境变量 + 在线覆盖 → 归一化目录（按用户分桶缓存）
├── store.ts                      # 在线配置的数据库读写（一人一行）、Key 加解密、角色查询
├── admin.ts                      # 在线管理：增删改、切模型、换 Key、连通性测试（只写自己那份）
├── runtime.ts                    # 当前提供商解析（同步 / 异步两版，按用户）
├── endpoint.ts                   # base URL + 路径拼接
├── keys.ts                       # 平台密钥 / 用户自己的密钥读取（纯函数）
├── user-keys.ts                  # 用户自备密钥读取（user_api_keys 表）
├── resolve-key.ts                # 密钥优先级解析（用户 Key > 平台 Key）
├── images.ts                     # data URL / 远程图片 → base64
├── transport.ts                  # 本地开发代理
├── client.ts                     # createChatCompletion 统一入口（必须带 scope）
└── adapters/
    ├── openai-chat.ts            # POST {baseUrl}/chat/completions
    ├── openai-responses.ts       # POST {baseUrl}/responses
    └── anthropic-messages.ts     # POST {baseUrl}/v1/messages
```

调用方只依赖 `createChatCompletion()`，不关心是哪家服务。

## 1.5 配置优先级（重要）

从高到低：

1. **在线配置**（数据库 `ai_settings`，**每个用户自己一行**）——设置页改的内容，保存即生效
2. **环境变量** `AI_PROVIDER_<ID>_*`——部署级兜底
3. **`config/ai-providers.json`**——版本控制里的出厂基线

在线配置**逐字段**覆盖：只改了 `baseUrl`，模型仍可继续由环境变量提供；
一旦某个字段被在线配置写入，环境变量就不再参与该字段，保证"后台改了就一定生效"。

### 配置跟着账号走

- `ai_settings.id` 就是 `user.id`：每个用户一份 `overrides` / `secrets` / `activeProviderId`。
- 别人的提供商、模型、Key **不会**出现在你的列表里，也无法被你调用。
- 进程内快照按用户分桶（`AI_CONFIG_CACHE_MS` 默认 2s，`AI_CONFIG_MAX_SCOPES` 默认 200 个用户），
  所以「A 改了配置，B 不受影响」在多实例下也成立。
- 详见 [ADR 0003](./decisions/0003-per-user-provider-settings.md)。


## 2. 提供商字段

| 字段 | 必填 | 说明 |
| --- | --- | --- |
| `id` | ✅ | 唯一标识，运行时切换、日志、密钥解析都用它 |
| `label` | | 展示名称，默认等于 `id` |
| `protocol` | ✅ | `openai-chat` / `openai-responses` / `anthropic-messages` |
| `baseUrl` | ✅ | API 根地址，**不要**带协议路径（如 `/chat/completions`） |
| `path` | | 覆盖协议默认路径，例如 `/v1/chat/completions` |
| `modelPaths` | | 按模型指定绝对路径，优先级高于 `path`（KIE 这类分通道服务用） |
| `defaultModel` | | 未显式传 `model` 时使用 |
| `apiKeyEnv` | | 平台密钥的环境变量名，按顺序取第一个非空值 |
| `apiKey` | | 直接内联密钥（不推荐，生产用环境变量） |
| `headers` | | 附加请求头（OpenRouter 的 Referer/Title 等） |
| `extraBody` | | 合并进请求体的额外字段 |
| `maxOutputTokens` | | 输出上限，默认 4096 |
| `maxTokensField` | | `max_tokens`（默认）或 `max_completion_tokens` |
| `temperature` | | 默认温度 |
| `timeoutMs` | | 超时，默认 180000 |
| `anthropicVersion` | | Anthropic 的 `anthropic-version`，默认 `2023-06-01` |
| `keyStrategy` | | `platform` / `user` / `either`（默认） |
| `enabled` | | 设为 `false` 可从列表和调用中移除 |

`services` 段用于非对话服务（AssemblyAI、KIE 视频生成）：

```json
{ "id": "assemblyai", "baseUrl": "https://api.assemblyai.com", "baseUrlEnv": ["ASSEMBLYAI_BASE_URL"] }
```

## 3. 三种协议

| 协议 | 请求地址 | system 处理 | 图片 | 文本提取 |
| --- | --- | --- | --- | --- |
| `openai-chat` | `{baseUrl}/chat/completions` | `messages[0]` | `image_url`（URL 直传） | `choices[0].message.content` 或 `choices[0].text` |
| `openai-responses` | `{baseUrl}/responses` | `instructions` | `input_image` | `output_text`，否则遍历 `output[].content[].text` |
| `anthropic-messages` | `{baseUrl}/v1/messages` | `system` | `image.source.base64`（远程图会先下载） | `content[].text` 拼接 |

统一消息结构：

```ts
const messages = [{
  role: "user",
  content: [
    { type: "text", text: "描述这张图" },
    { type: "image", image: "https://cdn.example.com/frame.jpg" }, // 或 data URL
  ],
}];
```

各适配器负责把它翻译成对应协议的 wire format。

## 4. 密钥来源

- `platform`：只用服务端 Key（配置文件内联 / 环境变量），**仅管理员可用**。
- `user`：只用用户自己保存的 Key（BYOK），如 `kie`。
- `either`（默认）：先用户自己的 Key，管理员没填时再用服务端 Key。

平台 Key 的读取顺序（高 → 低）：

1. 配置文件内联的 `apiKey`
2. `apiKeyEnv` 指向的环境变量

**用户自己的 Key 不算平台 Key**：设置页「保存 Key」写入的是 `ai_settings.secrets`（主键 = user.id），
只属于当前账号。两者由 `readPlatformApiKey()` 与 `readOwnApiKey()` 分别读取，不再混用。

**平台试用已移除**：非管理员永远读不到 `apiKeyEnv` / 内联 Key（见
[ADR 0004](./decisions/0004-remove-platform-trial.md)）。没有自己的 Key 就是没有 Key，
调用会返回明确的「请先在设置页填写你自己的 API Key」，不会静默蹭部署方的额度。

数据库里的 Key 用 `BETTER_AUTH_SECRET` 派生 AES-256-GCM 密钥加密，
接口只返回尾号（如 `…a1b2`），明文永不回传前端。
更换 `BETTER_AUTH_SECRET` 会导致旧密文无法解密，此时会自动回退到环境变量。

用户密钥还有一张 `userApiKeys` 表（KIE 自备 Key 卡片在用），`provider` 字段是 `varchar(64)`，
因此在线新增的提供商也能保存用户 Key。运行时优先级：设置页 Key > `userApiKeys` > 平台 Key。

## 5. 在线切换与编辑（不重启）

设置页「AI 提供商配置」卡片就是控制台，**每个登录用户管自己的那份**：

| 操作 | 入口 | 生效时机 | 谁可以 |
| --- | --- | --- | --- |
| 切换提供商 | 卡片上的「切换」 | 保存即生效，重启后仍保留 | 所有人 |
| 换模型 | 每个卡片里的模型输入框 → 保存模型 | 下一次 AI 调用 | 所有人 |
| 换/清 Key | Key 输入框 → 保存 Key / 清除 Key | 下一次 AI 调用 | 所有人（只写自己的 Key） |
| 新增提供商 | 卡片底部「+ 新增提供商」 | 立即出现在我的列表 | 所有人 |
| 删除 / 恢复默认 | 卡片「删除」或「恢复默认」 | 立即 | 所有人（只影响自己） |
| 测试连通性 | 卡片「测试连接」 | 立即返回延迟与错误 | 所有人 |
| 改内置提供商 baseUrl / 协议 / 路径 | 卡片「编辑」展开表单 | 下一次 AI 调用 | **仅管理员** |

非管理员被限制的原因：内置提供商的 `apiKeyEnv` 指向平台环境变量，如果允许改 baseUrl，
就能把平台 Key 发到自己的服务器。在线新增的提供商对非管理员会被强制剥掉 `apiKeyEnv`，
只能用自己保存的 Key。

所有写操作走 `/api/settings/ai-provider`（登录即可，只写自己那一行）：
`POST` 切换/切模型/换 Key/测试，`PUT` 新增或编辑，`DELETE` 删除或恢复。

也可以直接调接口：

```bash
# 切换
curl -X POST localhost:3000/api/settings/ai-provider -H 'Content-Type: application/json' \
  -b 'cookie' -d '{"providerId":"anthropic"}'

# 换模型
curl -X POST localhost:3000/api/settings/ai-provider -H 'Content-Type: application/json' \
  -b 'cookie' -d '{"action":"set-model","providerId":"openai","model":"gpt-4.1-mini"}'

# 换 Key
curl -X POST localhost:3000/api/settings/ai-provider -H 'Content-Type: application/json' \
  -b 'cookie' -d '{"action":"set-key","providerId":"openai","apiKey":"sk-..."}'

# 新增提供商
curl -X PUT localhost:3000/api/settings/ai-provider -H 'Content-Type: application/json' \
  -b 'cookie' -d '{"id":"my-gateway","protocol":"openai-chat","baseUrl":"https://llm.example.com/v1","model":"qwen-max","apiKey":"sk-..."}'
```

### 视频分析页的模型下拉

分析页不再维护写死的模型清单，而是直接读**当前用户**的提供商目录：

| 下拉项 | 取值 | 模型 | 出资方 |
| --- | --- | --- | --- |
| 某个提供商 | `provider:<id>` | 该提供商的 `defaultModel` | 你自己的 Key；管理员可回退服务端 Key |

- 数据来源：`GET /api/analyze/models`（`lib/ai/analysis-options.ts`）。
- 设置页保存模型/Key 后，切回「视频分析」标签就会重新拉取，无需重启。
- 客户端只传 `provider:<id>`，模型名与 Key 都在服务端解析，避免前端塞任意模型或密钥。
- 没有可用 Key 的提供商直接置灰并提示去设置页配置，**没有平台试用通道、没有额度概念**。
- 旧版固定 id（`platform-gemini-*` / `kie-gemini-*`）继续兼容，但一律只用用户自己的 Key。

### 热生效是怎么做到的

- 配置合并结果放在进程内快照里，写操作完成后**主动重建快照**，所以本实例下一次请求就用新值。
- 多实例 / Serverless 时，其他实例靠短 TTL 自动追上，默认 2 秒，
  可用 `AI_CONFIG_CACHE_MS` 调整（设为 `0` 表示每次请求都读库）。
- 请求入口用 `resolveActiveProviderId()`（异步，先刷新再取值）；
  `createChatCompletion()` 与 `resolveProviderApiKey()` 内部也会先对齐快照。
- 数据库不可用时自动降级为"只用文件 + 环境变量"，应用不会起不来。

> `setActiveProvider()` 仍然存在，但只是**进程内临时覆盖**，不写库；
> 需要持久化请用 `admin.saveActiveProvider()`。

## 6. 环境变量覆盖

不用改代码/配置文件就能换网关地址：

```bash
AI_ACTIVE_PROVIDER=openrouter
AI_PROVIDERS_CONFIG='{"defaultProvider":"anthropic","providers":[{"id":"gateway","protocol":"openai-chat","baseUrl":"https://llm.internal/v1","apiKeyEnv":["GATEWAY_KEY"]}]}'

AI_PROVIDER_OPENAI_BASE_URL=https://gateway.example.com/v1
AI_PROVIDER_OPENAI_MODEL=gpt-4.1-mini
AI_PROVIDER_OPENAI_API_KEY_ENV=GATEWAY_KEY
AI_PROVIDER_ANTHROPIC_PROTOCOL=anthropic-messages
AI_PROVIDER_KIE_BASE_URL=https://proxy.example.com
AI_PROVIDER_KIE_ENABLED=false
```

规则：id 转大写、非字母数字换成下划线，例如 `openai-responses` →
`AI_PROVIDER_OPENAI_RESPONSES_BASE_URL`。

`AI_PROVIDERS_CONFIG` 与配置文件按 `id` 浅合并，新 `id` 直接追加，可用来接入自建网关。

## 7. 新增提供商

OpenAI 兼容网关（最常见）：

```json
{
  "id": "my-gateway",
  "label": "My Gateway",
  "protocol": "openai-chat",
  "baseUrl": "https://llm.example.com/v1",
  "apiKeyEnv": ["MY_GATEWAY_KEY"],
  "defaultModel": "qwen-max",
  "headers": { "X-Org": "prompt-lens" },
  "maxOutputTokens": 8192,
  "temperature": 0.4
}
```

Anthropic 兼容网关：

```json
{
  "id": "claude-proxy",
  "label": "Claude Proxy",
  "protocol": "anthropic-messages",
  "baseUrl": "https://proxy.example.com",
  "path": "/anthropic/v1/messages",
  "apiKeyEnv": ["CLAUDE_PROXY_KEY"],
  "defaultModel": "claude-sonnet-4-5"
}
```

Responses 协议的 Azure/自建实现：

```json
{
  "id": "azure-responses",
  "label": "Azure Responses",
  "protocol": "openai-responses",
  "baseUrl": "https://your-resource.openai.azure.com/openai",
  "path": "/responses",
  "apiKeyEnv": ["AZURE_OPENAI_KEY"],
  "defaultModel": "gpt-4o-mini",
  "extraBody": { "store": false }
}
```

## 8. 在代码里调用

```ts
import { createChatCompletion } from "@/lib/ai/providers/client";
import { requireProviderApiKey } from "@/lib/ai/providers/resolve-key";
import { getActiveProvider } from "@/lib/ai/providers/runtime";

const provider = getActiveProvider();
const apiKey = await requireProviderApiKey(provider, { userId });

const { text, usage, providerId } = await createChatCompletion({
  apiKey,
  messages: [{ role: "user", content: "你好" }],
});
```

需要固定提供商时传 `provider: "anthropic"`，需要换模型时传 `model`。
`provider`、`model` 都缺省时使用运行时当前提供商及其默认模型。

## 9. 注意事项

- `baseUrl` 只写到 API 根路径（`/v1` 可以带），协议路径由适配器拼接。
- Anthropic 只接受 base64 图片，远程帧会先下载（默认上限 8MB）。
- KIE 分析走 `kie-chat-client` 的流式 + 重试通道，但地址同样来自配置
  （`baseUrl` + `modelPaths`）。
- 本地开发仍会自动启用 `HTTPS_PROXY` / `HTTP_PROXY`，生产环境不启用。
- **改 `config/ai-providers.json` 或环境变量仍需重启**：它们只在进程启动时读取。
  想不重启就生效，请走设置页 / `/api/settings/ai-provider`（写数据库）。
- 分析页的模型选择器来自**当前用户**的提供商目录（`lib/ai/analysis-options.ts`），
  模型名取各提供商的 `defaultModel`；KIE 各模型的通道路径在 `modelPaths` 里维护。
- 在线配置存在 `ai_settings` 表里（一个用户一行，主键 = `user.id`）。最新迁移：
  `drizzle/0006_common_beyonder.sql`（放宽主键列宽 + 把旧的 `global` 行归属给 `updated_by`），
  更早的 `drizzle/0005_unknown_silver_fox.sql` 建表并把 `user_api_keys.provider` 改成 `varchar(64)`。
  部署前先执行 `pnpm db:migrate`。
- **历史库（用 `db:push` 建、记录表为空）直接 `db:migrate` 会报 `type "xxx" already exists`**：
  drizzle 迁移器只取 `drizzle.__drizzle_migrations` 里 `created_at` 最大的一行做比较，
  记录表为空时它会从 `0000` 重放。先跑 `pnpm db:baseline` 补一条 0004 基线
  （脚本会校验 0000~0004 的产物是否真的存在），再执行 `pnpm db:migrate` 就只跑 0005。
  注意 `db:baseline` 与 `db:migrate` 都必须使用 Neon **直连**地址（去掉 `-pooler`）。
- 并发写入没有乐观锁：同一用户的多标签页同时编辑以最后一次写入为准，实际操作频率极低。
