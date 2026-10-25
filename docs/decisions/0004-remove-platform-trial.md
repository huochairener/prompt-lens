# ADR 0004：移除平台试用

- 状态：已接受
- 日期：2026-10-25
- 关联：[ADR 0003 提供商配置按用户隔离](./0003-per-user-provider-settings.md)

## 背景

平台试用是一个共享方案：所有用户共用部署方的 KIE / OpenRouter Key，靠「每人 2 次」的额度兜底
（`TRIAL_USAGE_LIMIT`）。ADR 0003 把提供商配置改成按用户隔离之后，这个通道成了唯一的共享密钥入口：

- 管理员在线保存的 Key 已经变成他个人的 Key，普通用户拿到的其实是环境变量里的 Key；
- 额度计数按 `operationLogs.metadata->>'apiKeySource' = 'platform'` 统计，只是"事后记账"，
  真正防不住并发刷；
- 用户明确要求「我配的 Key 只给我用」，平台试用与这个目标直接冲突。

## 决策

1. 删除分析页的「平台试用」通道（`platform-gemini-3.8-flash`）与 `assertTrialQuota` / `/api/analyze/quota`，
   同时移除 `TRIAL_USAGE_LIMIT`。
2. 环境变量 / 内联 Key 改为**只有管理员（部署方）可用**：`resolveProviderApiKey` 用目录快照里的
   `definitionsEditable` 判断，非管理员直接跳过平台 Key。
3. 分析只花用户自己的 Key：设置页保存的 `ai_settings.secrets` 或 `user_api_keys`。
   没有 Key 就返回 400 `USER_KEY_REQUIRED`，提示去设置页配置。
4. 旧版固定 id（`platform-gemini-*` / `kie-gemini-*`）保留解析，但一律按用户 Key 处理，
   避免已打开的页面直接 500。
5. 内置 `openrouter` 的 `keyStrategy` 从 `platform` 改为 `either`，
   否则普通用户既拿不到服务端 Key、也无法使用自己填的 OpenRouter Key。

## 备选方案

### 保留试用，但把额度调小 / 按 IP 限流

仍然是共享密钥，只是提高了门槛，不解决「别人用我的 Key」，否决。

### 只给管理员保留平台 Key

这正是本轮采纳的行为（管理员可以用自己的服务端 Key），但没有独立的「试用」产品或额度概念。

### 增加一个 `id='system'` 的公共 Key 池

可以让试用继续存在，但需求方明确表示不需要保留试用，因此不引入额外一张设置行。

## 后果

- 普通用户首次使用前必须自己配置 Key；设置页会明确提示，模型下拉里没有 Key 的项直接置灰。
- 服务端环境变量 Key 只影响管理员自己的调用，不再产生跨用户成本。
- 操作日志里的 `apiKeySource` 仍然记录 `user` / `platform`，便于管理员审计自己的调用。
- 数据库里历史 `analysis.complete` 记录的 `apiKeySource` 无需迁移，只是不再参与额度计算。
