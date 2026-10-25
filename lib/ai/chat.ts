import { createChatCompletion } from "@/lib/ai/providers/client";
import { getProviderConfig } from "@/lib/ai/providers/config";
import { ProviderApiKeyError } from "@/lib/ai/providers/errors";
import { resolveProviderApiKey } from "@/lib/ai/providers/resolve-key";
import { resolveActiveProviderId } from "@/lib/ai/providers/runtime";
import type { ChatMessage, ChatRole } from "@/lib/ai/providers/types";

/** 提供商 id，取值见 config/ai-providers.json */
export type ChatProvider = string;

interface ChatOptions {
  userId: string;
  provider?: ChatProvider;
  messages: Array<{ role: string; content: string }>;
}

function normalizeRole(role: string): ChatRole {
  if (role === "system" || role === "assistant") return role;
  return "user";
}

/**
 * 调用当前（或指定）AI 提供商。
 * base URL / 协议 / 模型全部来自 config/ai-providers.json，不再写死在代码里。
 */
export async function callAIProvider(options: ChatOptions): Promise<string> {
  // 提供商配置跟着账号走
  const scope = options.userId;
  const providerId = options.provider?.trim() || (await resolveActiveProviderId(scope));
  const provider = getProviderConfig(scope, providerId);

  const apiKey = await resolveProviderApiKey(provider, { scope });
  if (!apiKey) {
    throw new ProviderApiKeyError(provider.id, provider.label, provider.apiKeyEnv);
  }

  const messages: ChatMessage[] = options.messages.map((message) => ({
    role: normalizeRole(message.role),
    content: message.content ?? "",
  }));

  const result = await createChatCompletion({
    scope,
    provider: providerId,
    apiKey,
    messages,
    maxOutputTokens: provider.maxOutputTokens,
    temperature: provider.temperature,
  });

  return result.text;
}
