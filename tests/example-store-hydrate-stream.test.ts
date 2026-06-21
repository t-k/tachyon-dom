import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { generatedClientModule, renderExampleHtml, renderExampleResponse } from "../examples/store-hydrate-stream";

describe("store hydrate stream example", () => {
  it("loads the streamed template from a .td file", () => {
    const template = join(process.cwd(), "examples", "store-hydrate-stream.td");
    expect(existsSync(template)).toBe(true);
    expect(readFileSync(template, "utf8")).toContain("<script>");
  });

  it("renders streamed HTML with hydrate markers", async () => {
    const html = await renderExampleHtml();

    expect(html).toContain(`<!--tachyon-hydrate:counter-panel:start-->`);
    expect(html).toContain(`<section>`);
    expect(html).toContain(`<button>7</button>`);
    expect(html).toContain(`<!--tachyon-hydrate:counter-panel:end-->`);
    expect(html).not.toContain(`hydrate:id=`);
  });

  it("returns an HTML response backed by the stream adapter", async () => {
    const response = await renderExampleResponse();

    expect(response.headers.get("content-type")).toBe("text/html; charset=utf-8");
    expect(await response.text()).toContain(`<h1>Tachyon streaming example</h1>`);
  });

  it("shows the generated client module shape", () => {
    expect(generatedClientModule).toContain(`import { createStore } from "tachyon-dom/runtime/store";`);
    expect(generatedClientModule).toContain(`export const hydrationBoundaries = [{"path":`);
    expect(generatedClientModule).toContain(`"id":"islandId"`);
    expect(generatedClientModule).toContain(`read(state.count)`);
  });
});
