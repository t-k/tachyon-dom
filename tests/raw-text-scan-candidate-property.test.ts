import fc from "fast-check";
import { describe, expect, it } from "vitest";

import { scanRawText, type RawTextScanState } from "../src/html-raw-text";
import { propertyParameters } from "./fast-check-config";

type CandidateScanner = typeof scanRawText;

const loadCandidate = async (): Promise<CandidateScanner | undefined> => {
  try {
    const candidatePath = "../benchmark/raw-text-scan/candidate";
    return (await import(/* @vite-ignore */ candidatePath)).scanRawTextWithNativeSearch;
  } catch {
    return undefined;
  }
};

const chunk = fc.constantFrom(
  "",
  "a",
  "<",
  "-",
  "<!--",
  "-->",
  "<script",
  "<ScRiPt",
  "</script",
  "</SCRIPT",
  "</style",
  "</STYLE",
  ">",
  "/",
  " ",
  "\t",
  "\n",
  "\f",
  "\r",
  "=",
  "x",
  "日本語",
  "🧪",
);

const inputArbitrary = fc.array(chunk, { maxLength: 80 }).map((chunks) => chunks.join(""));
const stateArbitrary = fc.record({
  tagName: fc.constantFrom("script", "style"),
  scriptState: fc.constantFrom("data", "escaped", "double-escaped"),
}) as fc.Arbitrary<RawTextScanState>;

describe("raw-text native-search candidate properties", () => {
  it("matches the production scanner for generated token sequences and offsets", async () => {
    const candidate = await loadCandidate();
    expect(candidate).toBeTypeOf("function");
    if (!candidate) return;

    fc.assert(
      fc.property(inputArbitrary, stateArbitrary, fc.nat(), (input, state, offsetSeed) => {
        const offset = offsetSeed % (input.length + 1);
        expect(candidate(input, offset, state)).toEqual(scanRawText(input, offset, state));
      }),
      propertyParameters({ seed: 0x51ad2026, numRuns: 2_000 }),
    );
  });
});
