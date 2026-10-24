import type { TokenUsage } from "../types";

export function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

/** 读取文本：兼容字符串与 [{ type: "text", text }] 数组 */
export function readText(value: unknown): string | null {
  if (typeof value === "string") return value.trim() ? value : null;
  if (!Array.isArray(value)) return null;

  const text = value
    .map((part) => {
      if (typeof part === "string") return part;
      const record = asRecord(part);
      return record && typeof record.text === "string" ? record.text : "";
    })
    .join("");

  return text.trim() ? text : null;
}

export function readErrorMessage(payload: unknown): string | null {
  const record = asRecord(payload);
  if (!record) return null;

  const error = record.error;
  if (typeof error === "string" && error.trim()) return error.trim();
  const errorRecord = asRecord(error);
  if (errorRecord && typeof errorRecord.message === "string" && errorRecord.message.trim()) {
    return errorRecord.message.trim();
  }

  if (typeof record.message === "string" && record.message.trim()) return record.message.trim();
  return null;
}

export function readUsage(payload: unknown, inputKey: string, outputKey: string): TokenUsage | undefined {
  const usage = asRecord(asRecord(payload)?.usage);
  if (!usage) return undefined;

  const input = usage[inputKey];
  const output = usage[outputKey];
  if (typeof input !== "number" && typeof output !== "number") return undefined;

  return {
    inputTokens: typeof input === "number" ? input : undefined,
    outputTokens: typeof output === "number" ? output : undefined,
  };
}
