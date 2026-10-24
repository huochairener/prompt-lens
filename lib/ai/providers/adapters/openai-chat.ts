import type { AdapterInput, AdapterResult, ChatMessage, ProtocolAdapter } from "../types";
import { asRecord, readErrorMessage, readText, readUsage } from "./shared";

/** 把统一消息结构转成 OpenAI chat/completions 的 wire 格式（KIE 等直连调用也会复用） */
export function toOpenAiChatMessages(messages: ChatMessage[]): unknown[] {
  return messages.map((message) => ({
    role: message.role,
    content: typeof message.content === "string"
      ? message.content
      : message.content.map((part) => (
        part.type === "text"
          ? { type: "text", text: part.text }
          : { type: "image_url", image_url: { url: part.image } }
      )),
  }));
}

/**
 * OpenAI chat/completions 协议。
 * 兼容 OpenRouter、DeepSeek、智谱、Gemini 的 OpenAI 兼容端点、KIE 等实现。
 */
export const openAiChatAdapter: ProtocolAdapter = {
  async buildRequest(input: AdapterInput) {
    const body: Record<string, unknown> = {
      model: input.model,
      messages: toOpenAiChatMessages(input.messages),
      [input.maxTokensField]: input.maxOutputTokens,
      ...(input.temperature !== undefined ? { temperature: input.temperature } : {}),
      ...(input.extraBody ?? {}),
    };

    return {
      headers: {
        Authorization: `Bearer ${input.apiKey}`,
        "Content-Type": "application/json",
        ...(input.headers ?? {}),
      },
      body,
    };
  },

  parseResponse(payload: unknown): AdapterResult {
    const message = readErrorMessage(payload);
    if (message) throw new Error(message);

    const record = asRecord(payload);
    const choices = Array.isArray(record?.choices) ? record.choices : [];
    const first = asRecord(choices[0]);
    const content = readText(asRecord(first?.message)?.content) ?? readText(first?.text);

    if (!content) {
      const finishReason = first?.finish_reason;
      const suffix = finishReason ? `（finish_reason: ${String(finishReason)}）` : "";
      throw new Error(`上游返回了空内容${suffix}`);
    }

    return {
      text: content,
      usage: readUsage(payload, "prompt_tokens", "completion_tokens"),
    };
  },
};
