import type { AdapterInput, AdapterResult, ChatMessage, ProtocolAdapter } from "../types";
import { asRecord, readErrorMessage, readText, readUsage } from "./shared";

interface ResponsesInputItem {
  role: "user" | "assistant";
  content: Array<Record<string, unknown>>;
}

function toResponsesInput(messages: ChatMessage[]): {
  instructions?: string;
  input: ResponsesInputItem[];
} {
  const systemTexts: string[] = [];
  const input: ResponsesInputItem[] = [];

  for (const message of messages) {
    if (message.role === "system") {
      const text = typeof message.content === "string"
        ? message.content
        : message.content.map((part) => (part.type === "text" ? part.text : "")).join("");
      if (text.trim()) systemTexts.push(text);
      continue;
    }

    const content = typeof message.content === "string"
      ? [{ type: "input_text", text: message.content }]
      : message.content.map((part) => (
        part.type === "text"
          ? { type: "input_text", text: part.text }
          : { type: "input_image", image_url: part.image }
      ));

    input.push({ role: message.role, content });
  }

  return {
    instructions: systemTexts.length > 0 ? systemTexts.join("\n\n") : undefined,
    input,
  };
}

/**
 * OpenAI Responses 协议（POST {baseUrl}/responses）。
 * 与 chat/completions 的差异：system 走 instructions，输入叫 input，输出走 output 数组。
 */
export const openAiResponsesAdapter: ProtocolAdapter = {
  async buildRequest(input: AdapterInput) {
    const { instructions, input: responsesInput } = toResponsesInput(input.messages);

    const body: Record<string, unknown> = {
      model: input.model,
      input: responsesInput,
      max_output_tokens: input.maxOutputTokens,
      ...(instructions ? { instructions } : {}),
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
    const direct = typeof record?.output_text === "string" ? record.output_text : null;

    const collected: string[] = [];
    const output = Array.isArray(record?.output) ? record.output : [];
    for (const item of output) {
      const entry = asRecord(item);
      if (!entry || entry.type !== "message") continue;
      const content = Array.isArray(entry.content) ? entry.content : [];
      for (const part of content) {
        const partRecord = asRecord(part);
        if (!partRecord) continue;
        if (partRecord.type === "output_text" || partRecord.type === "text") {
          const text = readText(partRecord.text);
          if (text) collected.push(text);
        }
      }
    }

    const text = direct && direct.trim() ? direct : collected.join("");
    if (!text.trim()) {
      const reason = asRecord(record?.incomplete_details)?.reason;
      const suffix = reason ? `（incomplete: ${String(reason)}）` : "";
      throw new Error(`上游返回了空内容${suffix}`);
    }

    return {
      text,
      usage: readUsage(payload, "input_tokens", "output_tokens"),
    };
  },
};
