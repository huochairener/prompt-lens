import axios from "axios";
import { findProvider } from "@/lib/ai/providers/config";
import { ProviderRequestError } from "@/lib/ai/providers/errors";
import type { ProviderScope } from "@/lib/ai/providers/store";
import type { Locale } from "@/i18n/config";

const FALLBACK_NAMES: Record<string, string> = {
  zhipu: "Zhipu",
  gemini: "Gemini",
  openrouter: "OpenRouter",
  kie: "KIE",
  deepseek: "DeepSeek",
  anthropic: "Anthropic",
  openai: "OpenAI",
};

function providerName(scope: ProviderScope, provider: string): string {
  return findProvider(scope, provider)?.label ?? FALLBACK_NAMES[provider] ?? provider;
}

/** 把上游状态码翻译成可执行的提示；无匹配时返回 null */
function describeStatus(
  scope: ProviderScope,
  provider: string,
  status: number | undefined,
  locale: Locale,
): string | null {
  const name = providerName(scope, provider);

  if (status === 401 || status === 403) {
    if (locale === "en") {
      return provider === "kie"
        ? "KIE rejected this API key. Check whether the key is valid and whether its permissions or IP allowlist permit the production server."
        : `${name} rejected the API key. Check or replace the key and try again.`;
    }

    return provider === "kie"
      ? "KIE API Key 校验失败。请检查 Key 是否有效，以及权限或 IP 白名单是否允许线上服务器访问。"
      : `${name} API Key 校验失败，请检查或更换 Key 后重试。`;
  }

  if (status === 429) {
    return locale === "en"
      ? `${name} is rate limiting requests. Please try again later.`
      : `${name} 请求过于频繁，请稍后再试。`;
  }

  return null;
}

export function describeAnalysisProviderError(
  provider: string,
  error: unknown,
  locale: Locale = "zh",
  scope: ProviderScope = null,
): string {
  const status = error instanceof ProviderRequestError
    ? error.status
    : axios.isAxiosError(error)
      ? error.response?.status
      : undefined;

  const friendly = describeStatus(scope, provider, status, locale);
  if (friendly) return friendly;

  return error instanceof Error ? error.message : "Analysis failed";
}
