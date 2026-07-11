import { describe, expect, it } from "vitest";
import { formatWebFrameworkRanking, scoreWebFrameworkMetrics } from "../benchmark/web-framework/report";

describe("web framework benchmark report", () => {
  it("ranks frameworks by normalized throughput and latency geomean", () => {
    const rows = scoreWebFrameworkMetrics([
      {
        framework: "slow",
        staticRequestsPerSecond: 100,
        staticLatencyP95Ms: 20,
        dynamicRequestsPerSecond: 100,
        dynamicLatencyP95Ms: 20,
        streamTtfbMs: 20,
        streamCompleteMs: 40,
        streamWarmups: 5,
        streamSamples: [],
        clientNavigationMs: 20,
        clientBundleBytes: 20_480,
      },
      {
        framework: "fast",
        staticRequestsPerSecond: 200,
        staticLatencyP95Ms: 10,
        dynamicRequestsPerSecond: 200,
        dynamicLatencyP95Ms: 10,
        streamTtfbMs: 10,
        streamCompleteMs: 20,
        streamWarmups: 5,
        streamSamples: [],
        clientNavigationMs: 10,
        clientBundleBytes: 10_240,
      },
    ]);

    expect(rows[0]?.framework).toBe("fast");
    expect(rows[0]?.rank).toBe(1);
    expect(rows[0]?.score).toBe(1);
    expect(rows[1]?.score).toBeGreaterThan(1);
    expect(formatWebFrameworkRanking(rows)).toContain("| 1 | fast | 1.000x |");
    expect(formatWebFrameworkRanking(rows)).toContain("10.0KiB");
  });
});
