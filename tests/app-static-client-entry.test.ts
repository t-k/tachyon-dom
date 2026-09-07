// @vitest-environment node
import { describe, expect, it } from "vitest";
import { defineApp } from "../src/app";
import { tachyonApp } from "../src/vite";

const app = () =>
  defineApp({
    pages: [
      { path: "/", fileName: "index.html", template: `<main><h1>Static</h1><p>No client work here.</p></main>` },
      { path: "/text", fileName: "text.html", template: `<main><p>{message}</p></main>`, scope: { message: "M" } },
      {
        path: "/event",
        fileName: "event.html",
        template: `<main><button on:click={save}>Save</button></main>`,
        scope: { save: () => undefined },
      },
      {
        path: "/list",
        fileName: "list.html",
        template: `<ul><for each={rows} key={row.id}><li>{row.label}</li></for></ul>`,
        scope: { rows: [{ id: "a", label: "A" }] },
      },
      {
        path: "/island",
        fileName: "island.html",
        template: `<main><h1>Static</h1><section hydrate:interaction="click"><button on:click={open}>Open</button></section></main>`,
        scope: { open: () => undefined },
      },
      { path: "/setup", fileName: "setup.html", template: `<script setup>const title = "T";</script><main><h1>Fixed</h1></main>` },
      {
        path: "/dead-branch",
        fileName: "dead.html",
        template: `<main><if test={false}><button on:click={save}>Save</button></if><h1>Static</h1></main>`,
      },
    ],
  });

describe("static pages without a client entry", () => {
  it("reports which pages need a client entry", () => {
    const instance = app();

    expect(instance.requiresClientEntry("/")).toBe(false);
    // A constant false branch is removed before the client bindings are collected.
    expect(instance.requiresClientEntry("/dead-branch")).toBe(false);

    expect(instance.requiresClientEntry("/text")).toBe(true);
    expect(instance.requiresClientEntry("/event")).toBe(true);
    expect(instance.requiresClientEntry("/list")).toBe(true);
    expect(instance.requiresClientEntry("/island")).toBe(true);
    // A setup script's statements are not proven side-effect free, so the page keeps its entry.
    expect(instance.requiresClientEntry("/setup")).toBe(true);
  });

  it("reports true for a path with no page", () => {
    expect(app().requiresClientEntry("/missing")).toBe(true);
  });

  it("renders the same markup with and without the entry script", () => {
    const instance = app();
    const withScript = instance.renderDocument("/", { assets: { scripts: ["/main.js"], styles: [] } });
    const withoutScript = instance.renderDocument("/", { assets: { scripts: [], styles: [] } });

    expect(withScript).toContain(`src="/main.js"`);
    expect(withoutScript).not.toContain("<script");
    expect(withoutScript.replace(/<\/body>/, "")).toBe(
      withScript.replace(/<script[^>]*><\/script>/, "").replace(/<\/body>/, ""),
    );
  });
});

describe("tachyonApp client entry emission", () => {
  type EntryOptions = Parameters<typeof tachyonApp>[1];

  const runBundle = (
    options: EntryOptions = {},
    bundle: Record<string, unknown> = {
      "assets/entry.js": { type: "chunk", isEntry: true, fileName: "assets/entry.js", code: "", imports: [], dynamicImports: [] },
    },
  ) => {
    const plugin = tachyonApp(app(), options);
    if (typeof plugin.generateBundle !== "function") throw new Error("Missing generateBundle hook.");
    const emitted = new Map<string, string>();
    const warnings: string[] = [];
    const context = {
      emitFile({ fileName, source }: { fileName: string; source: string }) {
        emitted.set(fileName, source);
      },
      warn(message: string) {
        warnings.push(message);
      },
    } as never;
    plugin.generateBundle.call(context, {} as never, bundle as never, false as never);
    return { pages: emitted, warnings, bundle };
  };

  const emitPages = (clientEntry?: "always" | "when-required") =>
    runBundle(clientEntry ? { clientEntry } : {}).pages;

  it("puts the entry on every page by default", () => {
    const pages = emitPages();

    for (const [fileName, source] of pages) {
      expect([fileName, source.includes("assets/entry.js")]).toEqual([fileName, true]);
    }
  });

  it("omits the entry only from pages that need no client work", () => {
    const pages = emitPages("when-required");

    expect(pages.get("index.html")).not.toContain("assets/entry.js");
    expect(pages.get("dead.html")).not.toContain("assets/entry.js");
    for (const fileName of ["text.html", "event.html", "list.html", "island.html", "setup.html"]) {
      expect([fileName, pages.get(fileName)?.includes("assets/entry.js")]).toEqual([fileName, true]);
    }
  });

  // The entry is application code. Nothing in it is generated, so the plugin cannot see whether it also does
  // something every page needs; an entry with any code of its own therefore stays on every page.
  it("keeps an entry that does work of its own on every page", () => {
    const { pages, warnings } = runBundle(
      { clientEntry: "when-required" },
      {
        "assets/entry.js": {
          type: "chunk",
          isEntry: true,
          fileName: "assets/entry.js",
          code: `document.addEventListener("click", () => {});\n//# sourceMappingURL=entry.js.map\n`,
          imports: [],
          dynamicImports: [],
        },
      },
    );

    for (const [fileName, source] of pages) {
      expect([fileName, source.includes("assets/entry.js")]).toEqual([fileName, true]);
    }
    expect(warnings.join("\n")).toContain("assets/entry.js");
  });

  it("omits an entry that does work once the app declares it only mounts pages", () => {
    const { pages, warnings } = runBundle(
      { clientEntry: "when-required", clientEntryScope: "pages" },
      {
        "assets/entry.js": {
          type: "chunk",
          isEntry: true,
          fileName: "assets/entry.js",
          code: `import "./page.js";`,
          imports: [],
          dynamicImports: [],
        },
      },
    );

    expect(pages.get("index.html")).not.toContain("assets/entry.js");
    expect(pages.get("event.html")).toContain("assets/entry.js");
    expect(warnings).toEqual([]);
  });

  const entryBundle = (code: string | undefined) => ({
    "assets/entry.js": { type: "chunk", isEntry: true, fileName: "assets/entry.js", code, imports: [], dynamicImports: [] },
  });

  // A source map link and a strict mode directive are not work a page could need.
  it.each([
    ["nothing", ""],
    ["only a source map link", `//# sourceMappingURL=entry.js.map\n`],
    ["only a strict mode directive", `"use strict";\n`],
    ["a directive and a source map link", `"use strict";\n//# sourceMappingURL=entry.js.map\n`],
    ["no code at all", undefined],
  ])("leaves the entry out of a static page when it contains %s", (_case, code) => {
    expect(runBundle({ clientEntry: "when-required" }, entryBundle(code)).pages.get("index.html")).not.toContain(
      "assets/entry.js",
    );
  });

  it.each([
    ["code after a source map link", `//# sourceMappingURL=entry.js.map\nboot();\n`],
    ["code before a source map link", `boot();\n//# sourceMappingURL=entry.js.map\n`],
    ["a directive and code", `"use strict";\nboot();\n`],
    ["a comment an unminified build kept", `// set up analytics\n`],
  ])("keeps the entry on a static page when it contains %s", (_case, code) => {
    expect(runBundle({ clientEntry: "when-required" }, entryBundle(code)).pages.get("index.html")).toContain(
      "assets/entry.js",
    );
  });

  // Nothing loads a chunk every page left out, so the build stops shipping it at all: the entry, the chunks it
  // statically imports, and the ones it only imports lazily. Anything another entry still reaches has to stay.
  it("drops the chunks only the unused entry reaches", () => {
    const staticOnly = defineApp({
      pages: [{ path: "/", fileName: "index.html", template: `<main><h1>Static</h1></main>` }],
    });
    const plugin = tachyonApp(staticOnly, { clientEntry: "when-required" });
    if (typeof plugin.generateBundle !== "function") throw new Error("Missing generateBundle hook.");
    const chunk = (fileName: string, isEntry: boolean, imports: string[], dynamicImports: string[] = []) => ({
      type: "chunk",
      isEntry,
      fileName,
      code: "",
      imports,
      dynamicImports,
    });
    const bundle: Record<string, unknown> = {
      // The tachyon entry, a chunk it shares with a cycle back to it, and one it only reaches lazily.
      "assets/entry.js": chunk("assets/entry.js", true, ["assets/private.js", "assets/common.js", "external.js"], [
        "assets/lazy.js",
      ]),
      "assets/entry.js.map": { type: "asset", fileName: "assets/entry.js.map" },
      "assets/private.js": chunk("assets/private.js", false, ["assets/entry.js"]),
      "assets/lazy.js": chunk("assets/lazy.js", false, []),
      // Reached from a second entry as well, so it is not the tachyon entry's to remove.
      "assets/common.js": chunk("assets/common.js", false, []),
      "assets/worker.js": chunk("assets/worker.js", true, ["assets/common.js"]),
      "assets/site.css": { type: "asset", fileName: "assets/site.css" },
    };
    plugin.generateBundle.call({ emitFile() {}, warn() {} } as never, {} as never, bundle as never, false as never);

    expect(Object.keys(bundle).sort()).toEqual([
      "assets/common.js",
      "assets/site.css",
      "assets/worker.js",
    ]);
  });

  it("keeps the entry chunk when at least one page loads it", () => {
    const { bundle } = runBundle({ clientEntry: "when-required" });

    expect(Object.keys(bundle)).toContain("assets/entry.js");
  });

  it("keeps the same page markup apart from the entry script", () => {
    const always = emitPages().get("index.html") ?? "";
    const whenRequired = emitPages("when-required").get("index.html") ?? "";

    expect(always).toContain("<h1>Static</h1>");
    expect(whenRequired).toContain("<h1>Static</h1>");
    expect(always.replace(/<script[^>]*><\/script>/, "")).toBe(whenRequired);
  });
});
