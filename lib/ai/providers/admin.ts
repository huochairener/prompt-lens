import { z } from "zod";
import { createChatCompletion } from "./client";
import {
  findProvider,
  isBaseProvider,
  refreshProviderCatalog,
  setLocalActiveProvider,
} from "./config";
import { ProviderConfigError } from "./errors";
import { resolveProviderApiKey } from "./resolve-key";
import { assertProviderUsable } from "./runtime";
import { encryptSecret, readAiSettings, writeAiSettings, decryptSecret } from "./store";
import { isProviderProtocol, PROVIDER_PROTOCOLS, type ProviderOverride } from "./types";

/**
 * 提供商在线管理（服务端专用）。
 *
 * 所有写操作都是"读当前设置 → 改一份 → 整行写回 → 立刻刷新内存快照"，
 * 因此不需要重启进程；其他实例会在 AI_CONFIG_CACHE_MS 内自动追上。
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

export interface UpsertResult {
  providerId: string;
  created: boolean;
  keyUpdated: boolean;
  keyCleared: boolean;
}

/**
 * 新增或修改提供商（含 baseUrl / 协议 / 模型 / Key）。
 * 内置提供商只写入改动字段；在线新增的提供商会整条落库（custom=true）。
 */
export async function upsertProvider(
  input: ProviderUpsertInput,
  updatedBy?: string | null,
): Promise<UpsertResult> {
  const settings = await readAiSettings();
  const existing = settings.overrides.find((item) => item.id === input.id);
  const builtin = isBaseProvider(input.id);

  if (input.createOnly && (existing || builtin)) {
    throw new ProviderConfigError(`提供商 ${input.id} 已存在，请换一个 id 或直接编辑`);
  }

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

  await writeAiSettings({ ...settings, overrides, secrets, activeProviderId }, updatedBy);
  await refreshProviderCatalog();

  // 确认新配置能被归一化（baseUrl 非法等会被跳过，这里提前暴露而不是等到调用时）
  if (!findProvider(input.id)) {
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
  providerId: string,
  updatedBy?: string | null,
): Promise<{ mode: "deleted" | "reset" | "none" }> {
  const settings = await readAiSettings();
  const existing = settings.overrides.find((item) => item.id === providerId);

  const secrets = { ...settings.secrets };
  const hadSecret = Boolean(secrets[providerId]);
  if (hadSecret) delete secrets[providerId];

  if (!existing) {
    if (hadSecret) {
      await writeAiSettings({ ...settings, secrets }, updatedBy);
      await refreshProviderCatalog();
      return { mode: "reset" };
    }
    return { mode: "none" };
  }

  const mode = existing.custom || !isBaseProvider(providerId) ? "deleted" : "reset";
  const overrides = settings.overrides.filter((item) => item.id !== providerId);
  const activeProviderId =
    settings.activeProviderId === providerId && mode === "deleted" ? null : settings.activeProviderId;

  await writeAiSettings({ ...settings, overrides, secrets, activeProviderId }, updatedBy);
  await refreshProviderCatalog();
  return { mode };
}

/** 切换当前生效的提供商（写库 + 立即刷新） */
export async function saveActiveProvider(
  providerId: string,
  updatedBy?: string | null,
): Promise<void> {
  await refreshProviderCatalog();
  assertProviderUsable(providerId);

  const settings = await readAiSettings();
  await writeAiSettings({ ...settings, activeProviderId: providerId }, updatedBy);
  setLocalActiveProvider(null);
  await refreshProviderCatalog();
}

/** 恢复默认提供商（清掉在线切换记录，回到环境变量/文件默认值） */
export async function resetActiveProviderPersisted(updatedBy?: string | null): Promise<void> {
  const settings = await readAiSettings();
  await writeAiSettings({ ...settings, activeProviderId: null }, updatedBy);
  setLocalActiveProvider(null);
  await refreshProviderCatalog();
}

/** 切换模型：只是 provider 级 defaultModel 的覆盖，不需要重启 */
export async function saveProviderModel(
  providerId: string,
  model: string,
  updatedBy?: string | null,
): Promise<void> {
  const trimmed = model.trim();
  if (!trimmed) throw new ProviderConfigError("模型名不能为空");
  await upsertProvider({ id: providerId, model: trimmed }, updatedBy);
}

/** 更换平台 Key */
export async function saveProviderKey(
  providerId: string,
  apiKey: string,
  updatedBy?: string | null,
): Promise<void> {
  await upsertProvider({ id: providerId, apiKey }, updatedBy);
}

/** 清除平台 Key（回退到环境变量或用户自备 Key） */
export async function clearProviderKey(
  providerId: string,
  updatedBy?: string | null,
): Promise<void> {
  await upsertProvider({ id: providerId, clearApiKey: true }, updatedBy);
}

export interface ProviderTestResult {
  ok: boolean;
  providerId: string;
  model: string;
  endpoint: string;
  latencyMs: number;
  reply?: string;
  error?: string;
}

/**
 * 连通性测试：用当前生效的 Key 发一条最小请求。
 * 优先用平台 Key（验证刚填的那把），没有平台 Key 才退回用户自备 Key。
 */
export async function testProvider(
  providerId: string,
  userId?: string,
): Promise<ProviderTestResult> {
  await refreshProviderCatalog();
  const provider = assertProviderUsable(providerId);

  const platformKey = await resolveProviderApiKey(provider, { userId, allowUserKey: false });
  const apiKey = platformKey ?? (await resolveProviderApiKey(provider, { userId }));
  if (!apiKey) {
    throw new ProviderConfigError(
      `提供商 ${provider.label} 没有可用的 Key：请在设置页填写，或配置环境变量 ${provider.apiKeyEnv.join(" / ") || "（未声明）"}`,
    );
  }

  const model = provider.defaultModel;
  if (!model) throw new ProviderConfigError(`提供商 ${provider.label} 未配置默认模型`);

  const startedAt = Date.now();
  try {
    const result = await createChatCompletion({
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
      reply: result.text.slice(0, 200),
    };
  } catch (error) {
    return {
      ok: false,
      providerId: provider.id,
      model,
      endpoint: "",
      latencyMs: Date.now() - startedAt,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

/** 供 API 回显：某个 provider 是否已保存在线 Key（不返回明文） */
export async function getStoredKeyHint(providerId: string): Promise<string | null> {
  const settings = await readAiSettings();
  const secret = settings.secrets[providerId];
  if (!secret) return null;
  return decryptSecret(secret) ? secret.hint : `${secret.hint}（解密失败）`;
}

/** 检测提供商是否存在（不抛错） */
export function providerExists(providerId: string): boolean {
  return Boolean(findProvider(providerId));
}
