import { getProviderModelPath } from "@/lib/ai/providers/config";
import type { ProviderScope } from "@/lib/ai/providers/store";

/**
 * 旧版分析模型 id → 提供商 + 模型。
 *
 * 现在分析页直接传 `provider:<id>`，这里只用于兼容已经打开的旧页面。
 * **全部走用户自己的 Key**：平台试用已移除，不存在"平台出资"的分析通道。
 */
export const LEGACY_ANALYSIS_MODELS: Record<string, { provider: string; model: string }> = {
  // 历史平台试用通道：保留 id 兼容，但不再使用平台 Key
  "platform-gemini-3.8-flash": { provider: "kie", model: "gemini-3-8-flash" },
  "platform-gemini-3.5-flash": { provider: "kie", model: "gemini-3-8-flash" },
  "platform-gemini-2.5-flash": { provider: "kie", model: "gemini-3-8-flash" },
  "kie-gemini-3.8-flash": { provider: "kie", model: "gemini-3-8-flash" },
  "kie-gemini-3.5-flash": { provider: "kie", model: "gemini-3-5-flash-thinking" },
  "kie-gemini-2.5-flash": { provider: "kie", model: "gemini-3-5-flash-thinking" },
  "kie-gemini-2.5-pro": { provider: "kie", model: "gemini-2.5-pro" },
};

export function resolveLegacyAnalysisModel(
  modelId: unknown,
): { provider: string; model: string } | null {
  if (typeof modelId !== "string") return null;
  return LEGACY_ANALYSIS_MODELS[modelId.trim()] ?? null;
}

// KIE channel paths are not interchangeable with request model names.
// 路径本身配置在 config/ai-providers.json 的 provider.modelPaths 中。
export function getKieAnalysisPath(scope: ProviderScope, model: string): string {
  const path = getProviderModelPath(scope, "kie", model);
  if (!path) throw new Error(`Unsupported KIE analysis model: ${model}`);
  return path;
}
