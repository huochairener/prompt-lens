import { describe, expect, it } from "vitest";
import {
  getActiveProviderId,
  getDefaultProviderId,
  getProviderModelPath,
  loadProviderCatalog,
  resetActiveProvider,
  setActiveProvider,
} from "@/lib/ai/providers";
import { resolveEndpoint } from "@/lib/ai/providers/endpoint";
import { ProviderConfigError } from "@/lib/ai/providers/errors";

describe("provider endpoint resolution", () => {
  it("joins base url and protocol path", () => {
    expect(resolveEndpoint("https://api.openai.com/v1", "/chat/completions"))
      .toBe("https://api.openai.com/v1/chat/completions");
    expect(resolveEndpoint("https://api.openai.com/v1/", "chat/completions"))
      .toBe("https://api.openai.com/v1/chat/completions");
  });

  it("does not duplicate a path already present in the base url", () => {
    expect(resolveEndpoint("https://api.deepseek.com/v1/chat/completions", "/chat/completions"))
      .toBe("https://api.deepseek.com/v1/chat/completions");
    expect(resolveEndpoint("https://legacy.example.com/chat/completions", "chat/completions"))
      .toBe("https://legacy.example.com/chat/completions");
  });

  it("accepts a full url as path", () => {
    expect(resolveEndpoint("https://api.openai.com/v1", "https://gateway.example.com/v1/chat/completions"))
      .toBe("https://gateway.example.com/v1/chat/completions");
  });
});

describe("provider catalog", () => {
  it("ships every supported protocol", () => {
    const catalog = loadProviderCatalog({});
    const protocols = new Set(catalog.providers.map((provider) => provider.protocol));

    expect(protocols).toContain("openai-chat");
    expect(protocols).toContain("openai-responses");
    expect(protocols).toContain("anthropic-messages");
    expect(catalog.defaultProviderId).toBe("openrouter");
  });

  it("keeps KIE model channels in configuration", () => {
    expect(getProviderModelPath("kie", "gemini-3-8-flash"))
      .toBe("/gemini-3-8-flash-openai/v1/chat/completions");
    expect(getProviderModelPath("kie", "gemini-2.5-pro")).toBe("/gemini-2.5-pro/v1/chat/completions");
    expect(getProviderModelPath("kie", "unknown-model")).toBeNull();
  });

  it("lets environment variables override base url and model", () => {
    const catalog = loadProviderCatalog({
      AI_PROVIDER_OPENAI_BASE_URL: "https://gateway.example.com/v1",
      AI_PROVIDER_OPENAI_MODEL: "custom-model",
    });
    const openai = catalog.providers.find((provider) => provider.id === "openai");

    expect(openai?.baseUrl).toBe("https://gateway.example.com/v1");
    expect(openai?.defaultModel).toBe("custom-model");
  });

  it("adds providers declared through AI_PROVIDERS_CONFIG", () => {
    const catalog = loadProviderCatalog({
      AI_PROVIDERS_CONFIG: JSON.stringify({
        defaultProvider: "anthropic",
        providers: [
          {
            id: "internal-gateway",
            label: "Internal Gateway",
            protocol: "openai-responses",
            baseUrl: "https://llm.internal/v1",
            apiKeyEnv: ["INTERNAL_LLM_KEY"],
            defaultModel: "internal-large",
          },
        ],
      }),
    });

    const custom = catalog.providers.find((provider) => provider.id === "internal-gateway");
    expect(custom).toMatchObject({
      protocol: "openai-responses",
      baseUrl: "https://llm.internal/v1",
      defaultModel: "internal-large",
    });
    expect(catalog.defaultProviderId).toBe("anthropic");
  });

  it("ignores broken AI_PROVIDERS_CONFIG instead of crashing", () => {
    const catalog = loadProviderCatalog({ AI_PROVIDERS_CONFIG: "{ not json" });
    expect(catalog.providers.length).toBeGreaterThan(0);
  });

  it("falls back to the first enabled provider when the default is unknown", () => {
    const catalog = loadProviderCatalog({ AI_PROVIDERS_CONFIG: JSON.stringify({ defaultProvider: "ghost" }) });
    expect(catalog.providers.map((provider) => provider.id)).toContain(catalog.defaultProviderId);
  });
});

describe("active provider switching", () => {
  it("switches at runtime and resets to the configured default", () => {
    resetActiveProvider();
    expect(getActiveProviderId()).toBe(getDefaultProviderId());

    setActiveProvider("anthropic");
    expect(getActiveProviderId()).toBe("anthropic");

    resetActiveProvider();
    expect(getActiveProviderId()).toBe(getDefaultProviderId());
  });

  it("rejects unknown providers", () => {
    resetActiveProvider();
    expect(() => setActiveProvider("does-not-exist")).toThrow(ProviderConfigError);
    resetActiveProvider();
  });
});

describe("service configuration", () => {
  it("exposes non-chat service base urls", () => {
    const catalog = loadProviderCatalog({});
    const assemblyai = catalog.services.find((service) => service.id === "assemblyai");
    const kieVideo = catalog.services.find((service) => service.id === "kie-video");

    expect(assemblyai?.baseUrl).toBe("https://api.assemblyai.com");
    expect(kieVideo?.baseUrl).toBe("https://api.kie.ai");
  });
});
