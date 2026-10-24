import { describe, expect, it, vi } from "vitest";
import { createChatCompletion } from "@/lib/ai/providers/client";
import { ProviderRequestError } from "@/lib/ai/providers/errors";
import type { FetchLike } from "@/lib/ai/providers/types";
import { describeAnalysisProviderError } from "@/lib/ai/provider-error";

interface CapturedCall {
  url: string;
  init?: RequestInit;
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function captureFetch(payload: unknown, status = 200) {
  const calls: CapturedCall[] = [];
  const fetcher: FetchLike = async (url, init) => {
    calls.push({ url: String(url), init });
    return jsonResponse(payload, status);
  };
  return { fetcher, calls };
}

function readBody(call: CapturedCall): Record<string, unknown> {
  return JSON.parse(String(call.init?.body)) as Record<string, unknown>;
}

describe("openai chat/completions protocol", () => {
  it("sends bearer auth, model and text messages", async () => {
    const { fetcher, calls } = captureFetch({
      choices: [{ message: { content: "hello back" } }],
      usage: { prompt_tokens: 7, completion_tokens: 3 },
    });

    const result = await createChatCompletion({
      provider: "openai",
      apiKey: "sk-test",
      messages: [{ role: "user", content: "hello" }],
      fetchImpl: fetcher,
    });

    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe("https://api.openai.com/v1/chat/completions");
    const headers = calls[0].init?.headers as Record<string, string>;
    expect(headers.Authorization).toBe("Bearer sk-test");
    expect(readBody(calls[0])).toMatchObject({
      model: "gpt-4o-mini",
      messages: [{ role: "user", content: "hello" }],
    });
    expect(result.text).toBe("hello back");
    expect(result.usage).toEqual({ inputTokens: 7, outputTokens: 3 });
  });

  it("maps image parts to image_url content", async () => {
    const { fetcher, calls } = captureFetch({ choices: [{ message: { content: "ok" } }] });

    await createChatCompletion({
      provider: "openai",
      apiKey: "sk-test",
      messages: [{
        role: "user",
        content: [
          { type: "text", text: "describe" },
          { type: "image", image: "https://cdn.example.com/frame.jpg" },
        ],
      }],
      fetchImpl: fetcher,
    });

    const body = readBody(calls[0]) as { messages: Array<{ content: unknown[] }> };
    expect(body.messages[0].content).toEqual([
      { type: "text", text: "describe" },
      { type: "image_url", image_url: { url: "https://cdn.example.com/frame.jpg" } },
    ]);
  });

  it("uses per-model channel paths and extra body fields", async () => {
    const { fetcher, calls } = captureFetch({ choices: [{ message: { content: "kie" } }] });

    await createChatCompletion({
      provider: "kie",
      model: "gemini-3-8-flash",
      apiKey: "kie-key",
      messages: [{ role: "user", content: "hi" }],
      fetchImpl: fetcher,
    });

    expect(calls[0].url).toBe("https://api.kie.ai/gemini-3-8-flash-openai/v1/chat/completions");
    expect(readBody(calls[0])).toMatchObject({
      model: "gemini-3-8-flash",
      max_tokens: 8192,
      include_thoughts: false,
    });
  });
});

describe("openai responses protocol", () => {
  it("moves system prompts into instructions and reads output_text", async () => {
    const { fetcher, calls } = captureFetch({
      output_text: "responses answer",
      usage: { input_tokens: 11, output_tokens: 6 },
    });

    const result = await createChatCompletion({
      provider: "openai-responses",
      apiKey: "sk-test",
      messages: [
        { role: "system", content: "be brief" },
        { role: "user", content: "hello" },
      ],
      fetchImpl: fetcher,
    });

    expect(calls[0].url).toBe("https://api.openai.com/v1/responses");
    expect(readBody(calls[0])).toMatchObject({
      model: "gpt-4o-mini",
      instructions: "be brief",
      max_output_tokens: 4096,
      input: [{ role: "user", content: [{ type: "input_text", text: "hello" }] }],
    });
    expect(result.text).toBe("responses answer");
    expect(result.usage).toEqual({ inputTokens: 11, outputTokens: 6 });
  });

  it("walks the output array when output_text is absent", async () => {
    const { fetcher } = captureFetch({
      output: [
        { type: "reasoning", content: [] },
        { type: "message", content: [{ type: "output_text", text: "walked text" }] },
      ],
    });

    const result = await createChatCompletion({
      provider: "openai-responses",
      apiKey: "sk-test",
      messages: [{ role: "user", content: "hello" }],
      fetchImpl: fetcher,
    });

    expect(result.text).toBe("walked text");
  });
});

describe("anthropic messages protocol", () => {
  it("sends x-api-key, version header, system field and base64 images", async () => {
    const { fetcher, calls } = captureFetch({
      content: [{ type: "text", text: "anthropic answer" }],
      usage: { input_tokens: 20, output_tokens: 8 },
    });

    const result = await createChatCompletion({
      provider: "anthropic",
      apiKey: "sk-ant-test",
      messages: [
        { role: "system", content: "be brief" },
        {
          role: "user",
          content: [
            { type: "text", text: "describe" },
            { type: "image", image: "data:image/png;base64,AAAA" },
          ],
        },
      ],
      fetchImpl: fetcher,
    });

    expect(calls[0].url).toBe("https://api.anthropic.com/v1/messages");
    const headers = calls[0].init?.headers as Record<string, string>;
    expect(headers["x-api-key"]).toBe("sk-ant-test");
    expect(headers["anthropic-version"]).toBe("2023-06-01");
    expect(headers.Authorization).toBeUndefined();

    const body = readBody(calls[0]) as {
      system?: string;
      max_tokens?: number;
      messages: Array<{ role: string; content: unknown[] }>;
    };
    expect(body.system).toBe("be brief");
    expect(body.max_tokens).toBe(4096);
    expect(body.messages).toHaveLength(1);
    expect(body.messages[0].content).toEqual([
      { type: "text", text: "describe" },
      { type: "image", source: { type: "base64", media_type: "image/png", data: "AAAA" } },
    ]);
    expect(result.text).toBe("anthropic answer");
  });
});

describe("provider errors", () => {
  it("wraps upstream failures with provider context", async () => {
    const { fetcher } = captureFetch({ error: { message: "Incorrect API key" } }, 401);

    await expect(createChatCompletion({
      provider: "openai",
      apiKey: "bad-key",
      messages: [{ role: "user", content: "hello" }],
      fetchImpl: fetcher,
    })).rejects.toMatchObject({
      name: "ProviderRequestError",
      providerId: "openai",
      status: 401,
    });
  });

  it("translates auth failures into actionable messages", async () => {
    const { fetcher } = captureFetch({ error: { message: "unauthorized" } }, 401);

    const error = await createChatCompletion({
      provider: "anthropic",
      apiKey: "bad-key",
      messages: [{ role: "user", content: "hello" }],
      fetchImpl: fetcher,
    }).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(ProviderRequestError);
    expect(describeAnalysisProviderError("anthropic", error)).toContain("API Key 校验失败");
  });
});
