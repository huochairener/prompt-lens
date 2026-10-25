import axios from "axios";
import { describe, expect, it } from "vitest";

import { describeAnalysisProviderError } from "@/lib/ai/provider-error";
import { decodeAnalyzeApiKey } from "@/lib/usage/analyze-keys";

describe("analysis provider authentication", () => {
  it("turns KIE 401 responses into an actionable message", () => {
    const error = new axios.AxiosError(
      "Request failed with status code 401",
      "ERR_BAD_REQUEST",
      undefined,
      undefined,
      { status: 401, data: { msg: "Unauthorized" } } as never,
    );

    expect(describeAnalysisProviderError("kie", error)).toContain(
      "IP 白名单",
    );
  });

  it("reads plain and encrypted stored keys, rejects empty ones", () => {
    expect(decodeAnalyzeApiKey("sk-plain")).toBe("sk-plain");
    expect(decodeAnalyzeApiKey("   ")).toBeNull();
    // 不是合法的加密串时原样返回，避免历史数据不可用
    expect(decodeAnalyzeApiKey("aa:bb")).toBe("aa:bb");
  });
});
