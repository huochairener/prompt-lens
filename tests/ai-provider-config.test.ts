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
  it("ships only the openrouter provider plus kie", () => {
    const catalog = loadProviderCatalog({});
    const protocols = new Set(catalog.providers.map((provider) => provider.protocol));

    expect(protocols).toEqual(new Set(["openai-chat"]));
    expect(catalog.providers.map((provider) => provider.id).sort()).toEqual(["kie", "openrouter"]);
    expect(catalog.defaultProviderId).toBe("openrouter");
  });

  it("resolves the openrouter endpoint from base url and path", () => {
    const catalog = loadProviderCatalog({});
    const openrouter = catalog.providers.find((provider) => provider.id === "openrouter");

    expect(openrouter?.baseUrl).toBe("https://openrouter.ai/api/v1");
    expect(resolveEndpoint(openrouter!.baseUrl, openrouter!.path))
      .toBe("https://openrouter.ai/api/v1/chat/completions");
  });

  it("keeps KIE model channels in configuration", () => {
    expect(getProviderModelPath(null, "kie", "gemini-3-8-flash"))
      .toBe("/gemini-3-8-flash-openai/v1/chat/completions");
    expect(getProviderModelPath(null, "kie", "gemini-2.5-pro")).toBe("/gemini-2.5-pro/v1/chat/completions");
    expect(getProviderModelPath(null, "kie", "unknown-model")).toBeNull();
  });

  it("lets environment variables override base url and model", () => {
    const catalog = loadProviderCatalog({
      AI_PROVIDER_OPENROUTER_BASE_URL: "https://gateway.example.com/v1",
      AI_PROVIDER_OPENROUTER_MODEL: "custom-model",
    });
    const openrouter = catalog.providers.find((provider) => provider.id === "openrouter");

    expect(openrouter?.baseUrl).toBe("https://gateway.example.com/v1");
    expect(openrouter?.defaultModel).toBe("custom-model");
  });

  it("adds providers declared through AI_PROVIDERS_CONFIG", () => {
    const catalog = loadProviderCatalog({
      AI_PROVIDERS_CONFIG: JSON.stringify({
        defaultProvider: "internal-gateway",
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
    expect(catalog.defaultProviderId).toBe("internal-gateway");
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
    resetActiveProvider(null);
    expect(getActiveProviderId(null)).toBe(getDefaultProviderId(null));

    setActiveProvider(null, "kie");
    expect(getActiveProviderId(null)).toBe("kie");
    // 切的是「当前作用域」，系统基线不受影响
    expect(getActiveProviderId("someone-else")).not.toBe("kie");

    resetActiveProvider(null);
    expect(getActiveProviderId(null)).toBe(getDefaultProviderId(null));
  });

  it("rejects unknown providers", () => {
    resetActiveProvider(null);
    expect(() => setActiveProvider(null, "does-not-exist")).toThrow(ProviderConfigError);
    resetActiveProvider(null);
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
