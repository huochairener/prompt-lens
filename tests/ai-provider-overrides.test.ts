import { afterEach, describe, expect, it } from "vitest";
import { loadProviderCatalog } from "@/lib/ai/providers/config";
import { readPlatformApiKey } from "@/lib/ai/providers/keys";
import { encryptApiKey } from "@/lib/utils/encryption";
import type { StoredSecret } from "@/lib/ai/providers/types";

function secretOf(plain: string): StoredSecret {
  return {
    cipher: encryptApiKey(plain),
    hint: `…${plain.slice(-4)}`,
    updatedAt: new Date().toISOString(),
  };
}

const originalSecret = process.env.BETTER_AUTH_SECRET;

afterEach(() => {
  if (originalSecret === undefined) delete process.env.BETTER_AUTH_SECRET;
  else process.env.BETTER_AUTH_SECRET = originalSecret;
});

describe("在线覆盖层", () => {
  it("覆盖内置提供商的 baseUrl 与模型", () => {
    const catalog = loadProviderCatalog(
      {},
      {
        activeProviderId: null,
        secrets: {},
        overrides: [{ id: "openai", baseUrl: "https://gateway.internal/v1", defaultModel: "qwen-max" }],
      },
    );
    const openai = catalog.providers.find((provider) => provider.id === "openai");

    expect(openai?.baseUrl).toBe("https://gateway.internal/v1");
    expect(openai?.defaultModel).toBe("qwen-max");
    expect(openai?.overriddenFields).toEqual(["baseUrl", "defaultModel"]);
    expect(openai?.custom).toBe(false);
  });

  it("在线覆盖优先于环境变量，未覆盖的字段仍跟随环境变量", () => {
    const catalog = loadProviderCatalog(
      {
        AI_PROVIDER_OPENAI_BASE_URL: "https://from-env/v1",
        AI_PROVIDER_OPENAI_MODEL: "env-model",
      },
      {
        activeProviderId: null,
        secrets: {},
        overrides: [{ id: "openai", baseUrl: "https://from-db/v1" }],
      },
    );
    const openai = catalog.providers.find((provider) => provider.id === "openai");

    // baseUrl 被在线配置锁定，环境变量不再生效
    expect(openai?.baseUrl).toBe("https://from-db/v1");
    // 模型没在在线配置里出现，环境变量继续生效
    expect(openai?.defaultModel).toBe("env-model");
  });

  it("追加在线新增的提供商并标记 custom", () => {
    const catalog = loadProviderCatalog(
      {},
      {
        activeProviderId: null,
        secrets: {},
        overrides: [
          {
            id: "my-gateway",
            custom: true,
            label: "My Gateway",
            protocol: "openai-chat",
            baseUrl: "https://llm.example.com/v1",
            defaultModel: "qwen-max",
          },
        ],
      },
    );

    const custom = catalog.providers.find((provider) => provider.id === "my-gateway");
    expect(custom?.custom).toBe(true);
    expect(custom?.label).toBe("My Gateway");
    expect(custom?.path).toBe("/chat/completions");
    expect(custom?.defaultModel).toBe("qwen-max");
  });

  it("在线新增缺少 baseUrl 时忽略该条而不是整体崩溃", () => {
    const catalog = loadProviderCatalog(
      {},
      {
        activeProviderId: null,
        secrets: {},
        overrides: [{ id: "broken", custom: true, protocol: "openai-chat" }],
      },
    );

    expect(catalog.providers.map((provider) => provider.id)).not.toContain("broken");
    expect(catalog.providers.length).toBeGreaterThan(0);
  });

  it("停用的提供商保留在目录里但不可切换", () => {
    const catalog = loadProviderCatalog(
      {},
      { activeProviderId: null, secrets: {}, overrides: [{ id: "deepseek", enabled: false }] },
    );
    const deepseek = catalog.providers.find((provider) => provider.id === "deepseek");

    expect(deepseek?.enabled).toBe(false);
    expect(catalog.activeProviderId).not.toBe("deepseek");
  });

  it("使用数据库里的 activeProviderId，忽略失效的切换记录", () => {
    const switched = loadProviderCatalog({}, {
      activeProviderId: "anthropic",
      secrets: {},
      overrides: [],
    });
    expect(switched.activeProviderId).toBe("anthropic");
    expect(switched.defaultProviderId).toBe("openrouter");

    const invalid = loadProviderCatalog({}, {
      activeProviderId: "ghost",
      secrets: {},
      overrides: [],
    });
    expect(invalid.activeProviderId).toBe(invalid.defaultProviderId);
  });
});

describe("平台密钥优先级", () => {
  it("数据库里保存的 Key 覆盖环境变量里的 Key", () => {
    process.env.BETTER_AUTH_SECRET = "unit-test-secret-value";
    const catalog = loadProviderCatalog(
      { OPENAI_API_KEY: "env-key", BETTER_AUTH_SECRET: "unit-test-secret-value" },
      {
        activeProviderId: null,
        overrides: [],
        secrets: { openai: secretOf("sk-from-database") },
      },
    );
    const openai = catalog.providers.find((provider) => provider.id === "openai");

    expect(openai?.secretApiKey).toBe("sk-from-database");
    expect(openai?.secretHint).toBe("…base");
    expect(readPlatformApiKey(openai!, { OPENAI_API_KEY: "env-key" })).toBe("sk-from-database");
  });

  it("没有在线 Key 时回退到环境变量", () => {
    const catalog = loadProviderCatalog(
      { OPENAI_API_KEY: "env-key" },
      { activeProviderId: null, overrides: [], secrets: {} },
    );
    const openai = catalog.providers.find((provider) => provider.id === "openai");

    expect(openai?.secretApiKey).toBeUndefined();
    expect(readPlatformApiKey(openai!, { OPENAI_API_KEY: "env-key" })).toBe("env-key");
  });

  it("密钥解密失败时不影响配置加载", () => {
    const catalog = loadProviderCatalog(
      { OPENAI_API_KEY: "env-key", BETTER_AUTH_SECRET: "another-secret" },
      {
        activeProviderId: null,
        overrides: [],
        secrets: {
          openai: { cipher: "aa:bb:cc", hint: "…bad", updatedAt: new Date().toISOString() },
        },
      },
    );
    const openai = catalog.providers.find((provider) => provider.id === "openai");

    expect(openai).toBeTruthy();
    expect(openai?.secretApiKey).toBeUndefined();
    // 解密失败时仍能回退到环境变量
    expect(readPlatformApiKey(openai!, { OPENAI_API_KEY: "env-key" })).toBe("env-key");
  });
});
