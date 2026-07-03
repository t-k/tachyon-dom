import { afterEach, describe, expect, it, vi } from "vitest";
import { createDiagnosticsScheduler, diagnosticsForTachyonDocument } from "../src/language-server";

describe("Tachyon language server diagnostics", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

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

  it("debounces change diagnostics so keypresses do not compile immediately", () => {
    vi.useFakeTimers();
    const sent: Array<{ uri: string; diagnostics: ReturnType<typeof diagnosticsForTachyonDocument> }> = [];
    let text = "<main><if></if></main>";
    const scheduler = createDiagnosticsScheduler((payload) => sent.push(payload), 50);
    const document = {
      uri: "file:///app/page.td",
      getText: () => text,
    };

    scheduler.schedule(document);
    text = "<main><if test={ready}></if></main>";
    scheduler.schedule(document);

    expect(sent).toEqual([]);
    vi.advanceTimersByTime(49);
    expect(sent).toEqual([]);
    vi.advanceTimersByTime(1);
    expect(sent).toEqual([{ uri: "file:///app/page.td", diagnostics: [] }]);
    scheduler.dispose();
  });
});
