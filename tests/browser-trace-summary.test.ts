// @vitest-environment node
import { describe, expect, it } from "vitest";
import { summarizeBrowserTrace } from "../benchmark/browser-trace-summary";

const mark = (name: string, ts: number) => ({ name, ts, ph: "I", pid: 1, tid: 2 });
const span = (name: string, ts: number, dur: number, tid = 2) => ({ name, ts, dur, ph: "X", pid: 1, tid });

describe("browser trace operation summary", () => {
  it("unions nested script events and separates style, layout, and paint", () => {
    const summary = summarizeBrowserTrace(
      [
        mark("tachyon:noChange:start", 1000),
        mark("tachyon:noChange:sync", 4000),
        mark("tachyon:noChange:settled", 10_000),
        span("FunctionCall", 2000, 2000),
        span("EvaluateScript", 2500, 1000),
        span("FunctionCall", 9000, 3000),
        span("Layout", 4000, 1000),
        span("UpdateLayoutTree", 4500, 1000),
        span("Paint", 6000, 500),
        span("Paint", 7000, 500, 3),
      ],
      ["noChange"],
    );

    expect(summary.noChange).toEqual({
      syncMarkMs: 3,
      settledMarkMs: 9,
      mainThreadTaskMs: 0,
      scriptEventMs: 3,
      styleLayoutMs: 1.5,
      paintMs: 0.5,
    });
  });

  it("requires all operation marks in order", () => {
    expect(() => summarizeBrowserTrace([mark("tachyon:create:start", 1000)], ["create"])).toThrow(/Missing trace mark/);
    expect(() =>
      summarizeBrowserTrace(
        [mark("tachyon:create:start", 1000), mark("tachyon:create:sync", 3000), mark("tachyon:create:settled", 2000)],
        ["create"],
      ),
    ).toThrow(/out of order/);
  });
});
