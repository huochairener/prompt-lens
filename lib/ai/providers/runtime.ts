import {
  ensureProviderCatalogFresh,
  findProvider,
  getProviderCatalog,
  getLocalActiveProviderId,
  setLocalActiveProvider,
} from "./config";
import { ProviderConfigError } from "./errors";
import { readOwnApiKey, readPlatformApiKey } from "./keys";
import type { ProviderScope } from "./store";
import type { ProviderConfig } from "./types";

/**
 * 当前生效的提供商（**每个用户各自一份**）。
 *
 * 优先级：进程内临时覆盖 > 该用户的在线配置（数据库）> 环境变量 AI_ACTIVE_PROVIDER > 配置文件 defaultProvider。
 * 在线配置放在 `ai_settings`（主键 = user.id），写入后会立刻刷新该用户的快照，
 * 因此多实例部署下也能在 AI_CONFIG_CACHE_MS（默认 2s）内自动追上。
 */
export function getDefaultProviderId(scope: ProviderScope): string {
  return getProviderCatalog(scope).defaultProviderId;
}

export function getActiveProviderId(scope: ProviderScope): string {
  return getLocalActiveProviderId(scope) ?? getProviderCatalog(scope).activeProviderId;
}

/**
 * 异步版：先对齐该用户的在线配置再返回当前提供商 id。
 *
 * 请求入口请用这个而不是同步的 getActiveProviderId——新版进程第一次收到请求时，
 * 内存里还只有文件基线，直接读会拿到默认提供商而不是用户在设置页切过的那个。
 */
export async function resolveActiveProviderId(scope: ProviderScope): Promise<string> {
  await ensureProviderCatalogFresh(scope);
  return getActiveProviderId(scope);
}

export function isActiveProvider(scope: ProviderScope, providerId: string): boolean {
  return getActiveProviderId(scope) === providerId;
}

/**
 * 仅进程内的临时切换（不写库），按用户隔离。
 * 需要"改完立刻生效且重启后仍保留"请用 admin.saveActiveProvider。
 */
export function setActiveProvider(scope: ProviderScope, providerId: string): ProviderConfig {
  const provider = assertProviderUsable(scope, providerId);
  setLocalActiveProvider(scope, providerId);
  return provider;
}

/** 撤销进程内临时切换，回到数据库/环境变量/文件决定的提供商 */
export function resetActiveProvider(scope: ProviderScope): void {
  setLocalActiveProvider(scope, null);
}

export function getActiveProvider(scope: ProviderScope): ProviderConfig {
  const providerId = getActiveProviderId(scope);
  const provider = findProvider(scope, providerId);
  if (!provider || !provider.enabled) {
    throw new ProviderConfigError(`当前 AI 提供商 ${providerId} 不可用，请切换或检查配置`);
  }
  return provider;
}

/**
 * 校验提供商在该用户的目录里可用（切换时的前置检查）。
 * 真正的持久化切换请用 admin.saveActiveProvider（会写库并刷新快照）。
 */
export function assertProviderUsable(scope: ProviderScope, providerId: string): ProviderConfig {
  const provider = findProvider(scope, providerId);
  if (!provider) {
    throw new ProviderConfigError(`未知的 AI 提供商：${providerId}`);
  }
  if (!provider.enabled) {
    throw new ProviderConfigError(`AI 提供商 ${providerId} 已被停用`);
  }
  return provider;
}

export interface ProviderStatus {
  id: string;
  label: string;
  protocol: ProviderConfig["protocol"];
  baseUrl: string;
  path: string;
  defaultModel?: string;
  maxOutputTokens: number;
  timeoutMs: number;
  temperature?: number;
  keyStrategy: ProviderConfig["keyStrategy"];
  /** 该用户自己在设置页保存了 Key */
  hasOwnKey: boolean;
  /** 用户 Key 的尾号，例如 "…a1b2" */
  keyHint?: string;
  /** 平台侧（内联 / 环境变量）Key 可用：只对管理员有意义 */
  hasPlatformKey: boolean;
  /** 最终会用到的 Key 来源：own = 用户自己的，platform = 管理员的服务端 Key，none = 都没有 */
  keySource: "own" | "platform" | "none";
  /** 是否为在线新增的提供商 */
  custom: boolean;
  /** 被在线配置覆盖的字段名 */
  overriddenFields: string[];
  active: boolean;
  /** 是否启用（停用后不会出现在可切换列表里） */
  enabled: boolean;
  /** 生效的模型（defaultModel 可能被在线覆盖） */
  effectiveModel?: string;
  /** 该用户能否修改连接信息（协议 / baseUrl / 路径）；管理员限定 */
  editable: boolean;
}

/**
 * 给设置页 / API 用的脱敏视图，不暴露任何密钥内容。
 * `includeDisabled` 为 true 时也返回停用的提供商（设置页需要能把它们重新启用）。
 */
export function describeProviders(
  scope: ProviderScope,
  env: Record<string, string | undefined> = process.env,
  options: { includeDisabled?: boolean } = {},
): ProviderStatus[] {
  const catalog = getProviderCatalog(scope);
  const activeId = getActiveProviderId(scope);

  return catalog.providers
    .filter((provider) => options.includeDisabled || provider.enabled)
    .map((provider) => {
      const ownKey = Boolean(readOwnApiKey(provider));
      // 非管理员拿不到服务端 Key，所以这里直接按"不可用"展示，避免误导
      const platformKey = catalog.definitionsEditable && Boolean(readPlatformApiKey(provider, env));
      const keySource: ProviderStatus["keySource"] = ownKey
        ? "own"
        : platformKey
          ? "platform"
          : "none";

      return {
        id: provider.id,
        label: provider.label,
        protocol: provider.protocol,
        baseUrl: provider.baseUrl,
        path: provider.path,
        defaultModel: provider.defaultModel,
        maxOutputTokens: provider.maxOutputTokens,
        timeoutMs: provider.timeoutMs,
        temperature: provider.temperature,
        keyStrategy: provider.keyStrategy,
        hasOwnKey: ownKey,
        keyHint: provider.secretHint,
        hasPlatformKey: platformKey,
        keySource,
        custom: provider.custom,
        overriddenFields: provider.overriddenFields,
        active: provider.id === activeId,
        enabled: provider.enabled,
        effectiveModel: provider.defaultModel,
        editable: catalog.definitionsEditable,
      };
    });
}
