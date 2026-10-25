import { ensureProviderCatalogFresh, getProviderCatalog, getProviderConfig } from "./config";
import { ProviderApiKeyError } from "./errors";
import { readOwnApiKey, readPlatformApiKey } from "./keys";
import type { ProviderScope } from "./store";
import type { ProviderConfig } from "./types";
import { loadUserProviderApiKey } from "./user-keys";

export interface ResolveProviderKeyOptions {
  /** 谁在用这把 Key：决定读哪一份在线配置 / 用户密钥 */
  scope: ProviderScope;
  /** 显式指定的 Key（例如平台配额路径下选定的平台 Key），优先级最高 */
  apiKey?: string;
  /** 是否允许使用用户保存的 Key，默认由 provider.keyStrategy 决定 */
  allowUserKey?: boolean;
  /** 是否允许使用平台环境变量 Key，默认由 provider.keyStrategy 决定 */
  allowPlatformKey?: boolean;
}

/**
 * 密钥优先级：显式传入 > 用户自己的 Key（设置页保存 > user_api_keys）> 平台 Key（仅管理员）。
 *
 * 调用前会先确保该用户的在线配置快照是新鲜的，并按 id 重新取一次提供商配置，
 * 这样用户在设置页换了 Key / baseUrl 之后，下一次请求就用新值。
 *
 * 平台试用已经移除：非管理员永远不会读到 `apiKeyEnv` / 内联 `apiKey`，
 * 没有自己的 Key 就是没有 Key，调用方会拿到明确的错误。
 */
export async function resolveProviderApiKey(
  provider: ProviderConfig,
  options: ResolveProviderKeyOptions,
): Promise<string | null> {
  const explicit = options.apiKey?.trim();
  if (explicit) return explicit;

  await ensureProviderCatalogFresh(options.scope);

  // 用最新快照里的同 id 配置，丢弃调用方可能持有的旧对象
  let fresh = provider;
  try {
    fresh = getProviderConfig(options.scope, provider.id);
  } catch {
    // 提供商已被移除或停用时，继续用传入的配置，让上层给出更明确的错误
  }

  const allowUserKey = options.allowUserKey ?? fresh.keyStrategy !== "platform";
  // 服务端环境变量 Key 只给管理员（部署方）用：普通用户必须自带 Key，杜绝"蹭平台额度"
  const scopeCanUsePlatformKey = getProviderCatalog(options.scope).definitionsEditable;
  const allowPlatformKey = scopeCanUsePlatformKey
    && (options.allowPlatformKey ?? fresh.keyStrategy !== "user");

  if (allowUserKey) {
    const ownKey = readOwnApiKey(fresh);
    if (ownKey) return ownKey;

    if (options.scope) {
      const userKey = await loadUserProviderApiKey(options.scope, fresh.id);
      if (userKey) return userKey;
    }
  }

  return allowPlatformKey ? readPlatformApiKey(fresh) : null;
}

/** 同上，但拿不到 Key 时直接抛出带指引的错误 */
export async function requireProviderApiKey(
  provider: ProviderConfig,
  options: ResolveProviderKeyOptions,
): Promise<string> {
  const apiKey = await resolveProviderApiKey(provider, options);
  if (!apiKey) throw new ProviderApiKeyError(provider.id, provider.label, provider.apiKeyEnv);
  return apiKey;
}
