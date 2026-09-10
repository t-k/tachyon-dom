import { describe, expect, it } from "vitest";

import { defineApp } from "../src/app.js";
import { tachyonApp } from "../src/vite.js";

const app = defineApp({
  shell: ({ routeHtml }) => `<main   id="app">${routeHtml}</main>`,
  pages: [{ path: "/", fileName: "index.html", template: "<p>ok</p>", scope: {} }],
});

const invokeHooks = (options: Record<string, unknown>): { development: string; production: string } => {
  const plugin = tachyonApp(app, options as never);
  let middleware!: (request: { url?: string }, response: Record<string, unknown>, next: () => void) => void;
  const configureServer = plugin.configureServer as (server: unknown) => void;
  configureServer({ middlewares: { use: (value: typeof middleware) => (middleware = value) } });
  let development = "";
  middleware(
    { url: "/" },
    {
      statusCode: 0,
      setHeader: () => undefined,
      end: (value: string) => {
        development = value;
      },
    },
    () => undefined,
  );

  let production = "";
  const generateBundle = plugin.generateBundle as (...args: unknown[]) => void;
  generateBundle.call(
    {
      emitFile: (asset: { fileName: string; source: string }) => {
        if (asset.fileName === "index.html") production = asset.source;
      },
    },
    {},
    { "main.js": { type: "chunk", isEntry: true, fileName: "main.js" } },
  );
  return { development, production };
};

describe("tachyonApp HTML whitespace policy", () => {
  it.each([
    ["current normalize", { htmlWhitespace: "normalize-tags" }, false, false],
    ["current preserve", { htmlWhitespace: "preserve-tags" }, true, true],
    ["legacy condense", { htmlWhitespace: "condense" }, false, false],
    ["legacy preserve", { htmlWhitespace: "preserve" }, true, true],
    ["deprecated minify true", { minifyHtml: true }, false, false],
    ["deprecated minify false", { minifyHtml: false }, true, true],
    ["mode defaults", {}, true, false],
  ] as const)(
    "applies %s consistently to actual development and build hooks",
    (_label, options, devPreserves, buildPreserves) => {
      const frozen = Object.freeze({ ...options });
      const result = invokeHooks(frozen);
      expect(result.development.includes(`<main   id="app">`)).toBe(devPreserves);
      expect(result.production.includes(`<main   id="app">`)).toBe(buildPreserves);
      expect(frozen).toEqual(options);
    },
  );

  it("gives explicit htmlWhitespace precedence over deprecated minifyHtml", () => {
    const result = invokeHooks({ htmlWhitespace: "preserve-tags", minifyHtml: true });
    expect(result.development).toContain(`<main   id="app">`);
    expect(result.production).toContain(`<main   id="app">`);
  });

  it.each(["unknown", "", null, 42, {}])("rejects invalid runtime policy %j during plugin creation", (policy) => {
    expect(() => tachyonApp(app, { htmlWhitespace: policy } as never)).toThrow(/HTML whitespace policy.*migration/i);
  });
});
