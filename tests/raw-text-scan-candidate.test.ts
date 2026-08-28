import { describe, expect, it } from "vitest";

import { scanRawText, type RawTextScanState } from "../src/html-raw-text";

type CandidateScanner = typeof scanRawText;

const loadCandidate = async (): Promise<CandidateScanner | undefined> => {
  try {
    const candidatePath = "../benchmark/raw-text-scan/candidate";
    return (await import(/* @vite-ignore */ candidatePath)).scanRawTextWithNativeSearch;
  } catch {
    return undefined;
  }
};

const expectEquivalent = (
  candidate: CandidateScanner,
  input: string,
  offset: number,
  state: RawTextScanState,
): void => {
  expect(candidate(input, offset, state)).toEqual(scanRawText(input, offset, state));
};

describe("raw-text native-search candidate", () => {
  it("matches every accepted closing-tag boundary and ASCII case variant", async () => {
    const candidate = await loadCandidate();
    expect(candidate).toBeTypeOf("function");
    if (!candidate) return;

    for (const boundary of [">", "/", " ", "\t", "\n", "\f", "\r"]) {
      expectEquivalent(candidate, `prefix</ScRiPt${boundary}tail`, 0, {
        tagName: "script",
        scriptState: "data",
      });
      expectEquivalent(candidate, `prefix</StYlE${boundary}tail`, 0, {
        tagName: "style",
        scriptState: "data",
      });
    }
  });

  it("matches invalid boundaries, lookalikes, partial tokens, and absent closes", async () => {
    const candidate = await loadCandidate();
    expect(candidate).toBeTypeOf("function");
    if (!candidate) return;

    for (const input of ["</scriptx>", "</script=", "</scrip", "plain text", "</stylex>", "</style="]) {
      expectEquivalent(candidate, input, 0, {
        tagName: input.includes("style") ? "style" : "script",
        scriptState: "data",
      });
    }
  });

  it("matches script data, escaped, and double-escaped transitions", async () => {
    const candidate = await loadCandidate();
    expect(candidate).toBeTypeOf("function");
    if (!candidate) return;

    const cases: Array<[string, RawTextScanState]> = [
      ["plain<!--escaped without close", { tagName: "script", scriptState: "data" }],
      ["plain<!--escaped</script>", { tagName: "script", scriptState: "data" }],
      ["<script>double without close", { tagName: "script", scriptState: "escaped" }],
      ["-->data</script>", { tagName: "script", scriptState: "escaped" }],
      ["</script>escaped</script>", { tagName: "script", scriptState: "double-escaped" }],
      ["-->data</script>", { tagName: "script", scriptState: "double-escaped" }],
    ];
    for (const [input, state] of cases) expectEquivalent(candidate, input, 0, state);
  });

  it("preserves UTF-16 indices and non-zero offsets", async () => {
    const candidate = await loadCandidate();
    expect(candidate).toBeTypeOf("function");
    if (!candidate) return;

    const input = "ignored🧪日本語</SCRIPT>tail";
    for (const offset of [0, 3, "ignored".length, input.length - 1, input.length]) {
      expectEquivalent(candidate, input, offset, { tagName: "script", scriptState: "data" });
    }
  });
});
