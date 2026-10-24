import rawProviders from "@/config/ai-providers.json";
import { DEFAULT_PROTOCOL_PATHS } from "./endpoint";
import { ProviderConfigError } from "./errors";
import { EMPTY_AI_SETTINGS, decryptSecret, readAiSettings, type AiSettingsSnapshot } from "./store";
import {
  isProviderProtocol,
  type ProviderConfig,
  type ProviderConfigFile,
  type ProviderConfigInput,
  type ProviderKeyStrategy,
  type ProviderOverride,
  type ProviderProtocol,
  type ServiceConfig,
  type ServiceConfigInput,
  type StoredSecret,
} from "./types";

const DEFAULT_MAX_OUTPUT_TOKENS = 4096;
const DEFAULT_TIMEOUT_MS = 180_000;
const DEFAULT_ANTHROPIC_VERSION = "2023-06-01";

/**
 * 在线配置的缓存时长。
 *
 * 写入路径会显式刷新缓存，所以单实例下改完立刻生效；这里的 TTL 只用于
 * 多实例/Serverless 场景下让其他实例在一个很短的窗口内自动追上。
 */
const CATALOG_TTL_MS = Number(process.env.AI_CONFIG_CACHE_MS ?? 2000);

export interface ProviderCatalog {
  /** 当前生效的提供商（在线切换 > 环境变量 > 文件默认值） */
  activeProviderId: string;
  /** 未考虑在线切换时的默认提供商，用于"恢复默认" */
  defaultProviderId: string;
  providers: ProviderConfig[];
  services: ServiceConfig[];
  /** 数据库里的原始覆盖项，界面编辑时需要 */
  overrides: ProviderOverride[];
}

/** 来自数据库的运行时覆盖，缺省表示"只用文件 + 环境变量" */
export type CatalogRuntime = Pick<AiSettingsSnapshot, "overrides" | "secrets" | "activeProviderId">;

type Env = Record<string, string | undefined>;

const BASE_FILE = rawProviders as unknown as ProviderConfigFile;

const BASE_PROVIDER_IDS = new Set(
  (BASE_FILE.providers ?? [])
    .map((provider) => (typeof provider?.id === "string" ? provider.id.trim() : ""))
    .filter(Boolean),
);

function readString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function readStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is string => typeof item === "string" && item.trim() !== "")
    .map((item) => item.trim());
}

function readRecord(value: unknown): Record<string, string> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const entries = Object.entries(value as Record<string, unknown>)
    .filter((entry): entry is [string, string] => typeof entry[1] === "string");
  return Object.fromEntries(entries);
}

/** 把 id 转成环境变量片段：openai-responses → OPENAI_RESPONSES */
export function envSuffixFor(providerId: string): string {
  return providerId.toUpperCase().replace(/[^A-Z0-9]+/g, "_");
}

function readKeyStrategy(value: unknown, fallback: ProviderKeyStrategy): ProviderKeyStrategy {
  return value === "platform" || value === "user" || value === "either" ? value : fallback;
}

function readPositiveInt(value: unknown, fallback: number): number {
  const parsed = typeof value === "string" ? Number(value) : value;
  return typeof parsed === "number" && Number.isFinite(parsed) && parsed > 0
    ? Math.floor(parsed)
    : fallback;
}

function readEnvJson(env: Env): Partial<ProviderConfigFile> | null {
  const raw = readString(env.AI_PROVIDERS_CONFIG);
  if (!raw) return null;

  try {
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("not an object");
    return parsed as Partial<ProviderConfigFile>;
  } catch {
    console.warn("[providers] AI_PROVIDERS_CONFIG 不是合法 JSON，已忽略");
    return null;
  }
}

/**
 * 把环境变量里的单提供商覆盖应用到配置条目上。
 * `lockedKeys` 里的字段已被在线配置覆盖，环境变量不再参与，保证"后台改了就一定生效"。
 */
function applyProviderEnv(
  input: ProviderConfigInput,
  env: Env,
  lockedKeys: ReadonlySet<string> = new Set(),
): ProviderConfigInput {
  const suffix = envSuffixFor(input.id);
  const prefix = `AI_PROVIDER_${suffix}`;

  const pick = <T>(field: string, fromEnv: T | undefined, current: T | undefined): T | undefined =>
    lockedKeys.has(field) ? current : (fromEnv ?? current);

  const envTimeout = readString(env[`${prefix}_TIMEOUT_MS`]);

  return {
    ...input,
    baseUrl: pick("baseUrl", readString(env[`${prefix}_BASE_URL`]), input.baseUrl) as string,
    defaultModel: pick("defaultModel", readString(env[`${prefix}_MODEL`]), input.defaultModel),
    path: pick("path", readString(env[`${prefix}_PATH`]), input.path),
    apiKey: pick("apiKey", readString(env[`${prefix}_API_KEY`]), input.apiKey),
    apiKeyEnv: pick(
      "apiKeyEnv",
      readString(env[`${prefix}_API_KEY_ENV`])
        ? readString(env[`${prefix}_API_KEY_ENV`])!.split(",").map((item) => item.trim()).filter(Boolean)
        : undefined,
      input.apiKeyEnv,
    ),
    protocol: pick(
      "protocol",
      readString(env[`${prefix}_PROTOCOL`]) as ProviderProtocol | undefined,
      input.protocol,
    ) as ProviderProtocol,
    timeoutMs: pick(
      "timeoutMs",
      envTimeout ? readPositiveInt(envTimeout, DEFAULT_TIMEOUT_MS) : undefined,
      readPositiveInt(input.timeoutMs, DEFAULT_TIMEOUT_MS),
    ),
    enabled: pick(
      "enabled",
      readString(env[`${prefix}_ENABLED`]) === "false" ? false : undefined,
      input.enabled,
    ),
  };
}

/** 合并配置文件与 AI_PROVIDERS_CONFIG 里的覆盖项（同 id 浅合并，新 id 追加） */
function mergeProviderInputs(
  base: ProviderConfigInput[],
  overrides: ProviderConfigInput[],
): ProviderConfigInput[] {
  const merged = base.map((item) => ({ ...item }));
  for (const override of overrides) {
    if (!override || typeof override.id !== "string") continue;
    const index = merged.findIndex((item) => item.id === override.id);
    if (index >= 0) merged[index] = { ...merged[index], ...override };
    else merged.push({ ...override });
  }
  return merged;
}

/** 在线覆盖项里真正写了值的字段名（undefined 不算） */
function overriddenFieldsOf(override: ProviderOverride | undefined): string[] {
  if (!override) return [];
  return Object.entries(override)
    .filter(([key, value]) => key !== "id" && key !== "custom" && value !== undefined && value !== null)
    .map(([key]) => key);
}

function normalizeProvider(
  input: ProviderConfigInput,
  context: {
    secrets?: Record<string, StoredSecret>;
    overriddenFields?: string[];
    custom?: boolean;
  } = {},
): ProviderConfig {
  const id = readString(input.id);
  if (!id) throw new ProviderConfigError("提供商配置缺少 id");

  if (!isProviderProtocol(input.protocol)) {
    throw new ProviderConfigError(`提供商 ${id} 使用了不支持的协议：${String(input.protocol)}`);
  }

  const baseUrl = readString(input.baseUrl);
  if (!baseUrl) throw new ProviderConfigError(`提供商 ${id} 缺少 baseUrl`);
  if (!/^https?:\/\//i.test(baseUrl)) {
    throw new ProviderConfigError(`提供商 ${id} 的 baseUrl 必须以 http(s):// 开头：${baseUrl}`);
  }

  const modelPaths = input.modelPaths && typeof input.modelPaths === "object"
    ? Object.fromEntries(
      Object.entries(input.modelPaths)
        .filter((entry): entry is [string, string] => typeof entry[1] === "string" && entry[1].trim() !== "")
        .map(([model, path]) => [model, path.trim()]),
    )
    : {};

  const storedSecret = context.secrets?.[id];
  const secretApiKey = storedSecret ? decryptSecret(storedSecret) ?? undefined : undefined;

  return {
    id,
    label: readString(input.label) ?? id,
    protocol: input.protocol,
    baseUrl,
    path: readString(input.path) ?? DEFAULT_PROTOCOL_PATHS[input.protocol],
    modelPaths,
    defaultModel: readString(input.defaultModel),
    apiKey: readString(input.apiKey),
    secretApiKey,
    secretHint: storedSecret?.hint,
    apiKeyEnv: readStringArray(input.apiKeyEnv),
    headers: readRecord(input.headers),
    extraBody: input.extraBody && typeof input.extraBody === "object" && !Array.isArray(input.extraBody)
      ? input.extraBody
      : {},
    maxOutputTokens: readPositiveInt(input.maxOutputTokens, DEFAULT_MAX_OUTPUT_TOKENS),
    maxTokensField: input.maxTokensField === "max_completion_tokens" ? "max_completion_tokens" : "max_tokens",
    temperature: typeof input.temperature === "number" ? input.temperature : undefined,
    timeoutMs: readPositiveInt(input.timeoutMs, DEFAULT_TIMEOUT_MS),
    anthropicVersion: readString(input.anthropicVersion) ?? DEFAULT_ANTHROPIC_VERSION,
    keyStrategy: readKeyStrategy(input.keyStrategy, "either"),
    enabled: input.enabled !== false,
    custom: context.custom ?? false,
    overriddenFields: context.overriddenFields ?? [],
  };
}

function normalizeService(input: ServiceConfigInput): ServiceConfig {
  const id = readString(input.id);
  if (!id) throw new ProviderConfigError("服务配置缺少 id");

  const baseUrl = readString(input.baseUrl);
  if (!baseUrl) throw new ProviderConfigError(`服务 ${id} 缺少 baseUrl`);

  return {
    id,
    label: readString(input.label) ?? id,
    baseUrl,
    baseUrlEnv: readStringArray(input.baseUrlEnv),
  };
}

function resolveDefaultProvider(
  providers: ProviderConfig[],
  requested?: string,
): ProviderConfig {
  const enabled = providers.filter((provider) => provider.enabled);
  if (enabled.length === 0) throw new ProviderConfigError("所有 AI 提供商都被禁用了");

  if (requested) {
    const matched = enabled.find((provider) => provider.id === requested);
    if (matched) return matched;
    console.warn(`[providers] 默认提供商 ${requested} 不存在或已停用，改用 ${enabled[0].id}`);
  }

  return enabled[0];
}

/**
 * 读取配置文件 + 环境变量 + 在线覆盖，产出可直接使用的提供商目录。
 *
 * 优先级（高 → 低）：
 *   1. 在线配置（数据库 ai_settings.overrides）
 *   2. 环境变量 AI_PROVIDER_<ID>_*
 *   3. config/ai-providers.json
 *
 * 单条配置有问题时只跳过该条并打日志，避免整个应用起不来。
 */
export function loadProviderCatalog(
  env: Env = process.env,
  runtime: CatalogRuntime = EMPTY_AI_SETTINGS,
): ProviderCatalog {
  const envOverrides = readEnvJson(env);
  const runtimeOverrides = Array.isArray(runtime.overrides) ? runtime.overrides : [];
  const overrideById = new Map<string, ProviderOverride>();
  for (const override of runtimeOverrides) {
    const id = typeof override?.id === "string" ? override.id.trim() : "";
    if (!id) continue;
    overrideById.set(id, { ...override, id });
  }

  // 基线：文件 + AI_PROVIDERS_CONFIG（可能新增提供商）
  const baseInputs = mergeProviderInputs(
    BASE_FILE.providers ?? [],
    envOverrides?.providers ?? [],
  );

  // 在线新增的提供商：文件/环境里都没有，需要整条追加
  const customInputs: ProviderConfigInput[] = [];
  for (const override of overrideById.values()) {
    const existsInBase = baseInputs.some((item) => item.id === override.id);
    if (existsInBase) continue;
    if (!override.protocol || !override.baseUrl) {
      console.warn(`[providers] 在线新增的提供商 ${override.id} 缺少 protocol/baseUrl，已忽略`);
      overrideById.delete(override.id);
      continue;
    }
    customInputs.push({
      id: override.id,
      label: override.label,
      protocol: override.protocol,
      baseUrl: override.baseUrl,
      path: override.path,
      defaultModel: override.defaultModel,
      apiKeyEnv: override.apiKeyEnv,
      keyStrategy: override.keyStrategy,
      maxOutputTokens: override.maxOutputTokens,
      temperature: override.temperature,
      timeoutMs: override.timeoutMs,
      headers: override.headers,
      enabled: override.enabled,
    });
  }

  const providerInputs = [...baseInputs, ...customInputs];

  const providers: ProviderConfig[] = [];
  const seen = new Set<string>();
  for (const rawInput of providerInputs) {
    const override = overrideById.get(rawInput.id);
    const overriddenFields = overriddenFieldsOf(override);
    try {
      // 1) 先叠加在线覆盖，2) 再让环境变量填充未被在线覆盖的字段
      const merged = applyProviderEnv(
        override ? { ...rawInput, ...override } : rawInput,
        env,
        new Set(overriddenFields),
      );
      const provider = normalizeProvider(merged, {
        secrets: runtime.secrets,
        overriddenFields,
        custom: !BASE_PROVIDER_IDS.has(rawInput.id) && !hasEnvProvider(envOverrides, rawInput.id),
      });
      if (seen.has(provider.id)) {
        console.warn(`[providers] 重复的提供商 id：${provider.id}，后一条已忽略`);
        continue;
      }
      seen.add(provider.id);
      providers.push(provider);
    } catch (error) {
      console.error(`[providers] 跳过无效配置：${error instanceof Error ? error.message : String(error)}`);
    }
  }

  if (providers.length === 0) {
    throw new ProviderConfigError("没有可用的 AI 提供商，请检查 config/ai-providers.json");
  }

  const services: ServiceConfig[] = [];
  for (const input of BASE_FILE.services ?? []) {
    try {
      services.push(normalizeService(input));
    } catch (error) {
      console.error(`[providers] 跳过无效服务配置：${error instanceof Error ? error.message : String(error)}`);
    }
  }

  const requestedDefault = readString(envOverrides?.defaultProvider)
    ?? readString(env.AI_ACTIVE_PROVIDER)
    ?? readString(BASE_FILE.defaultProvider);
  const defaultProvider = resolveDefaultProvider(providers, requestedDefault);

  // 在线切换优先：数据库里记着就用数据库的，没记就跟着默认值走
  const requestedActive = runtime.activeProviderId
    ? providers.find((provider) => provider.id === runtime.activeProviderId && provider.enabled)?.id
    : undefined;
  if (runtime.activeProviderId && !requestedActive) {
    console.warn(`[providers] 在线切到的提供商 ${runtime.activeProviderId} 不存在或已停用，回退到默认值`);
  }

  return {
    activeProviderId: requestedActive ?? defaultProvider.id,
    defaultProviderId: defaultProvider.id,
    providers,
    services,
    overrides: [...overrideById.values()],
  };
}

function hasEnvProvider(envOverrides: Partial<ProviderConfigFile> | null, providerId: string): boolean {
  return Boolean(envOverrides?.providers?.some((item) => item?.id === providerId));
}

/** 是否来自 config/ai-providers.json（而不是后台在线新增） */
export function isBaseProvider(providerId: string): boolean {
  return BASE_PROVIDER_IDS.has(providerId.trim());
}

// ============ 进程内快照（写入即失效 + 短 TTL） ============

let cachedCatalog: ProviderCatalog | null = null;
let cachedAt = 0;
let inflightRefresh: Promise<ProviderCatalog> | null = null;
/** 运行时切换的本地覆盖，优先级高于数据库（主要给测试和紧急兜底用） */
let localActiveProviderId: string | null = null;

/** 同步读取当前快照；尚未加载过时先返回文件 + 环境变量的基线配置 */
export function getProviderCatalog(): ProviderCatalog {
  if (!cachedCatalog) {
    cachedCatalog = loadProviderCatalog(process.env, EMPTY_AI_SETTINGS);
    cachedAt = 0; // 标记为"只含基线"，下一次 ensure 会立刻拉取数据库覆盖
  }
  return cachedCatalog;
}

/** 重新从数据库加载在线配置并替换快照；失败时保留旧快照 */
export async function refreshProviderCatalog(): Promise<ProviderCatalog> {
  if (inflightRefresh) return inflightRefresh;

  inflightRefresh = (async () => {
    const settings = await readAiSettings();
    try {
      const next = loadProviderCatalog(process.env, settings);
      cachedCatalog = next;
      cachedAt = Date.now();
      return next;
    } catch (error) {
      console.error(
        `[providers] 在线配置合并失败，保留上一份可用配置：${error instanceof Error ? error.message : String(error)}`,
      );
      if (cachedCatalog) return cachedCatalog;
      cachedCatalog = loadProviderCatalog(process.env, EMPTY_AI_SETTINGS);
      cachedAt = Date.now();
      return cachedCatalog;
    }
  })();

  try {
    return await inflightRefresh;
  } finally {
    inflightRefresh = null;
  }
}

/**
 * 确保快照是新鲜的。
 * AI 调用入口（解析 Key、发起对话）会先 await 一次，这样后台改完配置后
 * 下一次请求就用新值，不需要重启进程。
 */
export async function ensureProviderCatalogFresh(): Promise<void> {
  if (cachedCatalog && Date.now() - cachedAt < CATALOG_TTL_MS) return;
  await refreshProviderCatalog();
}

/** 仅用于测试：清空缓存，让新的环境变量生效 */
export function resetProviderCatalogCache(): void {
  cachedCatalog = null;
  cachedAt = 0;
  inflightRefresh = null;
  localActiveProviderId = null;
}

export function setLocalActiveProvider(providerId: string | null): void {
  localActiveProviderId = providerId;
}

export function getLocalActiveProviderId(): string | null {
  return localActiveProviderId;
}

export function listProviders(): ProviderConfig[] {
  return getProviderCatalog().providers.filter((provider) => provider.enabled);
}

export function findProvider(providerId: string): ProviderConfig | null {
  return getProviderCatalog().providers.find((provider) => provider.id === providerId) ?? null;
}

/** 按 id 取提供商，不存在时抛错 */
export function getProviderConfig(providerId: string): ProviderConfig {
  const provider = findProvider(providerId);
  if (!provider) {
    const known = getProviderCatalog().providers.map((item) => item.id).join(", ");
    throw new ProviderConfigError(`未知的 AI 提供商：${providerId}（已配置：${known}）`);
  }
  if (!provider.enabled) {
    throw new ProviderConfigError(`AI 提供商 ${providerId} 已被停用`);
  }
  return provider;
}

/** 模型对应的绝对通道路径（KIE 这类按模型分通道的服务） */
export function getProviderModelPath(providerId: string, model: string): string | null {
  return findProvider(providerId)?.modelPaths[model] ?? null;
}

/** 实际会发给上游的模型名：在线切换后的 defaultModel */
export function getEffectiveModel(providerId: string): string | undefined {
  return findProvider(providerId)?.defaultModel;
}

export function getProviderOverrides(): ProviderOverride[] {
  return getProviderCatalog().overrides;
}

export function getServiceConfig(serviceId: string): ServiceConfig {
  const service = getProviderCatalog().services.find((item) => item.id === serviceId);
  if (!service) throw new ProviderConfigError(`未知的服务配置：${serviceId}`);
  return service;
}

/** 服务 base URL：环境变量优先，否则使用配置文件里的默认值 */
export function getServiceBaseUrl(serviceId: string, env: Env = process.env): string {
  const service = getServiceConfig(serviceId);
  for (const name of service.baseUrlEnv) {
    const override = readString(env[name]);
    if (override) return override.replace(/\/+$/, "");
  }
  return service.baseUrl.replace(/\/+$/, "");
}
