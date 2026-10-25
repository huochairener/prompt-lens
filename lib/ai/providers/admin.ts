import { z } from "zod";
import { createChatCompletion } from "./client";
import {
  findProvider,
  isBaseProvider,
  refreshProviderCatalog,
  setLocalActiveProvider,
} from "./config";
import { ProviderConfigError } from "./errors";
import { readOwnApiKey } from "./keys";
import { resolveProviderApiKey } from "./resolve-key";
import { assertProviderUsable } from "./runtime";
import { encryptSecret, readAiSettings, writeAiSettings, decryptSecret } from "./store";
import { isProviderProtocol, PROVIDER_PROTOCOLS, type ProviderOverride } from "./types";

/**
 * 提供商在线管理（服务端专用）。
 *
 * 每个用户只读写自己的那一行（`ai_settings.id = user.id`），所以「我配的提供商」
 * 天然只对我可见。所有写操作都是"读当前设置 → 改一份 → 整行写回 → 立刻刷新快照"，
 * 因此不需要重启进程；其他实例会在 AI_CONFIG_CACHE_MS 内自动追上。
 *
 * 权限边界（非管理员）：
 *   - 不能改内置提供商的 protocol / baseUrl / path（否则可把平台 Key 引到自己服务器）
 *   - 不能配置 apiKeyEnv（同上）
 *   - 在线新增的提供商只能用自己保存的 Key
 */

const PROVIDER_ID_PATTERN = /^[a-z0-9][a-z0-9_-]{0,63}$/i;

export const providerUpsertSchema = z.object({
  id: z.string().trim().min(1).max(64).regex(PROVIDER_ID_PATTERN, "id 只能包含字母、数字、下划线和短横线"),
  label: z.string().trim().max(80).optional(),
  protocol: z.enum(PROVIDER_PROTOCOLS).optional(),
  baseUrl: z.string().trim().max(500).optional(),
  path: z.string().trim().max(500).optional(),
  /** 归一化后写入 override.defaultModel */
  model: z.string().trim().max(200).optional(),
  maxOutputTokens: z.number().int().positive().max(200_000).optional(),
  timeoutMs: z.number().int().positive().max(600_000).optional(),
  temperature: z.number().min(0).max(2).optional(),
  keyStrategy: z.enum(["platform", "user", "either"]).optional(),
  apiKeyEnv: z.array(z.string().trim().min(1)).max(10).optional(),
  enabled: z.boolean().optional(),
  /** 明文 Key，写入前加密；不传表示保持原样 */
  apiKey: z.string().trim().min(1).max(500).optional(),
  /** 显式清除已保存的 Key */
  clearApiKey: z.boolean().optional(),
  /** true 时 id 已存在会报错，用于"新增"表单 */
  createOnly: z.boolean().optional(),
});

export type ProviderUpsertInput = z.infer<typeof providerUpsertSchema>;

function validateBaseUrl(baseUrl: string): void {
  if (!/^https?:\/\//i.test(baseUrl)) {
    throw new ProviderConfigError(`baseUrl 必须以 http(s):// 开头：${baseUrl}`);
  }
}

/** 从入参里挑出要写进 override 的字段（不含 id/apiKey 等非配置字段） */
function toOverridePatch(input: ProviderUpsertInput): Omit<ProviderOverride, "id"> {
  const patch: Omit<ProviderOverride, "id"> = {};
  if (input.label !== undefined) patch.label = input.label;
  if (input.protocol !== undefined) {
    if (!isProviderProtocol(input.protocol)) throw new ProviderConfigError(`不支持的协议：${input.protocol}`);
    patch.protocol = input.protocol;
  }
  if (input.baseUrl !== undefined) {
    validateBaseUrl(input.baseUrl);
    patch.baseUrl = input.baseUrl;
  }
  if (input.path !== undefined) patch.path = input.path;
  if (input.model !== undefined) patch.defaultModel = input.model;
  if (input.maxOutputTokens !== undefined) patch.maxOutputTokens = input.maxOutputTokens;
  if (input.timeoutMs !== undefined) patch.timeoutMs = input.timeoutMs;
  if (input.temperature !== undefined) patch.temperature = input.temperature;
  if (input.keyStrategy !== undefined) patch.keyStrategy = input.keyStrategy;
  if (input.apiKeyEnv !== undefined) patch.apiKeyEnv = input.apiKeyEnv;
  if (input.enabled !== undefined) patch.enabled = input.enabled;
  return patch;
}

/** 非管理员不能碰的字段：改连接信息等于有机会拿走平台 Key */
function assertScopeCanWrite(
  editable: boolean,
  input: ProviderUpsertInput,
  builtin: boolean,
): void {
  if (editable) return;

  if (input.apiKeyEnv !== undefined) {
    throw new ProviderConfigError("只有管理员可以指定提供商使用的环境变量 Key，请在设置页填写你自己的 Key");
  }
  if (builtin && (input.protocol !== undefined || input.baseUrl !== undefined || input.path !== undefined)) {
    throw new ProviderConfigError("内置提供商的协议 / Base URL / 路径只能由管理员修改");
  }
}

export interface UpsertResult {
  providerId: string;
  created: boolean;
  keyUpdated: boolean;
  keyCleared: boolean;
}

/**
 * 新增或修改提供商（含 baseUrl / 协议 / 模型 / Key），只影响当前用户。
 * 内置提供商只写入改动字段；在线新增的提供商会整条落库（custom=true）。
 */
export async function upsertProvider(
  scope: string,
  input: ProviderUpsertInput,
  updatedBy?: string | null,
): Promise<UpsertResult> {
  const catalog = await refreshProviderCatalog(scope);
  // 预置提供商（文件 / AI_PROVIDERS_CONFIG）的 custom=false；用户自己新增的才是 true
  const existingProvider = findProvider(scope, input.id);
  const builtin = existingProvider ? !existingProvider.custom : isBaseProvider(input.id);

  const settings = await readAiSettings(scope);
  const existing = settings.overrides.find((item) => item.id === input.id);

  if (input.createOnly && (existing || builtin)) {
    throw new ProviderConfigError(`提供商 ${input.id} 已存在，请换一个 id 或直接编辑`);
  }

  assertScopeCanWrite(catalog.definitionsEditable, input, builtin);

  // 在线新增时必须有完整的连接信息
  if (!builtin) {
    const protocol = input.protocol ?? existing?.protocol;
    const baseUrl = input.baseUrl ?? existing?.baseUrl;
    if (!protocol) throw new ProviderConfigError("新增提供商必须指定 protocol");
    if (!baseUrl) throw new ProviderConfigError("新增提供商必须指定 baseUrl");
  }

  const patch = toOverridePatch(input);
  const nextOverride: ProviderOverride = {
    ...existing,
    ...patch,
    id: input.id,
    custom: builtin ? undefined : true,
  };

  const hasConfigChange = Object.keys(patch).length > 0 || !existing;
  const overrides = hasConfigChange
    ? [...settings.overrides.filter((item) => item.id !== input.id), nextOverride]
    : settings.overrides;

  const secrets = { ...settings.secrets };
  let keyUpdated = false;
  let keyCleared = false;

  if (input.clearApiKey) {
    if (secrets[input.id]) {
      delete secrets[input.id];
      keyCleared = true;
    }
  } else if (input.apiKey) {
    try {
      secrets[input.id] = encryptSecret(input.apiKey);
    } catch (error) {
      throw new ProviderConfigError(
        `无法加密 API Key：${error instanceof Error ? error.message : String(error)}`,
      );
    }
    keyUpdated = true;
  }

  // 停用当前生效的提供商会让它失去 active 身份，顺手清掉切换记录避免脏数据
  const activeProviderId =
    input.enabled === false && settings.activeProviderId === input.id
      ? null
      : settings.activeProviderId;

  await writeAiSettings(scope, { ...settings, overrides, secrets, activeProviderId }, updatedBy);
  await refreshProviderCatalog(scope);

  // 确认新配置能被归一化（baseUrl 非法等会被跳过，这里提前暴露而不是等到调用时）
  if (!findProvider(scope, input.id)) {
    throw new ProviderConfigError(
      `配置已保存，但提供商 ${input.id} 无法生效，请检查协议与 baseUrl 是否匹配`,
    );
  }

  return {
    providerId: input.id,
    created: !builtin && !existing,
    keyUpdated,
    keyCleared,
  };
}

/** 删除在线新增的提供商；内置提供商则是"恢复文件默认值" */
export async function removeProviderOverride(
  scope: string,
  providerId: string,
  updatedBy?: string | null,
): Promise<{ mode: "deleted" | "reset" | "none" }> {
  const settings = await readAiSettings(scope);
  const existing = settings.overrides.find((item) => item.id === providerId);
  // 用户自己新增的提供商整条删除；预置提供商只是"恢复默认"
  const provider = findProvider(scope, providerId);
  const customProvider = provider ? provider.custom : Boolean(existing?.custom);

  const secrets = { ...settings.secrets };
  const hadSecret = Boolean(secrets[providerId]);
  if (hadSecret) delete secrets[providerId];

  if (!existing) {
    if (hadSecret) {
      await writeAiSettings(scope, { ...settings, secrets }, updatedBy);
      await refreshProviderCatalog(scope);
      return { mode: "reset" };
    }
    return { mode: "none" };
  }

  const mode = customProvider ? "deleted" : "reset";
  const overrides = settings.overrides.filter((item) => item.id !== providerId);
  const activeProviderId =
    settings.activeProviderId === providerId && mode === "deleted" ? null : settings.activeProviderId;

  await writeAiSettings(scope, { ...settings, overrides, secrets, activeProviderId }, updatedBy);
  await refreshProviderCatalog(scope);
  return { mode };
}

/** 切换当前生效的提供商（写当前用户的那一行 + 立即刷新） */
export async function saveActiveProvider(
  scope: string,
  providerId: string,
  updatedBy?: string | null,
): Promise<void> {
  await refreshProviderCatalog(scope);
  assertProviderUsable(scope, providerId);

  const settings = await readAiSettings(scope);
  await writeAiSettings(scope, { ...settings, activeProviderId: providerId }, updatedBy);
  setLocalActiveProvider(scope, null);
  await refreshProviderCatalog(scope);
}

/** 恢复默认提供商（清掉当前用户的切换记录，回到环境变量/文件默认值） */
export async function resetActiveProviderPersisted(
  scope: string,
  updatedBy?: string | null,
): Promise<void> {
  const settings = await readAiSettings(scope);
  await writeAiSettings(scope, { ...settings, activeProviderId: null }, updatedBy);
  setLocalActiveProvider(scope, null);
  await refreshProviderCatalog(scope);
}

/** 切换模型：只是当前用户 provider 级 defaultModel 的覆盖，不需要重启 */
export async function saveProviderModel(
  scope: string,
  providerId: string,
  model: string,
  updatedBy?: string | null,
): Promise<void> {
  const trimmed = model.trim();
  if (!trimmed) throw new ProviderConfigError("模型名不能为空");
  await upsertProvider(scope, { id: providerId, model: trimmed }, updatedBy);
}

/** 保存当前用户在该提供商下的 Key（只对他自己生效） */
export async function saveProviderKey(
  scope: string,
  providerId: string,
  apiKey: string,
  updatedBy?: string | null,
): Promise<void> {
  await upsertProvider(scope, { id: providerId, apiKey }, updatedBy);
}

/** 清除当前用户保存的 Key（回退到 user_api_keys / 平台 Key） */
export async function clearProviderKey(
  scope: string,
  providerId: string,
  updatedBy?: string | null,
): Promise<void> {
  await upsertProvider(scope, { id: providerId, clearApiKey: true }, updatedBy);
}

export interface ProviderTestResult {
  ok: boolean;
  providerId: string;
  model: string;
  endpoint: string;
  latencyMs: number;
  /** 这次测试用的是谁的 Key */
  keySource: "own" | "platform";
  reply?: string;
  error?: string;
}

/**
 * 连通性测试：用当前用户实际会用的 Key 发一条最小请求。
 * 优先用户自己的 Key，没有才退回平台 Key。
 */
export async function testProvider(
  scope: string,
  providerId: string,
): Promise<ProviderTestResult> {
  await refreshProviderCatalog(scope);
  const provider = assertProviderUsable(scope, providerId);

  const apiKey = await resolveProviderApiKey(provider, { scope });
  if (!apiKey) {
    throw new ProviderConfigError(
      `提供商 ${provider.label} 还没有可用的 Key。请在下面的输入框填写你自己的 API Key。`,
    );
  }

  const model = provider.defaultModel;
  if (!model) throw new ProviderConfigError(`提供商 ${provider.label} 未配置默认模型`);

  const keySource = readOwnApiKey(provider) && readOwnApiKey(provider) === apiKey ? "own" : "platform";
  const startedAt = Date.now();
  try {
    const result = await createChatCompletion({
      scope,
      provider: provider.id,
      model,
      apiKey,
      messages: [{ role: "user", content: "ping" }],
      maxOutputTokens: 32,
      temperature: 0,
      timeoutMs: Math.min(provider.timeoutMs, 30_000),
    });

    return {
      ok: true,
      providerId: provider.id,
      model: result.model,
      endpoint: result.endpoint,
      latencyMs: Date.now() - startedAt,
      keySource,
      reply: result.text.slice(0, 200),
    };
  } catch (error) {
    return {
      ok: false,
      providerId: provider.id,
      model,
      endpoint: "",
      latencyMs: Date.now() - startedAt,
      keySource,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

/** 供 API 回显：某个 provider 是否已保存了该用户自己的 Key（不返回明文） */
export async function getStoredKeyHint(scope: string, providerId: string): Promise<string | null> {
  const settings = await readAiSettings(scope);
  const secret = settings.secrets[providerId];
  if (!secret) return null;
  return decryptSecret(secret) ? secret.hint : `${secret.hint}（解密失败）`;
}

/** 检测提供商是否存在（不抛错） */
export function providerExists(scope: string, providerId: string): boolean {
  return Boolean(findProvider(scope, providerId));
}
