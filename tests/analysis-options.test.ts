import { describe, expect, it, vi } from "vitest";

vi.mock("@/lib/ai/providers/user-keys", () => ({
  loadUserProviderApiKey: vi.fn(async () => null),
}));

import {
  describeProviderOption,
  listAnalysisModelOptions,
  resolveAnalysisTarget,
  resolveAnalysisKey,
} from "@/lib/ai/analysis-options";
import { loadProviderCatalog } from "@/lib/ai/providers/config";
import type { ProviderConfig } from "@/lib/ai/providers/types";

function providerOf(overrides: Partial<ProviderConfig> = {}): ProviderConfig {
  return {
    id: "rapidapi-gpt",
    label: "rapidapi-gpt",
    protocol: "openai-chat",
    baseUrl: "https://rapidapi.cc/v1",
    path: "/chat/completions",
    modelPaths: {},
    defaultModel: "gpt-6.1-sol",
    apiKeyEnv: [],
    headers: {},
    extraBody: {},
    maxOutputTokens: 4096,
    maxTokensField: "max_tokens",
    timeoutMs: 180_000,
    anthropicVersion: "2023-06-01",
    keyStrategy: "either",
    enabled: true,
    custom: true,
    overriddenFields: [],
    ...overrides,
  };
}

describe("分析模型选项", () => {
  it("把提供商配置的模型暴露成可选项", () => {
    const option = describeProviderOption({
      provider: providerOf(),
      hasUserKey: true,
      hasPlatformKey: false,
    });

    expect(option).toMatchObject({
      id: "provider:rapidapi-gpt",
      kind: "provider",
      providerId: "rapidapi-gpt",
      model: "gpt-6.1-sol",
      funding: "user",
      available: true,
    });
  });

  it("没有 Key 的提供商置灰并给出原因（不会再回退到平台试用）", () => {
    const option = describeProviderOption({
      provider: providerOf(),
      hasUserKey: false,
      hasPlatformKey: false,
    });

    expect(option).toMatchObject({
      available: false,
      unavailableReason: "key_required",
    });
  });

  it("只有服务端 Key 时按服务端 Key 展示（管理员场景）", () => {
    const option = describeProviderOption({
      provider: providerOf(),
      hasUserKey: false,
      hasPlatformKey: true,
    });

    expect(option).toMatchObject({ funding: "platform", available: true });
    expect(option.unavailableReason).toBeUndefined();
  });

  it("只允许用户 Key 的提供商不会被服务端 Key 点亮", () => {
    const option = describeProviderOption({
      provider: providerOf({ keyStrategy: "user" }),
      hasUserKey: false,
      hasPlatformKey: true,
    });

    expect(option).toMatchObject({
      funding: "user",
      available: false,
      unavailableReason: "key_required",
    });
  });

  it("没配置模型的提供商也会出现在列表里但不可选", () => {
    const option = describeProviderOption({
      provider: providerOf({ defaultModel: undefined }),
      hasUserKey: true,
      hasPlatformKey: true,
    });

    expect(option).toMatchObject({ available: false, unavailableReason: "model_missing" });
  });
});

describe("解析客户端传来的模型选择", () => {
  it("provider:<id> 的模型名取自服务端配置", async () => {
    const target = await resolveAnalysisTarget("user-1", { analysisModel: "provider:openrouter" });

    expect(target).toMatchObject({
      providerId: "openrouter",
      model: "google/gemini-2.5-flash",
      optionId: "provider:openrouter",
    });
  });

  it("旧版固定 id 仍可用，但只走用户自己的 Key", async () => {
    const target = await resolveAnalysisTarget("user-1", { analysisModel: "platform-gemini-3.8-flash" });

    expect(target).toMatchObject({
      providerId: "kie",
      model: "gemini-3-8-flash",
      keyPolicy: "user",
    });
    await expect(resolveAnalysisTarget("user-1", { analysisModel: "kie-gemini-3.5-flash" }))
      .resolves.toMatchObject({ model: "gemini-3-5-flash-thinking", keyPolicy: "user" });
  });

  it("拒绝未知的提供商与模型", async () => {
    await expect(resolveAnalysisTarget("user-1", { analysisModel: "provider:not-exist" })).resolves.toBeNull();
    await expect(resolveAnalysisTarget("user-1", { analysisModel: "unknown-model" })).resolves.toBeNull();
    // 什么都不传也不再回落到"平台试用"
    await expect(resolveAnalysisTarget("user-1", {})).resolves.toBeNull();
  });
});

describe("解析实际使用的 Key", () => {
  it("普通用户没有自己的 Key 时直接报错，不借用服务端 Key", async () => {
    process.env.OPENROUTER_API_KEY = "platform-secret";
    try {
      const result = await resolveAnalysisKey("user-1", {
        optionId: "provider:openrouter",
        providerId: "openrouter",
        model: "google/gemini-2.5-flash",
        keyPolicy: "either",
        label: "OpenRouter",
      });

      // 测试环境读不到数据库角色 → 按普通用户处理
      expect(result).toMatchObject({ ok: false, code: "USER_KEY_REQUIRED" });
    } finally {
      delete process.env.OPENROUTER_API_KEY;
    }
  });
});

describe("模型列表", () => {
  it("只包含提供商的模型，不再有平台试用通道", async () => {
    const { options, defaultId } = await listAnalysisModelOptions("user-1");

    expect(options.every((option) => option.kind === "provider")).toBe(true);
    expect(options.map((option) => option.providerId)).toEqual(
      expect.arrayContaining(["openrouter", "kie"]),
    );
    expect(defaultId).not.toBeNull();
  });
});

describe("提供商目录基线", () => {
  it("目录里每个提供商都能被解析成模型名，供分析页显示", () => {
    const catalog = loadProviderCatalog({}, { activeProviderId: null, overrides: [], secrets: {} });

    for (const provider of catalog.providers) {
      expect(provider.defaultModel?.trim()).toBeTruthy();
    }
  });
});
