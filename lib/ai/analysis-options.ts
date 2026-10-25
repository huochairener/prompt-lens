import { resolveLegacyAnalysisModel } from "./analysis-models";
import {
  ensureProviderCatalogFresh,
  findProvider,
  getProviderCatalog,
} from "./providers/config";
import { readOwnApiKey, readPlatformApiKey } from "./providers/keys";
import { getActiveProviderId } from "./providers/runtime";
import type { ProviderConfig, ProviderKeyStrategy } from "./providers/types";

/**
 * 视频分析页的模型来源。
 *
 * 可选模型 = **当前用户**提供商目录里每个启用的提供商（模型取它的 defaultModel）。
 * 平台试用通道已移除：分析只花用户自己的 Key，没有额度、没有共享密钥。
 *
 * 所有函数都以 `scope`（= userId）为第一参数：别人的提供商不会出现在你的列表里。
 */

/** 下拉框里「某个提供商的模型」的取值前缀 */
export const PROVIDER_OPTION_PREFIX = "provider:";

export type AnalysisFunding = "platform" | "user";

export type AnalysisUnavailableReason = "key_required" | "model_missing";

export interface AnalysisModelOption {
  /** 下拉框的值：`provider:<id>` */
  id: string;
  kind: "provider";
  providerId: string;
  /** 实际发给上游的模型名；提供商没配置模型时为空 */
  model: string;
  /** 提供商展示名 */
  label: string;
  /** 谁出钱：user = 用户自己的 Key；platform = 管理员自己的服务端 Key */
  funding: AnalysisFunding;
  available: boolean;
  unavailableReason?: AnalysisUnavailableReason;
}

export interface AnalysisTarget {
  /** 命中的下拉项 id，写进操作日志 */
  optionId: string;
  providerId: string;
  model: string;
  keyPolicy: ProviderKeyStrategy;
  label: string;
}

function platformFundingOf(strategy: ProviderKeyStrategy): AnalysisFunding {
  return strategy === "user" ? "user" : "platform";
}

/**
 * 单个提供商 → 下拉项（纯函数，方便测试）。
 *
 * `hasPlatformKey` 由调用方按「是否管理员」过滤过：普通用户的目录里它恒为 false，
 * 因为服务端环境变量 Key 只给部署方（管理员）自己用。
 */
export function describeProviderOption(input: {
  provider: ProviderConfig;
  hasUserKey: boolean;
  hasPlatformKey: boolean;
}): AnalysisModelOption {
  const { provider, hasUserKey, hasPlatformKey } = input;
  const model = provider.defaultModel?.trim() ?? "";
  const allowsUser = provider.keyStrategy !== "platform";
  const allowsPlatform = provider.keyStrategy !== "user";

  const base = {
    id: `${PROVIDER_OPTION_PREFIX}${provider.id}`,
    kind: "provider" as const,
    providerId: provider.id,
    model,
    label: provider.label,
  };

  if (!model) {
    return {
      ...base,
      funding: platformFundingOf(provider.keyStrategy),
      available: false,
      unavailableReason: "model_missing",
    };
  }

  if (allowsUser && hasUserKey) {
    return { ...base, funding: "user", available: true };
  }

  if (allowsPlatform && hasPlatformKey) {
    return { ...base, funding: "platform", available: true };
  }

  return {
    ...base,
    funding: allowsPlatform ? "platform" : "user",
    available: false,
    unavailableReason: "key_required",
  };
}

/** 读取 user_api_keys 里该用户的 Key（数据库惰加载，保证没配 DATABASE_URL 时也能降级） */
async function readUserTableKey(userId: string, providerId: string): Promise<string | null> {
  try {
    const { loadUserProviderApiKey } = await import("./providers/user-keys");
    return (await loadUserProviderApiKey(userId, providerId))?.trim() || null;
  } catch (error) {
    console.warn(
      `[analysis-models] 读取用户 Key 失败，按未配置处理：${
        error instanceof Error ? error.message : String(error)
      }`,
    );
    return null;
  }
}

/**
 * 当前用户可选的分析模型列表 + 默认选项。
 * 默认优先「当前生效的提供商」，其次第一个可用项。
 */
export async function listAnalysisModelOptions(
  scope: string,
): Promise<{ options: AnalysisModelOption[]; defaultId: string | null }> {
  await ensureProviderCatalogFresh(scope);

  const catalog = getProviderCatalog(scope);
  const activeProviderId = getActiveProviderId(scope);
  // 环境变量里的 Key 只给管理员用，普通用户必须自带 Key
  const allowPlatformKey = catalog.definitionsEditable;

  const options = await Promise.all(
    catalog.providers
      .filter((provider) => provider.enabled)
      .map(async (provider) =>
        describeProviderOption({
          provider,
          hasUserKey: provider.keyStrategy !== "platform"
            && (Boolean(readOwnApiKey(provider)) || Boolean(await readUserTableKey(scope, provider.id))),
          hasPlatformKey: allowPlatformKey && Boolean(readPlatformApiKey(provider)),
        }),
      ),
  );

  const defaultId =
    options.find((option) => option.providerId === activeProviderId && option.available)?.id
    ?? options.find((option) => option.available)?.id
    ?? options[0]?.id
    ?? null;

  return { options, defaultId };
}

/**
 * 解析客户端传来的模型选择，只在该用户自己的目录里查找。
 *
 * 支持三种写法（从新到旧）：
 *   - `provider:<id>` —— 模型取该提供商配置的 defaultModel，客户端不能自带模型名
 *   - 旧版固定 id（platform-gemini-* / kie-gemini-*）—— 兼容已打开的页面，同样只用用户 Key
 *   - 直接传 providerId / model —— 给接口调用方留的后门
 */
export async function resolveAnalysisTarget(
  scope: string,
  input: {
    analysisModel?: unknown;
    providerId?: unknown;
    model?: unknown;
    /** 旧版 body.provider 字段 */
    legacyProvider?: unknown;
  },
): Promise<AnalysisTarget | null> {
  await ensureProviderCatalogFresh(scope);

  const requested = typeof input.analysisModel === "string" ? input.analysisModel.trim() : "";

  if (requested.startsWith(PROVIDER_OPTION_PREFIX)) {
    const providerId = requested.slice(PROVIDER_OPTION_PREFIX.length).trim();
    const provider = providerId ? findProvider(scope, providerId) : null;
    if (!provider || !provider.enabled || !provider.defaultModel?.trim()) return null;

    return {
      optionId: requested,
      providerId: provider.id,
      model: provider.defaultModel.trim(),
      keyPolicy: provider.keyStrategy,
      label: provider.label,
    };
  }

  const legacy = resolveLegacyAnalysisModel(requested);
  if (legacy) {
    const provider = findProvider(scope, legacy.provider);
    if (!provider || !provider.enabled) return null;

    return {
      optionId: requested,
      providerId: legacy.provider,
      model: legacy.model,
      // 旧 id 不再有平台出资一说，按该提供商的策略解析（KIE 即"只用用户 Key"）
      keyPolicy: provider.keyStrategy,
      label: provider.label,
    };
  }

  const explicitProviderId =
    (typeof input.providerId === "string" ? input.providerId.trim() : "")
    || (typeof input.legacyProvider === "string" ? input.legacyProvider.trim() : "");

  if (explicitProviderId) {
    const provider = findProvider(scope, explicitProviderId);
    if (!provider || !provider.enabled) return null;

    const requestedModel = typeof input.model === "string" ? input.model.trim() : "";
    const model = requestedModel || provider.defaultModel?.trim() || "";
    if (!model) return null;

    return {
      optionId: `${PROVIDER_OPTION_PREFIX}${provider.id}`,
      providerId: provider.id,
      model,
      keyPolicy: provider.keyStrategy,
      label: provider.label,
    };
  }

  return null;
}

export type AnalysisKeyResult =
  | { ok: true; apiKey: string; apiKeySource: "user" | "platform" }
  | { ok: false; status: number; code: string; error: string };

/**
 * 按目标解析实际使用的 Key（只查当前用户）。
 *
 * 顺序：用户自己的 Key（设置页 > user_api_keys）> 管理员的服务端 Key。
 * 普通用户没有回退：分析必须用你自己的 Key，不存在平台出资。
 */
export async function resolveAnalysisKey(
  scope: string,
  target: AnalysisTarget,
): Promise<AnalysisKeyResult> {
  await ensureProviderCatalogFresh(scope);

  const provider = findProvider(scope, target.providerId);
  if (!provider || !provider.enabled) {
    return {
      ok: false,
      status: 400,
      code: "PROVIDER_UNAVAILABLE",
      error: `AI 提供商 ${target.providerId} 不存在或已停用，请检查设置`,
    };
  }

  if (target.keyPolicy !== "platform") {
    const ownKey = readOwnApiKey(provider) || (await readUserTableKey(scope, provider.id));
    if (ownKey) {
      return { ok: true, apiKey: ownKey, apiKeySource: "user" };
    }
  }

  // 服务端环境变量 Key 只给管理员自己用，避免普通用户蹭部署方的 Key
  if (getProviderCatalog(scope).definitionsEditable) {
    const platformKey = readPlatformApiKey(provider);
    if (platformKey) {
      return { ok: true, apiKey: platformKey, apiKeySource: "platform" };
    }
  }

  return {
    ok: false,
    status: 400,
    code: "USER_KEY_REQUIRED",
    error: `请先在设置中保存自己的 ${provider.label} API Key`,
  };
}
