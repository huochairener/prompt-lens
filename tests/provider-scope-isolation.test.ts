import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { loadProviderCatalog } from "@/lib/ai/providers/config";
import { readOwnApiKey, readPlatformApiKey } from "@/lib/ai/providers/keys";
import { encryptApiKey } from "@/lib/utils/encryption";
import type { ProviderOverride, StoredSecret } from "@/lib/ai/providers/types";

/**
 * 提供商配置按用户隔离的核心约束：
 *   1. A 用户新增的提供商 / Key 不会出现在 B 用户的目录里
 *   2. 普通用户不能把内置提供商指向别的地址、也不能引用服务端环境变量 Key
 */

function secretOf(plain: string): StoredSecret {
  return {
    cipher: encryptApiKey(plain),
    hint: `…${plain.slice(-4)}`,
    updatedAt: new Date().toISOString(),
  };
}

const ALICE_PROVIDER: ProviderOverride = {
  id: "rapidapi-gpt",
  label: "rapidapi-gpt",
  protocol: "openai-chat",
  baseUrl: "https://rapidapi.cc/v1",
  defaultModel: "gpt-6.1-sol",
  custom: true,
};

const originalSecret = process.env.BETTER_AUTH_SECRET;

beforeEach(() => {
  process.env.BETTER_AUTH_SECRET = "test-secret-for-provider-isolation";
});

afterEach(() => {
  if (originalSecret === undefined) delete process.env.BETTER_AUTH_SECRET;
  else process.env.BETTER_AUTH_SECRET = originalSecret;
});

describe("提供商按用户隔离", () => {
  it("A 用户的提供商和 Key 不会出现在 B 用户的目录里", () => {
    const alice = loadProviderCatalog(
      {},
      {
        activeProviderId: "rapidapi-gpt",
        overrides: [ALICE_PROVIDER],
        secrets: { "rapidapi-gpt": secretOf("sk-alice-private-key") },
      },
      { scopeId: "alice", definitionsEditable: false },
    );
    const bob = loadProviderCatalog({}, {
      activeProviderId: null,
      overrides: [],
      secrets: {},
    }, { scopeId: "bob", definitionsEditable: false });

    const aliceProvider = alice.providers.find((provider) => provider.id === "rapidapi-gpt");
    expect(aliceProvider?.defaultModel).toBe("gpt-6.1-sol");
    expect(readOwnApiKey(aliceProvider!)).toBe("sk-alice-private-key");

    expect(alice.activeProviderId).toBe("rapidapi-gpt");
    expect(alice.scopeId).toBe("alice");

    // Bob 的目录里根本不存在这个提供商，也没有任何 Key 泄漏
    expect(bob.providers.map((provider) => provider.id)).toEqual(["openrouter", "kie"]);
    expect(bob.providers.some((provider) => readOwnApiKey(provider))).toBe(false);
    expect(bob.activeProviderId).toBe("openrouter");
    expect(bob.scopeId).toBe("bob");
  });

  it("普通用户改不动内置提供商的连接信息", () => {
    const catalog = loadProviderCatalog(
      {},
      {
        activeProviderId: null,
        secrets: {},
        overrides: [
          {
            id: "openrouter",
            baseUrl: "https://evil.example.com/v1",
            path: "/steal",
            protocol: "openai-chat",
            defaultModel: "my-model",
          },
        ],
      },
      { scopeId: "bob", definitionsEditable: false },
    );

    const openrouter = catalog.providers.find((provider) => provider.id === "openrouter");
    // 模型可以改（自己的选择），连接信息必须保持出厂值
    expect(openrouter?.defaultModel).toBe("my-model");
    expect(openrouter?.baseUrl).toBe("https://openrouter.ai/api/v1");
    expect(openrouter?.path).toBe("/chat/completions");
    expect(catalog.definitionsEditable).toBe(false);
  });

  it("普通用户的自定义提供商不能引用服务端环境变量 Key", () => {
    const catalog = loadProviderCatalog(
      { OPENROUTER_API_KEY: "platform-secret" },
      {
        activeProviderId: null,
        secrets: {},
        overrides: [
          {
            id: "my-gateway",
            label: "my-gateway",
            protocol: "openai-chat",
            baseUrl: "https://my-own-gateway.example.com/v1",
            defaultModel: "gpt-4o-mini",
            apiKeyEnv: ["OPENROUTER_API_KEY"],
            custom: true,
          },
        ],
      },
      { scopeId: "bob", definitionsEditable: false },
    );

    const gateway = catalog.providers.find((provider) => provider.id === "my-gateway");
    expect(gateway).toBeDefined();
    // 环境变量名被剥掉，平台 Key 不会发到他自己的网关上
    expect(gateway?.apiKeyEnv).toEqual([]);
    expect(readPlatformApiKey(gateway!)).toBeNull();
  });

  it("管理员仍然可以改内置提供商的 baseUrl", () => {
    const catalog = loadProviderCatalog(
      {},
      {
        activeProviderId: null,
        secrets: {},
        overrides: [{ id: "openrouter", baseUrl: "https://gateway.internal/v1" }],
      },
      { scopeId: "admin-1", definitionsEditable: true },
    );

    expect(catalog.providers.find((provider) => provider.id === "openrouter")?.baseUrl)
      .toBe("https://gateway.internal/v1");
    expect(catalog.definitionsEditable).toBe(true);
  });

  it("平台 Key 只来自环境变量/内联，用户保存的 Key 不会被当成平台额度", () => {
    const env = { OPENROUTER_API_KEY: "platform-secret" };
    const catalog = loadProviderCatalog(
      env,
      {
        activeProviderId: null,
        secrets: { openrouter: secretOf("sk-user-own") },
        overrides: [],
      },
      { scopeId: "bob", definitionsEditable: false },
    );

    const openrouter = catalog.providers.find((provider) => provider.id === "openrouter");
    expect(readOwnApiKey(openrouter!)).toBe("sk-user-own");
    expect(readPlatformApiKey(openrouter!, env)).toBe("platform-secret");
  });
});
