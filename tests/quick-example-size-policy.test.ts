import { describe, expect, it } from "vitest";
import { checkQuickExampleSizes } from "../scripts/quick-example-size-policy.mjs";

const validSizes = {
  expectedMinified: 11_571,
  actualMinified: 11_571,
  expectedBrotli: 3_850,
  actualBrotli: 3_850,
  maxMinified: 12_000,
  maxBrotli: 4_000,
};

describe("quick example size policy", () => {
  it.each([
    [3_849, true],
    [3_850, true],
    [3_851, true],
    [3_889, true],
    [3_890, false],
  ])("checks the Brotli baseline against %i bytes", (actualBrotli, accepted) => {
    expect(checkQuickExampleSizes({ ...validSizes, actualBrotli }).ok).toBe(accepted);
  });

  it("keeps minified bytes exact", () => {
    expect(checkQuickExampleSizes({ ...validSizes, actualMinified: validSizes.expectedMinified + 1 })).toEqual({
      ok: false,
      reason: "minified baseline",
    });
  });

  it("enforces absolute budgets before accepting baseline variance", () => {
    expect(
      checkQuickExampleSizes({
        ...validSizes,
        expectedBrotli: 4_000,
        actualBrotli: 4_001,
      }),
    ).toEqual({ ok: false, reason: "absolute budget" });
  });
});
