import { describe, expect, it, vi } from "vitest";

const { findMany } = vi.hoisted(() => ({ findMany: vi.fn() }));
vi.mock("@/lib/db", () => ({ db: { query: { userApiKeys: { findMany } } } }));
vi.mock("@/lib/usage/analyze-keys", () => ({ decodeAnalyzeApiKey: (value: string) => value }));

import { analyzeFrames } from "@/lib/ai/analyzer";
import { resolveLegacyAnalysisModel } from "@/lib/ai/analysis-models";

// Explicit opt-in: these smoke tests call KIE and consume a small amount of credit.
describe.runIf(process.env.KIE_LIVE_TEST === "1")("live KIE analysis", () => {
  const publicFrame = "https://file.aiquickdraw.com/custom-page/akr/section-images/1759055072437dqlsclj2.png";

  it("analyzes image frames with the user's own KIE key", async () => {
    const key = (process.env.KIE_AI_API_KEY || process.env.KIE_API_KEY || "").trim();
    expect(key).toBeTruthy();

    const model = resolveLegacyAnalysisModel("kie-gemini-3.8-flash")!;
    findMany.mockReset();
    // 模拟用户在 user_api_keys 里保存了自己的 Key
    findMany.mockResolvedValue([{ apiKey: key }]);

    const result = await analyzeFrames({
      userId: "live-smoke-test",
      provider: model.provider,
      model: model.model,
      frames: [publicFrame, publicFrame],
      mode: "batch",
      outputLanguage: "zh",
    });

    expect(findMany).toHaveBeenCalledTimes(1);
    expect(result.error).toBeUndefined();
    expect(result.success).toBe(true);
    expect(result.prompt!.length).toBeGreaterThan(100);
    expect(result.corePrompt).toBeTruthy();
  }, 200_000);
});
