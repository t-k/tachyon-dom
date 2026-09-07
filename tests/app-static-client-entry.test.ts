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
  const emitPages = (clientEntry?: "always" | "when-required") => {
    const plugin = tachyonApp(app(), clientEntry ? { clientEntry } : {});
    if (typeof plugin.generateBundle !== "function") throw new Error("Missing generateBundle hook.");
    const emitted = new Map<string, string>();
    const context = {
      emitFile({ fileName, source }: { fileName: string; source: string }) {
        emitted.set(fileName, source);
      },
    } as never;
    plugin.generateBundle.call(context, {} as never, {
      "assets/entry.js": { type: "chunk", isEntry: true, fileName: "assets/entry.js" },
    } as never, false as never);
    return emitted;
  };

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

  it("keeps the same page markup apart from the entry script", () => {
    const always = emitPages().get("index.html") ?? "";
    const whenRequired = emitPages("when-required").get("index.html") ?? "";

    expect(always).toContain("<h1>Static</h1>");
    expect(whenRequired).toContain("<h1>Static</h1>");
    expect(always.replace(/<script[^>]*><\/script>/, "")).toBe(whenRequired);
  });
});
