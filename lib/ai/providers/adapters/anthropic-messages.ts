import { loadImagePayload } from "../images";
import type { AdapterInput, AdapterResult, ChatMessage, ProtocolAdapter } from "../types";
import { asRecord, readErrorMessage, readText, readUsage } from "./shared";

interface AnthropicContentBlock {
  type: "text" | "image";
  text?: string;
  source?: { type: "base64"; media_type: string; data: string };
}

interface AnthropicMessage {
  role: "user" | "assistant";
  content: AnthropicContentBlock[];
}

async function toAnthropicMessages(messages: ChatMessage[]): Promise<{
  system?: string;
  messages: AnthropicMessage[];
}> {
  const systemTexts: string[] = [];
  const output: AnthropicMessage[] = [];

  for (const message of messages) {
    if (message.role === "system") {
      const text = typeof message.content === "string"
        ? message.content
        : message.content.map((part) => (part.type === "text" ? part.text : "")).join("");
      if (text.trim()) systemTexts.push(text);
      continue;
    }

    const blocks: AnthropicContentBlock[] = [];
    if (typeof message.content === "string") {
      if (message.content.trim()) blocks.push({ type: "text", text: message.content });
    } else {
      for (const part of message.content) {
        if (part.type === "text") {
          if (part.text.trim()) blocks.push({ type: "text", text: part.text });
          continue;
        }
        const image = await loadImagePayload(part.image);
        blocks.push({
          type: "image",
          source: { type: "base64", media_type: image.mimeType, data: image.base64 },
        });
      }
    }

    if (blocks.length > 0) output.push({ role: message.role, content: blocks });
  }

  return {
    system: systemTexts.length > 0 ? systemTexts.join("\n\n") : undefined,
    messages: output,
  };
}

/**
 * Anthropic Messages 协议（POST {baseUrl}/v1/messages）。
 * 密钥走 x-api-key，system 独立字段，图片必须是 base64。
 */
export const anthropicMessagesAdapter: ProtocolAdapter = {
  async buildRequest(input: AdapterInput) {
    const { system, messages } = await toAnthropicMessages(input.messages);

    const body: Record<string, unknown> = {
      model: input.model,
      max_tokens: input.maxOutputTokens,
      messages,
      ...(system ? { system } : {}),
      ...(input.temperature !== undefined ? { temperature: input.temperature } : {}),
      ...(input.extraBody ?? {}),
    };

    return {
      headers: {
        "x-api-key": input.apiKey,
        "anthropic-version": input.anthropicVersion ?? "2023-06-01",
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
    const content = Array.isArray(record?.content) ? record.content : [];
    const texts = content
      .map((block) => {
        const entry = asRecord(block);
        if (!entry || entry.type !== "text") return "";
        return readText(entry.text) ?? "";
      })
      .join("");

    if (!texts.trim()) {
      const reason = record?.stop_reason;
      const suffix = reason ? `（stop_reason: ${String(reason)}）` : "";
      throw new Error(`上游返回了空内容${suffix}`);
    }

    return {
      text: texts,
      usage: readUsage(payload, "input_tokens", "output_tokens"),
    };
  },
};
