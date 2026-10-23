import { describe, expect, it } from "vitest";

import {
  buildAlert,
  mergeActionableLogs,
  parseJsonLines,
} from "../scripts/vercel-log-report.mjs";

describe("parseJsonLines", () => {
  it("parses Vercel JSONL and ignores blank lines", () => {
    expect(
      parseJsonLines('{"level":"error","message":"boom"}\n\n'),
    ).toEqual([{ level: "error", message: "boom" }]);
  });

  it("fails loudly when the CLI output is not valid JSONL", () => {
    expect(() => parseJsonLines("Not authorized")).toThrow(
      /invalid Vercel JSONL/i,
    );
  });
});

describe("mergeActionableLogs", () => {
  it("keeps errors, fatal entries and 5xx requests while excluding warnings and 4xx", () => {
    const entries = mergeActionableLogs([
      { level: "warning", statusCode: 429, message: "rate limited" },
      { level: "error", statusCode: 200, message: "KIE API error (524)" },
      { level: "info", statusCode: 502, message: "POST /api/analyze" },
      { level: "fatal", message: "worker crashed" },
    ]);

    expect(entries).toHaveLength(3);
    expect(entries.map((entry) => entry.message)).toEqual([
      "KIE API error (524)",
      "POST /api/analyze",
      "worker crashed",
    ]);
  });

  it("deduplicates the same request returned by both Vercel queries", () => {
    const duplicate = {
      id: "log_1",
      requestId: "req_1",
      level: "error",
      statusCode: 500,
      message: "failed",
      timestamp: 1792746000000,
    };

    expect(mergeActionableLogs([duplicate], [{ ...duplicate }])).toHaveLength(1);
  });
});

describe("buildAlert", () => {
  it("groups repeated signatures and includes operational collection failures", () => {
    const alert = buildAlert({
      logs: [
        {
          level: "error",
          statusCode: 500,
          path: "/api/analyze",
          message: "KIE API error (524): request abc123 failed",
          timestamp: "2026-10-23T01:00:00.000Z",
        },
        {
          level: "error",
          statusCode: 500,
          path: "/api/analyze",
          message: "KIE API error (524): request def456 failed",
          timestamp: "2026-10-23T02:00:00.000Z",
        },
      ],
      collectionFailures: ["5xx query: permission denied"],
      projectName: "prompt-lens",
    });

    expect(alert).not.toBeNull();
    expect(alert.subject).toContain("prompt-lens");
    expect(alert.text).toContain("/api/analyze");
    expect(alert.text).toContain("出现次数：2");
    expect(alert.text).toContain("permission denied");
    expect(alert.text).toContain("请登录 Vercel");
  });

  it("returns null when there are no findings or collection failures", () => {
    expect(
      buildAlert({
        logs: [],
        collectionFailures: [],
        projectName: "prompt-lens",
      }),
    ).toBeNull();
  });
});
