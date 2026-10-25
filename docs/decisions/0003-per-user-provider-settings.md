# ADR 0003：AI 提供商配置按用户隔离

- 状态：已接受
- 日期：2026-10-25

## 背景

`ai_settings` 原本是单行表（`id = 'global'`）：谁在设置页配的提供商、模型、Key 都写进这一行，
所有登录用户读同一份。这带来两个问题：

1. **隐私**：一个用户新增的提供商（含 baseUrl、模型、Key 尾号）会出现在别人的设置页和视频分析页，
   别人还能直接用它发起调用，消耗这个用户的 Key。
2. **权限**：写接口要求管理员，普通用户既不能配自己的提供商，也没法把别人的配置挡在外面。

产品要求：**配置跟着账号走**——我配的提供商只有我能看到、只有我能用。

## 决策

1. `ai_settings` 主键改为 `user.id`，一个用户一行，存放该用户的 `overrides` / `secrets` / `activeProviderId`。
   升级时把旧的 `'global'` 行归属给 `updated_by`（没有则第一个管理员），避免配置凭空消失。
2. 提供商目录（`lib/ai/providers/config.ts`）改为**按 scope 分桶缓存**：`scope = userId | null`，
   TTL 2s，最多缓存 `AI_CONFIG_MAX_SCOPES`（默认 200）个用户，超出按最久未刷新淘汰。
3. 所有读配置的入口（`getProviderConfig` / `findProvider` / `getActiveProviderId` / `describeProviders` /
   `ensureProviderCatalogFresh` / `createChatCompletion` / `resolveProviderApiKey`）都必须显式传 scope。
   刻意做成**必填参数**而不是从全局或 AsyncLocalStorage 隐式取值：漏传会编译失败，而不是悄悄读到别人的配置。
4. Key 语义拆分：
   - `ai_settings.secrets` = **该用户自己的 Key**（`readOwnApiKey`），只属于当前账号；
   - `apiKeyEnv` / 配置内联 `apiKey` = **服务端 Key**（`readPlatformApiKey`），只有管理员可用。
   两者不再混在同一个字段里，否则用户自己的 Key 会被误当成平台额度。
   （后续 [ADR 0004](./0004-remove-platform-trial.md) 进一步移除了平台试用。）
5. 写接口不再要求管理员，每个登录用户只写自己那一行。边界：
   - 非管理员不能改内置提供商的 `protocol` / `baseUrl` / `path`，也不能设置 `apiKeyEnv`；
   - 在线新增的提供商对非管理员会强制剥掉 `apiKeyEnv`，只能用自己保存的 Key。

   如果允许改 baseUrl + 引用环境变量，普通用户就能把平台 Key 发到自己的服务器上。

## 备选方案

### 继续用全局配置，只按 key 前缀区分

无法解决「别人看得到我的提供商列表」，也挡不住别人直接调用，否决。

### 用 AsyncLocalStorage 隐式传 scope

改动面小，但漏设上下文时会静默退化成全局配置——正好是这次要消灭的失败模式，否决。

### 保留一个系统级平台 Key 池给所有用户

可以让普通用户继续享有平台试用，但需求方明确表示不需要保留试用，最终按
[ADR 0004](./0004-remove-platform-trial.md) 移除：服务端 Key 只有管理员可用。

## 后果

- 新增依赖：无。迁移 1 个（`0006_common_beyonder`），只放宽列宽 + 迁移数据。
- 管理员以前在设置页保存的 Key 会变成「管理员自己的 Key」；普通用户必须自带 Key
  （平台试用已在 [ADR 0004](./0004-remove-platform-trial.md) 中移除）。
- 单实例内存占用随活跃用户数增长，上限由 `AI_CONFIG_MAX_SCOPES` 控制。
- 用户 Key 解密仍依赖 `BETTER_AUTH_SECRET`；轮换密钥会让旧密文失效并回退到环境变量。
