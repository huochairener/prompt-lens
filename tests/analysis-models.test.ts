import { describe, expect, it } from "vitest";
import { getKieAnalysisPath, resolveLegacyAnalysisModel } from "@/lib/ai/analysis-models";

describe("analysis models", () => {
  it("maps legacy platform ids to a provider model, no platform funding", () => {
    expect(resolveLegacyAnalysisModel("platform-gemini-3.8-flash")).toEqual({
      provider: "kie",
      model: "gemini-3-8-flash",
    });
    // 老 id 一律落到同一个通道，且没有任何"平台 Key"标记
    expect(resolveLegacyAnalysisModel("platform-gemini-2.5-flash")).toEqual({
      provider: "kie",
      model: "gemini-3-8-flash",
    });
  });

  it("keeps the KIE user-key models addressable for open tabs", () => {
    expect(resolveLegacyAnalysisModel("kie-gemini-3.8-flash")).toEqual({
      provider: "kie",
      model: "gemini-3-8-flash",
    });
    expect(resolveLegacyAnalysisModel("kie-gemini-3.5-flash")).toEqual({
      provider: "kie",
      model: "gemini-3-5-flash-thinking",
    });
    expect(resolveLegacyAnalysisModel("kie-gemini-2.5-pro")).toEqual({
      provider: "kie",
      model: "gemini-2.5-pro",
    });
  });

  it("rejects unknown model ids", () => {
    expect(resolveLegacyAnalysisModel("other-model")).toBeNull();
    expect(resolveLegacyAnalysisModel(null)).toBeNull();
  });

  it("maps request models to their explicit KIE channels", () => {
    expect(getKieAnalysisPath(null, "gemini-3-8-flash")).toBe("/gemini-3-8-flash-openai/v1/chat/completions");
    expect(getKieAnalysisPath(null, "gemini-3-5-flash-thinking")).toBe("/gemini-3-5-flash-thinking-openai/v1/chat/completions");
    expect(getKieAnalysisPath(null, "gemini-2.5-pro")).toBe("/gemini-2.5-pro/v1/chat/completions");
    expect(() => getKieAnalysisPath(null, "gemini-2.5-flash")).toThrow("Unsupported");
  });
});
