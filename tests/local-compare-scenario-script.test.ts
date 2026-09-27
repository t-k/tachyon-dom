import { describe, expect, it, vi } from "vitest";
import { browserScenarioScript } from "../benchmark/local-compare/scenario-script";

describe("local comparison scenario timing", () => {
  it("reports synchronous work separately from the two-frame settle", async () => {
    document.body.innerHTML = `<button id="run"></button><button id="clear"></button>`;
    document.querySelector("#run")?.addEventListener("click", () => {
      document.body.dataset.rows = "1000";
    });
    document.querySelector("#clear")?.addEventListener("click", () => {
      document.body.dataset.rows = "0";
    });
    const frame = vi.fn((callback: FrameRequestCallback) => {
      queueMicrotask(() => callback(performance.now()));
      return 1;
    });
    const benchmarkWindow = {} as {
      __runLocalBenchmarkScenario: (id: string) => Promise<{
        syncUpdateMs: number;
        settledUpdateMs: number;
      }>;
    };
    new Function("window", "document", "performance", "requestAnimationFrame", browserScenarioScript)(
      benchmarkWindow,
      document,
      performance,
      frame,
    );

    const result = await benchmarkWindow.__runLocalBenchmarkScenario("createRows");

    expect(document.body.dataset.rows).toBe("1000");
    expect(result.syncUpdateMs).toBeGreaterThanOrEqual(0);
    expect(result.settledUpdateMs).toBeGreaterThanOrEqual(result.syncUpdateMs);
    expect(frame).toHaveBeenCalledTimes(4);
  });
});
