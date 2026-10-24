import type { ProviderConfig, ProviderProtocol } from "./types";

/** 各协议在 baseUrl 之后追加的默认路径 */
export const DEFAULT_PROTOCOL_PATHS: Record<ProviderProtocol, string> = {
  "openai-chat": "/chat/completions",
  "openai-responses": "/responses",
  "anthropic-messages": "/v1/messages",
};

/**
 * 拼接 baseUrl 与路径。
 * - path 是完整 URL 时直接返回（便于把整条地址写进配置）
 * - baseUrl 已经包含该路径时不再重复追加
 */
export function resolveEndpoint(baseUrl: string, path: string): string {
  const base = baseUrl.trim().replace(/\/+$/, "");
  const suffix = path.trim();
  if (!suffix) return base;
  if (/^https?:\/\//i.test(suffix)) return suffix;

  const normalized = suffix.startsWith("/") ? suffix : `/${suffix}`;
  if (base.toLowerCase().endsWith(normalized.toLowerCase())) return base;
  return `${base}${normalized}`;
}

/** 解析某个提供商 + 模型的实际请求地址（模型级路径优先） */
export function resolveProviderEndpoint(provider: ProviderConfig, model?: string): string {
  const modelPath = model ? provider.modelPaths[model] : undefined;
  return resolveEndpoint(provider.baseUrl, modelPath ?? provider.path);
}
