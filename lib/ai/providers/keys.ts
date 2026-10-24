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
 * 读取平台侧密钥。
 * 优先级：后台在线保存的 Key > 配置内联 apiKey > 环境变量 apiKeyEnv。
 * 在线 Key 排在最前面，保证管理员在设置页换 Key 后立刻生效。
 */
export function readPlatformApiKey(
  provider: ProviderConfig,
  env: Record<string, string | undefined> = process.env,
): string | null {
  const stored = provider.secretApiKey?.trim();
  if (stored) return stored;

  const inline = provider.apiKey?.trim();
  if (inline) return inline;

  for (const name of provider.apiKeyEnv) {
    const value = env[name]?.trim();
    if (value) return value;
  }

  return null;
}
