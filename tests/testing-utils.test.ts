import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { defineApp } from "../src/app";
import {
  assertAppHtml,
  assertRouteParity,
  renderAppForTest,
  renderRouteForTest,
  renderTdForTest,
} from "../src/testing";

describe("testing utilities", () => {
  it("renders routes for tests and checks server/client parity", async () => {
    const route = { path: "/", render: () => "<h1>Home</h1>" };

    expect((await renderRouteForTest([route], "/")).html).toBe("<h1>Home</h1>");
    await expect(assertRouteParity([route], [{ path: "/", clientHtml: "<h1>Home</h1>" }])).resolves.toBeUndefined();
    await expect(assertRouteParity([route], [{ path: "/", clientHtml: "<h1>Other</h1>" }])).rejects.toThrow(
      "Route parity mismatch for /: expected <h1>Other</h1>, received <h1>Home</h1>",
    );
  });

  it("renders app definitions for SSR tests", () => {
    const app = defineApp({
      pages: [
        {
          path: "/",
          fileName: "index.html",
          template: `<section><h1>{title}</h1></section>`,
          scope: { title: "Home" },
        },
      ],
    });

    expect(renderAppForTest(app, "/")).toContain("<h1>Home</h1>");
    expect(() => assertAppHtml(app, "/", ["<main", "<h1>Home</h1>"])).not.toThrow();
    expect(() => assertAppHtml(app, "/", ["Missing"])).toThrow("App HTML assertion failed");
  });

  it("renders .td files directly for Vitest SSR assertions", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "tachyon-render-td-test-"));
    const file = path.join(dir, "view.td");
    await writeFile(
      file,
      `<section lang={locale}><h1>{title}</h1><p class:hidden={hidden}>{body}</p><ul><for each={rows} key={row.id}><li>{row.label}</li></for></ul></section>`,
    );

    await expect(
      renderTdForTest(
        file,
        {
          title: "Hello",
          body: `<img src=x onerror=alert(1)>`,
          hidden: true,
          rows: [
            { id: 1, label: "One" },
            { id: 2, label: "Two" },
          ],
        },
        { locale: "ja" },
      ),
    ).resolves.toBe(
      `<section lang="ja"><h1>Hello</h1><p class="hidden">&lt;img src=x onerror=alert(1)&gt;</p><ul><!--tachyon-for--><li>One</li><li>Two</li><!--/tachyon-for--></ul></section>`,
    );
  });

  it("formats .td diagnostics with the template path", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "tachyon-render-td-error-"));
    const file = path.join(dir, "broken.td");
    await writeFile(file, `<ul><for key={row.id}><li>{row.label}</li></for></ul>`);

    await expect(renderTdForTest(file, {})).rejects.toThrow(`${file}:1:5: <for> requires each={items}.`);
  });
});
