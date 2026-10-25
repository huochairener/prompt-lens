import type { ProviderConfig } from "./types";

/**
 * 用户自备 Key 的适用范围。
 *
 * user_api_keys.provider 已从 pg enum 改为 varchar(64)，因此任何在
 * config/ai-providers.json 或后台在线新增的提供商都能保存用户 Key。
 * 是否真的允许用户自备，仍由 provider.keyStrategy 决定。
 */
export function isUserKeyProvider(providerId: string): boolean {
  return typeof providerId === "string" && providerId.trim().length > 0;
}

/**
 * 该用户自己在设置页保存的 Key（ai_settings.secrets，主键就是 user.id）。
 *
 * 它只属于当前账号：别人读不到这份密文，也不会出现在别人的提供商列表里。
 */
export function readOwnApiKey(provider: ProviderConfig): string | null {
  return provider.secretApiKey?.trim() || null;
}

/**
 * 读取服务端密钥：配置内联 `apiKey` > 环境变量 `apiKeyEnv`。
 *
 * **只有管理员（部署方）的调用能用到它**（见 resolve-key.ts）。
 * 普通用户的自定义提供商也不允许配置 `apiKeyEnv`（见 config.ts 的 sanitizeOverride），
 * 否则就能把 baseUrl 指向自己的服务器顺走服务端 Key。
 */
export function readPlatformApiKey(
  provider: ProviderConfig,
  env: Record<string, string | undefined> = process.env,
): string | null {
  const inline = provider.apiKey?.trim();
  if (inline) return inline;

  for (const name of provider.apiKeyEnv) {
    const value = env[name]?.trim();
    if (value) return value;
  }

  return null;
}
