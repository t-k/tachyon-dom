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

  it("marks only the unscored trace from click through both frame callbacks", async () => {
    document.body.innerHTML = `<button id="run"></button><button id="clear"></button>`;
    const marks: string[] = [];
    const timing = {
      now: () => 1,
      getEntriesByType: () => [],
      mark: (name: string) => marks.push(name),
    };
    const frame = (callback: FrameRequestCallback) => {
      queueMicrotask(() => callback(1));
      return 1;
    };
    const benchmarkWindow = {} as {
      __runLocalBenchmarkScenario: (id: string, trace?: boolean) => Promise<unknown>;
    };
    new Function("window", "document", "performance", "requestAnimationFrame", browserScenarioScript)(
      benchmarkWindow,
      document,
      timing,
      frame,
    );

    await benchmarkWindow.__runLocalBenchmarkScenario("createRows");
    expect(marks).toEqual([]);

    await benchmarkWindow.__runLocalBenchmarkScenario("createRows", true);
    expect(marks).toEqual([
      "local-compare:createRows:start",
      "local-compare:createRows:sync-end",
      "local-compare:createRows:first-frame",
      "local-compare:createRows:second-frame",
    ]);
  });
});
