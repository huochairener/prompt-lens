import {
  ensureProviderCatalogFresh,
  findProvider,
  getProviderCatalog,
  getLocalActiveProviderId,
  setLocalActiveProvider,
} from "./config";
import { ProviderConfigError } from "./errors";
import type { ProviderConfig } from "./types";

/**
 * 当前生效的提供商。
 *
 * 优先级：进程内临时覆盖 > 在线配置（数据库）> 环境变量 AI_ACTIVE_PROVIDER > 配置文件 defaultProvider。
 * 在线配置存在数据库里，写入后会立刻刷新内存快照，因此多实例部署下也能在
 * AI_CONFIG_CACHE_MS（默认 2s）内自动追上，不需要重启。
 */
export function getDefaultProviderId(): string {
  return getProviderCatalog().defaultProviderId;
}

export function getActiveProviderId(): string {
  return getLocalActiveProviderId() ?? getProviderCatalog().activeProviderId;
}

/**
 * 异步版：先对齐在线配置再返回当前提供商 id。
 *
 * 请求入口请用这个而不是同步的 getActiveProviderId——新版进程第一次收到请求时，
 * 内存里还只有文件基线，直接读会拿到默认提供商而不是后台切换过的那个。
 */
export async function resolveActiveProviderId(): Promise<string> {
  await ensureProviderCatalogFresh();
  return getActiveProviderId();
}

export function isActiveProvider(providerId: string): boolean {
  return getActiveProviderId() === providerId;
}

/**
 * 仅进程内的临时切换（不写库）。
 * 需要"改完立刻生效且重启后仍保留"请用 admin.saveActiveProvider。
 */
export function setActiveProvider(providerId: string): ProviderConfig {
  const provider = assertProviderUsable(providerId);
  setLocalActiveProvider(providerId);
  return provider;
}

/** 撤销进程内临时切换，回到数据库/环境变量/文件决定的提供商 */
export function resetActiveProvider(): void {
  setLocalActiveProvider(null);
}

export function getActiveProvider(): ProviderConfig {
  const providerId = getActiveProviderId();
  const provider = findProvider(providerId);
  if (!provider || !provider.enabled) {
    throw new ProviderConfigError(`当前 AI 提供商 ${providerId} 不可用，请切换或检查配置`);
  }
  return provider;
}

/**
 * 校验提供商可用（切换时的前置检查）。
 * 真正的持久化切换请用 admin.saveActiveProvider（会写库并刷新快照）。
 */
export function assertProviderUsable(providerId: string): ProviderConfig {
  const provider = findProvider(providerId);
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
  /** 文件里内联了 Key（不推荐） */
  hasInlineKey: boolean;
  /** 后台在线保存了 Key */
  hasStoredKey: boolean;
  /** 环境变量里存在 Key */
  hasEnvKey: boolean;
  /** 最终会用到的 Key 来源，没有则是 none */
  keySource: "stored" | "inline" | "env" | "none";
  /** 在线保存的 Key 尾号，例如 "…a1b2" */
  keyHint?: string;
  /** 是否为后台在线新增的提供商 */
  custom: boolean;
  /** 被在线配置覆盖的字段名 */
  overriddenFields: string[];
  active: boolean;
  /** 是否启用（停用后不会出现在可切换列表里） */
  enabled: boolean;
  /** 生效的模型（defaultModel 可能被在线覆盖） */
  effectiveModel?: string;
}

function hasEnvKey(provider: ProviderConfig, env: Record<string, string | undefined>): boolean {
  return provider.apiKeyEnv.some((name) => Boolean(env[name]?.trim()));
}

/**
 * 给设置页 / API 用的脱敏视图，不暴露任何密钥内容。
 * `includeDisabled` 为 true 时也返回停用的提供商（设置页需要能把它们重新启用）。
 */
export function describeProviders(
  env: Record<string, string | undefined> = process.env,
  options: { includeDisabled?: boolean } = {},
): ProviderStatus[] {
  const activeId = getActiveProviderId();

  return getProviderCatalog().providers
    .filter((provider) => options.includeDisabled || provider.enabled)
    .map((provider) => {
      const inline = Boolean(provider.apiKey?.trim());
      const stored = Boolean(provider.secretApiKey);
      const fromEnv = hasEnvKey(provider, env);
      const keySource: ProviderStatus["keySource"] = stored
        ? "stored"
        : inline
          ? "inline"
          : fromEnv
            ? "env"
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
        hasInlineKey: inline,
        hasStoredKey: Boolean(provider.secretHint),
        hasEnvKey: fromEnv,
        keySource,
        keyHint: provider.secretHint,
        custom: provider.custom,
        overriddenFields: provider.overriddenFields,
        active: provider.id === activeId,
        enabled: provider.enabled,
        effectiveModel: provider.defaultModel,
      };
    });
}
