import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

function read(relativePath: string) {
  return fs.readFileSync(path.join(process.cwd(), relativePath), "utf8");
}

function exists(relativePath: string) {
  return fs.existsSync(path.join(process.cwd(), relativePath));
}

describe("analysis provider surface", () => {
  it("renders the model list from the provider catalog instead of a hardcoded list", () => {
    const dashboard = read("app/dashboard/page.tsx");

    // 不再写死模型 id：所有 option 都由接口返回的 modelOptions 渲染
    expect(dashboard).not.toMatch(/<option value="(?:platform|kie)-gemini-[^"]+"/);
    expect(dashboard).toContain('fetch("/api/analyze/models"');
    expect(dashboard).toContain("{modelOptions.map((option) => (");
    // 之前用 hasOwnApiKey 锁死下拉，导致配置了别的提供商也选不了
    expect(dashboard).not.toContain("disabled={!trialAccess?.hasOwnApiKey}");
  });

  it("no longer offers a platform trial or a shared quota", () => {
    const dashboard = read("app/dashboard/page.tsx");
    const route = read("app/api/analyze/route.ts");

    expect(dashboard).not.toContain("trialAccess");
    expect(dashboard).not.toContain("/api/analyze/quota");
    expect(route).not.toContain("assertTrialQuota");
    expect(route).not.toContain("trial-quota");
    expect(exists("app/api/analyze/quota/route.ts")).toBe(false);
  });

  it("only lets users configure KIE in settings", () => {
    const settings = read("components/api-key-settings.tsx");
    const route = read("app/api/settings/api-key/route.ts");

    expect(settings).toContain('body: JSON.stringify({ provider: "kie"');
    expect(settings).toContain('t("kieName")');
    expect(settings).not.toContain('t("openrouterName")');
    expect(settings).not.toMatch(/<option value="(openrouter|zhipu|gemini)">/);
    expect(route).toContain('if (provider !== "kie")');
  });

  it("resolves the API key on the server from the selected provider", () => {
    const route = read("app/api/analyze/route.ts");

    // 客户端只能选模型，Key 由服务端按提供商配置解析
    expect(route).toContain("resolveAnalysisTarget");
    expect(route).toContain("resolveAnalysisKey");
    expect(route).not.toContain("resolvePlatformAnalysisApiKey");
  });

  it("keeps server-side env keys for administrators only", () => {
    const resolveKey = read("lib/ai/providers/resolve-key.ts");
    const options = read("lib/ai/analysis-options.ts");

    expect(resolveKey).toContain("definitionsEditable");
    expect(options).toContain("definitionsEditable");
    // 没有自己的 Key 时必须引导用户去配置，而不是偷偷用服务端 Key
    expect(options).toContain("USER_KEY_REQUIRED");
  });
});
