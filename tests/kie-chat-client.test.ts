import { describe, expect, it, vi } from "vitest";
import { requestKieChatCompletion } from "@/lib/ai/kie-chat-client";

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function streamResponse(...chunks: string[]) {
  const body = `${chunks.map((content) => `data: ${JSON.stringify({ choices: [{ delta: { content } }] })}\n\n`).join("")}data: [DONE]\n\n`;
  return new Response(body, {
    status: 200,
    headers: { "Content-Type": "text/event-stream" },
  });
}

describe("KIE chat client", () => {
  it("requests streaming output and combines the response", async () => {
    const fetcher = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      expect(JSON.parse(String(init?.body))).toMatchObject({ stream: true });
      return streamResponse("analysis", " result");
    });

    await expect(requestKieChatCompletion({
      url: "https://api.kie.ai/example",
      apiKey: "test-key",
      payload: { model: "gemini-3-8-flash", messages: [] },
      fetcher,
      delay: async () => undefined,
    })).resolves.toBe("analysis result");
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it("retries one KIE 524 response and then returns the streamed result", async () => {
    const fetcher = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({ code: 524, msg: "2 times retry fail" }))
      .mockResolvedValueOnce(streamResponse("recovered"));
    const delay = vi.fn(async () => undefined);

    await expect(requestKieChatCompletion({
      url: "https://api.kie.ai/example",
      apiKey: "test-key",
      payload: { model: "gemini-3-8-flash", messages: [] },
      fetcher,
      delay,
    })).resolves.toBe("recovered");
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(delay).toHaveBeenCalledTimes(1);
  });

  it("does not retry non-transient KIE business errors", async () => {
    const fetcher = vi.fn(async () => jsonResponse({ code: 402, msg: "Insufficient credits" }));

    await expect(requestKieChatCompletion({
      url: "https://api.kie.ai/example",
      apiKey: "test-key",
      payload: { model: "gemini-3-8-flash", messages: [] },
      fetcher,
      delay: async () => undefined,
    })).rejects.toThrow("KIE API error (402): Insufficient credits");
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
});
