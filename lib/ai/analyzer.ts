import { ANALYSIS_PROMPTS, extractCorePrompt } from "@/lib/ai/prompts";
import { describeAnalysisProviderError } from "@/lib/ai/provider-error";
import { requestKieChatCompletion } from "@/lib/ai/kie-chat-client";
import { toOpenAiChatMessages } from "@/lib/ai/providers/adapters";
import { createChatCompletion } from "@/lib/ai/providers/client";
import { getProviderConfig } from "@/lib/ai/providers/config";
import { resolveProviderEndpoint } from "@/lib/ai/providers/endpoint";
import { resolveProviderApiKey } from "@/lib/ai/providers/resolve-key";
import { resolveActiveProviderId } from "@/lib/ai/providers/runtime";
import type { ChatMessage, ProviderConfig } from "@/lib/ai/providers/types";
import type { Locale } from "@/i18n/config";
import { defaultLocale } from "@/i18n/config";

/** 提供商 id，取值见 config/ai-providers.json */
export type ApiProvider = string;

export interface AnalyzeOptions {
  userId: string;
  provider?: ApiProvider;
  frames: string[]; // base64 编码的图片数组
  mode: "single" | "batch";
  /** AI 输出语言（默认 zh，影响生成结果的文本语言） */
  outputLanguage?: Locale;
  /** Provider-specific model selected by the trusted server route. */
  model?: string;
  /** Platform key selected by the billing route; never accepted from clients. */
  apiKeyOverride?: string;
}

export interface AnalyzeResult {
  success: boolean;
  prompt?: string;
  corePrompt?: string;
  error?: string;
}

/** KIE 需要走流式通道并按模型分路径，因此单独保留一条调用链 */
async function callKieChat(
  provider: ProviderConfig,
  apiKey: string,
  model: string,
  messages: ChatMessage[],
): Promise<string> {
  const result = await requestKieChatCompletion({
    url: resolveProviderEndpoint(provider, model),
    apiKey,
    payload: {
      model,
      messages: toOpenAiChatMessages(messages),
      max_tokens: provider.maxOutputTokens,
      ...provider.extraBody,
    },
  });

  console.log("[KIE Gemini] Response received", { model });
  return result;
}

/**
 * 分析图片/帧
 */
export async function analyzeFrames(options: AnalyzeOptions): Promise<AnalyzeResult> {
  const { userId, frames, mode, outputLanguage = defaultLocale } = options;
  const providerId = options.provider?.trim() || (await resolveActiveProviderId());

  let provider: ProviderConfig;
  try {
    provider = getProviderConfig(providerId);
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : `未知的 AI 提供商：${providerId}`,
    };
  }

  const model = options.model?.trim() || provider.defaultModel;
  if (!model) {
    return { success: false, error: `提供商 ${provider.label} 未配置默认模型` };
  }

  const apiKey = await resolveProviderApiKey(provider, {
    userId,
    apiKey: options.apiKeyOverride,
  });

  if (!apiKey) {
    const envHint = provider.apiKeyEnv.length > 0
      ? `（环境变量：${provider.apiKeyEnv.join(" / ")}）`
      : "";
    return {
      success: false,
      error: `未找到 ${provider.label} (${providerId}) 的 API Key${envHint}。请在设置中配置，或检查 .env 文件。`,
    };
  }

  // 按用户选择的语言注入对应 prompt 模板
  const promptTemplate = ANALYSIS_PROMPTS[outputLanguage];
  const prompt = mode === "batch" ? promptTemplate.batch : promptTemplate.single;

  const messages: ChatMessage[] = [
    {
      role: "user",
      content: [
        { type: "text", text: prompt },
        ...frames.map((frame) => ({ type: "image" as const, image: frame })),
      ],
    },
  ];

  try {
    const text = providerId === "kie"
      ? await callKieChat(provider, apiKey, model, messages)
      : (await createChatCompletion({
        provider: providerId,
        model,
        apiKey,
        messages,
        maxOutputTokens: provider.maxOutputTokens,
      })).text;

    // 提取核心提示词（兼容中英文格式）
    const corePrompt = extractCorePrompt(text);

    return {
      success: true,
      prompt: text,
      corePrompt,
    };
  } catch (error: unknown) {
    console.error("AI Analysis error:", {
      provider: providerId,
      model,
      message: error instanceof Error ? error.message : "Analysis failed",
    });
    return {
      success: false,
      error: describeAnalysisProviderError(providerId, error, outputLanguage),
    };
  }
}
