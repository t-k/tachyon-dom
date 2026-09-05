import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
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
          start: { line: 1, character: 0 },
          end: { line: 1, character: 4 },
        },
        severity: 1,
        source: "tachyon-dom",
      },
    ]);
  });

  it("returns no diagnostics for valid Tachyon documents", () => {
    expect(diagnosticsForTachyonDocument("<main><h1>{title}</h1></main>")).toEqual([]);
  });

  it("reports unsupported stream await reordering at the reorder attribute", () => {
    const diagnostics = diagnosticsForTachyonDocument(
      `<main>\n  <await value={message} then="value" reorder="resolve">Ready</await>\n</main>`,
    );

    expect(diagnostics[0]).toMatchObject({
      message: '<await reorder="resolve"> is not supported by the stream target; use reorder="preserve" or omit it.',
      range: {
        start: { line: 1, character: 38 },
      },
    });
  });

  it("maps nested SFC semantic diagnostics to the same opening-tag range", () => {
    const diagnostics = diagnosticsForTachyonDocument(
      `<script>\nexport const scope = () => ({});\n</script>\n<main>\n  <section>\n    <if></if>\n  </section>\n</main>`,
    );

    expect(diagnostics[0]?.range).toEqual({
      start: { line: 5, character: 4 },
      end: { line: 5, character: 8 },
    });
  });

  it("shares TypeScript template diagnostics and source ranges with the checker", () => {
    const source = `<script lang="ts">
export const scope = () => ({ user: { name: "Ada" }, save: 123 });
</script>
<main><p>{user.missing}</p><button on:click={save}>Save</button></main>`;

    const diagnostics = diagnosticsForTachyonDocument(source);

    expect(diagnostics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: 2339,
          range: {
            start: { line: 3, character: 10 },
            end: { line: 3, character: 22 },
          },
          source: "typescript",
        }),
        expect.objectContaining({ code: 2322, source: "typescript" }),
      ]),
    );
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

  it("resolves TypeScript imports relative to the LSP document URI", async () => {
    const directory = await mkdtemp(join("/tmp", "tachyon-language-server-"));
    try {
      await writeFile(join(directory, "user.ts"), `export type User = { name: string };\n`);
      const source = `<script lang="ts">\nimport type { User } from "./user";\nexport const scope = (): { user: User } => ({ user: { name: "Ada" } });\n</script>\n<main>{user.name}</main>`;
      const uri = pathToFileURL(join(directory, "page.td")).href;
      vi.useFakeTimers();
      const sent: Array<{ uri: string; diagnostics: ReturnType<typeof diagnosticsForTachyonDocument> }> = [];
      const scheduler = createDiagnosticsScheduler((payload) => sent.push(payload), 50);

      scheduler.schedule({ uri, getText: () => source });
      await vi.advanceTimersByTimeAsync(50);

      expect(sent).toEqual([{ uri, diagnostics: [] }]);
      scheduler.dispose();
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});
