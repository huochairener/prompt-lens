import { getProtocolAdapter } from "./adapters";
import { readErrorMessage } from "./adapters/shared";
import { ensureProviderCatalogFresh, getProviderConfig } from "./config";
import { resolveProviderEndpoint } from "./endpoint";
import { ProviderApiKeyError, ProviderConfigError, ProviderRequestError } from "./errors";
import { getActiveProvider } from "./runtime";
import type { ProviderScope } from "./store";
import { ensureProxyTransport } from "./transport";
import type {
  ChatMessage,
  FetchLike,
  ProviderProtocol,
  TokenUsage,
} from "./types";

ensureProxyTransport();

export interface ChatCompletionRequest {
  /** 谁在调用：决定读哪一份提供商配置（每个用户各自一份） */
  scope: ProviderScope;
  /** 提供商 id，缺省使用该用户当前提供商 */
  provider?: string;
  /** 模型名，缺省使用提供商配置的 defaultModel */
  model?: string;
  messages: ChatMessage[];
  /** 已完成解析的 API Key（用户 Key / 平台 Key 由调用方决定） */
  apiKey: string;
  maxOutputTokens?: number;
  temperature?: number;
  headers?: Record<string, string>;
  extraBody?: Record<string, unknown>;
  timeoutMs?: number;
  signal?: AbortSignal;
  /** 便于测试注入 */
  fetchImpl?: FetchLike;
}

export interface ChatCompletionResult {
  text: string;
  providerId: string;
  protocol: ProviderProtocol;
  model: string;
  endpoint: string;
  usage?: TokenUsage;
  raw: unknown;
}

function combineSignals(signals: Array<AbortSignal | undefined>): AbortSignal | undefined {
  const active = signals.filter((signal): signal is AbortSignal => Boolean(signal));
  if (active.length === 0) return undefined;
  if (active.length === 1) return active[0];

  const controller = new AbortController();
  for (const signal of active) {
    if (signal.aborted) {
      controller.abort(signal.reason);
      break;
    }
    signal.addEventListener("abort", () => controller.abort(signal.reason), { once: true });
  }
  return controller.signal;
}

function isTimeoutLike(error: unknown): boolean {
  return error instanceof Error && (error.name === "TimeoutError" || error.name === "AbortError");
}

function describeTransportError(error: unknown, label: string, timeoutMs: number): string {
  if (isTimeoutLike(error)) return `[${label}] 请求超时（${timeoutMs}ms）`;
  const detail = error instanceof Error ? error.message : String(error);
  return `[${label}] 网络请求失败：${detail}`;
}

function parsePayload(rawText: string): unknown {
  if (!rawText) return null;
  try {
    return JSON.parse(rawText) as unknown;
  } catch {
    return rawText;
  }
}

/**
 * 统一对话入口：按提供商配置选择协议适配器，完成请求构建、发送、响应解析与错误归一。
 */
export async function createChatCompletion(
  request: ChatCompletionRequest,
): Promise<ChatCompletionResult> {
  // 先对齐该用户的在线配置：他在设置页改过 baseUrl / 模型 / Key 之后，下一次请求就生效
  await ensureProviderCatalogFresh(request.scope);

  const provider = request.provider
    ? getProviderConfig(request.scope, request.provider)
    : getActiveProvider(request.scope);

  const model = request.model?.trim() || provider.defaultModel;
  if (!model) {
    throw new ProviderConfigError(`提供商 ${provider.id} 未配置默认模型，请在请求中显式指定 model`);
  }

  const apiKey = request.apiKey?.trim();
  if (!apiKey) throw new ProviderApiKeyError(provider.id, provider.label, provider.apiKeyEnv);

  const adapter = getProtocolAdapter(provider.protocol);
  const endpoint = resolveProviderEndpoint(provider, model);
  const maxOutputTokens = request.maxOutputTokens ?? provider.maxOutputTokens;
  const timeoutMs = request.timeoutMs ?? provider.timeoutMs;

  const { headers, body } = await adapter.buildRequest({
    url: endpoint,
    apiKey,
    model,
    messages: request.messages,
    maxOutputTokens,
    maxTokensField: provider.maxTokensField,
    temperature: request.temperature ?? provider.temperature,
    extraBody: { ...provider.extraBody, ...(request.extraBody ?? {}) },
    headers: { ...provider.headers, ...(request.headers ?? {}) },
    anthropicVersion: provider.anthropicVersion,
  });

  const fetchImpl: FetchLike = request.fetchImpl ?? fetch;
  const signal = combineSignals([request.signal, AbortSignal.timeout(timeoutMs)]);

  let response: Response;
  try {
    response = await fetchImpl(endpoint, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
      signal,
    });
  } catch (error) {
    throw new ProviderRequestError(describeTransportError(error, provider.label, timeoutMs), {
      providerId: provider.id,
      protocol: provider.protocol,
      details: error,
      cause: error,
    });
  }

  const rawText = await response.text();
  const payload = parsePayload(rawText);

  if (!response.ok) {
    const upstream = readErrorMessage(payload)
      ?? (typeof payload === "string" ? payload.slice(0, 200).trim() : "");
    throw new ProviderRequestError(
      `[${provider.label}] 上游返回 ${response.status}${upstream ? `：${upstream}` : ""}`,
      {
        providerId: provider.id,
        protocol: provider.protocol,
        status: response.status,
        details: payload,
      },
    );
  }

  try {
    const parsed = adapter.parseResponse(payload);
    return {
      text: parsed.text,
      usage: parsed.usage,
      providerId: provider.id,
      protocol: provider.protocol,
      model,
      endpoint,
      raw: payload,
    };
  } catch (error) {
    throw new ProviderRequestError(
      `[${provider.label}] 响应解析失败：${error instanceof Error ? error.message : String(error)}`,
      {
        providerId: provider.id,
        protocol: provider.protocol,
        status: response.status,
        details: payload,
        cause: error,
      },
    );
  }
}

export type { ChatMessage };
