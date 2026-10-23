import { describe, expect, it } from "vitest";
import {
  KieApiError,
  isKieGatewayTimeout,
  parseKieChatEventStream,
  parseKieChatResponse,
} from "@/lib/ai/kie-chat-response";

describe("KIE chat response", () => {
  it("reads standard OpenAI-compatible content", () => {
    expect(parseKieChatResponse({
      choices: [{ message: { content: "analysis result" }, finish_reason: "stop" }],
    })).toBe("analysis result");
  });

  it("reads wrapped and segmented content", () => {
    expect(parseKieChatResponse({
      code: 200,
      data: {
        choices: [{ message: { content: [{ type: "text", text: "part one" }, { type: "text", text: " part two" }] } }],
      },
    })).toBe("part one part two");
  });

  it("reads a native Gemini response as a fallback", () => {
    expect(parseKieChatResponse({
      candidates: [{ content: { parts: [{ text: "native result" }] }, finishReason: "STOP" }],
    })).toBe("native result");
  });

  it("surfaces KIE business errors returned with HTTP 200", () => {
    try {
      parseKieChatResponse({ code: 402, msg: "Insufficient credits" });
      throw new Error("Expected KIE error");
    } catch (error) {
      expect(error).toBeInstanceOf(KieApiError);
      expect(error).toMatchObject({ code: 402 });
      expect((error as Error).message).toBe("KIE API error (402): Insufficient credits");
    }
  });

  it("combines OpenAI-compatible SSE chunks without losing whitespace", () => {
    const stream = [
      'data: {"choices":[{"delta":{"content":"analysis"}}]}',
      "",
      'data: {"choices":[{"delta":{"content":" result"}}]}',
      "",
      "data: [DONE]",
      "",
    ].join("\n");

    expect(parseKieChatEventStream(stream)).toBe("analysis result");
  });

  it("recognizes a streamed 524 as a retryable gateway timeout", () => {
    expect(() => parseKieChatEventStream('data: {"code":524,"msg":"2 times retry fail"}\n\n'))
      .toThrow("KIE API error (524): 2 times retry fail");

    try {
      parseKieChatEventStream('data: {"code":524,"msg":"2 times retry fail"}\n\n');
    } catch (error) {
      expect(isKieGatewayTimeout(error)).toBe(true);
    }
  });
});
