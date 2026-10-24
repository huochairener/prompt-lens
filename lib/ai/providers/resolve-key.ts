import { ensureProviderCatalogFresh, getProviderConfig } from "./config";
import { ProviderApiKeyError } from "./errors";
import { readPlatformApiKey } from "./keys";
import type { ProviderConfig } from "./types";
import { loadUserProviderApiKey } from "./user-keys";

export interface ResolveProviderKeyOptions {
  /** 需要读取用户自备 Key 时传入 */
  userId?: string;
  /** 显式指定的 Key（例如平台配额路径下选定的平台 Key），优先级最高 */
  apiKey?: string;
  /** 是否允许使用用户保存的 Key，默认由 provider.keyStrategy 决定 */
  allowUserKey?: boolean;
  /** 是否允许使用平台环境变量 Key，默认由 provider.keyStrategy 决定 */
  allowPlatformKey?: boolean;
}

/**
 * 密钥优先级：显式传入 > 用户自备（若允许）> 后台在线 Key > 配置内联 > 平台环境变量。
 *
 * 调用前会先确保在线配置快照是新鲜的，并按 id 重新取一次提供商配置，
 * 这样管理员在设置页换了 Key / baseUrl 之后，下一次请求就用新值。
 */
export async function resolveProviderApiKey(
  provider: ProviderConfig,
  options: ResolveProviderKeyOptions = {},
): Promise<string | null> {
  const explicit = options.apiKey?.trim();
  if (explicit) return explicit;

  await ensureProviderCatalogFresh();

  // 用最新快照里的同 id 配置，丢弃调用方可能持有的旧对象
  let fresh = provider;
  try {
    fresh = getProviderConfig(provider.id);
  } catch {
    // 提供商已被移除或停用时，继续用传入的配置，让上层给出更明确的错误
  }

  const allowUserKey = options.allowUserKey ?? fresh.keyStrategy !== "platform";
  const allowPlatformKey = options.allowPlatformKey ?? fresh.keyStrategy !== "user";

  if (allowUserKey && options.userId) {
    const userKey = await loadUserProviderApiKey(options.userId, fresh.id);
    if (userKey) return userKey;
  }

  return allowPlatformKey ? readPlatformApiKey(fresh) : null;
}

/** 同上，但拿不到 Key 时直接抛出带指引的错误 */
export async function requireProviderApiKey(
  provider: ProviderConfig,
  options: ResolveProviderKeyOptions = {},
): Promise<string> {
  const apiKey = await resolveProviderApiKey(provider, options);
  if (!apiKey) throw new ProviderApiKeyError(provider.id, provider.label, provider.apiKeyEnv);
  return apiKey;
}
