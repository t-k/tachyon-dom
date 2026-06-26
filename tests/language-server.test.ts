import { describe, expect, it } from "vitest";
import { diagnosticsForTachyonDocument } from "../src/language-server";

describe("Tachyon language server diagnostics", () => {
  it("converts Tachyon compiler diagnostics to LSP diagnostics", () => {
    const diagnostics = diagnosticsForTachyonDocument("<main>\n<if></if>\n</main>");

    expect(diagnostics).toEqual([
      {
        message: "<if> requires test={condition}.",
        range: {
          start: { line: 0, character: 0 },
          end: { line: 0, character: 4 },
        },
        severity: 1,
        source: "tachyon-dom",
      },
    ]);
  });

  it("returns no diagnostics for valid Tachyon documents", () => {
    expect(diagnosticsForTachyonDocument("<main><h1>{title}</h1></main>")).toEqual([]);
  });
});
