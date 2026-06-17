import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { buildRouteManifestFile, compileFile } from "../src/cli";
import { diagnoseTemplate, formatDiagnostic } from "../src/diagnostics";
import { appendInlineSourceMap, createSourceMap, shouldEmitSourceMap } from "../src/source-map";
import { defineTemplate, templateScope, type TypedTemplate } from "../src/typed";
import { tachyonDom, tachyonDomRoutes } from "../src/vite";

type PanelScope = {
  title: string;
  count: number;
};

describe("DX helpers", () => {
  it("formats compiler diagnostics with line and column", () => {
    const result = diagnoseTemplate(`<main>\n<if></if>\n</main>`);

    expect(result.ok).toBe(false);
    if (result.ok) {
      throw new Error("Expected diagnostic.");
    }
    expect(result.error).toMatchObject({
      message: "<if> requires test={condition}.",
      line: 1,
      column: 1,
    });
    expect(formatDiagnostic(result.error, "bad.tachyon.html")).toContain(
      "bad.tachyon.html:1:1: <if> requires test={condition}.",
    );
  });

  it("appends an inline source map with sourcesContent", () => {
    const output = appendInlineSourceMap(
      "export const value = 1;\n",
      createSourceMap("<main></main>", "view.tachyon.html"),
    );
    const encoded = output.split("base64,")[1]?.trim();
    if (!encoded) {
      throw new Error("Missing source map.");
    }
    const map = JSON.parse(Buffer.from(encoded, "base64").toString("utf8")) as { sourcesContent: string[] };

    expect(map.sourcesContent).toEqual(["<main></main>"]);
  });

  it("keeps template scope types available to TypeScript users", () => {
    const typed = defineTemplate<PanelScope, `<h1>{title}</h1>`>(`<h1>{title}</h1>`);
    const scoped = templateScope<PanelScope>().define(`<button>{count}</button>`);

    expect(typed satisfies TypedTemplate<PanelScope>).toEqual({ source: `<h1>{title}</h1>` });
    expect(scoped.source).toBe(`<button>{count}</button>`);
  });

  it("marks the package as tree-shakable for bundlers", async () => {
    const packageJson = JSON.parse(await readFile("package.json", "utf8")) as {
      sideEffects?: boolean;
      exports?: Record<string, unknown>;
    };

    expect(packageJson.sideEffects).toBe(false);
    expect(packageJson.exports).toHaveProperty("./runtime/list");
    expect(packageJson.exports).toHaveProperty("./router");
  });

  it("compiles template files through the CLI helper", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "tachyon-dom-"));
    try {
      const input = path.join(dir, "view.tachyon.html");
      const output = path.join(dir, "view.js");
      await writeFile(input, `<main>{title}</main>`);

      const result = await compileFile({ input, output, target: "client", reactive: false, sourcemap: true });

      expect(result.ok).toBe(true);
      expect(await readFile(output, "utf8")).toContain(`export const templateHtml = "<main> </main>";`);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("builds a file route manifest through the CLI helper", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "tachyon-dom-routes-"));
    try {
      const routesDir = path.join(dir, "routes");
      const output = path.join(dir, "route-manifest.json");
      await mkdir(path.join(routesDir, "users"), { recursive: true });
      await writeFile(path.join(routesDir, "index.tachyon.html"), `<main>Home</main>`);
      await writeFile(path.join(routesDir, "users", "[id].tachyon.html"), `<main>User</main>`);

      const result = await buildRouteManifestFile({ routesDir, output });

      expect(result.ok).toBe(true);
      expect(JSON.parse(await readFile(output, "utf8"))).toEqual([
        { id: "index", path: "/", file: path.join(routesDir, "index.tachyon.html"), kind: "template" },
        {
          id: "users-id",
          path: "/users/:id",
          file: path.join(routesDir, "users", "[id].tachyon.html"),
          kind: "template",
        },
      ]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("transforms tachyon html files through the Vite plugin", async () => {
    const plugin = tachyonDom({ reactive: true });
    if (typeof plugin.transform !== "function") {
      throw new Error("Missing transform hook.");
    }

    const result = await plugin.transform.call(
      {
        error(error: string): never {
          throw new Error(error);
        },
      } as never,
      `<button>{label}</button>`,
      "/src/button.tachyon.html",
    );

    expect(result).toMatchObject({
      map: null,
    });
    expect(typeof result === "object" && result?.code).toContain(`from "tachyon-dom/runtime/signal"`);
    expect(typeof result === "object" && result?.code).toContain(`sourceMappingURL=data:application/json;base64`);
  });

  it("can disable production source maps and expose artifacts for upload hooks", async () => {
    const uploaded: string[] = [];
    const plugin = tachyonDom({
      productionSourceMap: false,
      onSourceMap: ({ id }) => {
        uploaded.push(id);
      },
    });
    if (typeof plugin.configResolved === "function") {
      await plugin.configResolved.call({} as never, { command: "build", mode: "production" } as never);
    } else if (plugin.configResolved) {
      await plugin.configResolved.handler.call({} as never, { command: "build", mode: "production" } as never);
    }
    if (typeof plugin.transform !== "function") {
      throw new Error("Missing transform hook.");
    }

    const result = await plugin.transform.call(
      {
        error(error: string): never {
          throw new Error(error);
        },
      } as never,
      `<button>{label}</button>`,
      "/src/button.tachyon.html",
    );

    expect(typeof result === "object" && result?.code).not.toContain("sourceMappingURL");
    expect(uploaded).toEqual(["/src/button.tachyon.html"]);
    expect(
      shouldEmitSourceMap({ sourcemap: true, productionSourceMap: false, command: "build", mode: "production" }),
    ).toBe(false);
  });

  it("generates a virtual route manifest with lazy route modules", async () => {
    const plugin = tachyonDomRoutes({
      routes: [
        { id: "home", path: "/", module: "/src/routes/index.tachyon.html" },
        { id: "user", path: "/users/:id", module: "/src/routes/users/[id].tachyon.html" },
      ],
      files: ["/src/routes/about.tachyon.html"],
      rootDir: "/src/routes",
    });
    if (typeof plugin.resolveId !== "function" || typeof plugin.load !== "function") {
      throw new Error("Missing virtual module hooks.");
    }

    const resolved = await plugin.resolveId.call({} as never, "virtual:tachyon-dom/routes", undefined, {} as never);
    const code = await plugin.load.call({} as never, resolved as string, {} as never);

    expect(resolved).toBe("\0virtual:tachyon-dom/routes");
    expect(code).toContain(`export const manifest = routes.map`);
    expect(code).toContain(`module: () => import("/src/routes/users/[id].tachyon.html")`);
    expect(code).toContain(`path: "/about"`);
  });

  it("sends route HMR updates for changed route modules", () => {
    const plugin = tachyonDomRoutes({
      routes: [{ id: "home", path: "/", module: "/src/routes/index.tachyon.html" }],
    });
    if (typeof plugin.handleHotUpdate !== "function") {
      throw new Error("Missing HMR hook.");
    }
    const module = { id: "\0virtual:tachyon-dom/routes" };
    const sent: unknown[] = [];

    const result = plugin.handleHotUpdate.call(
      {} as never,
      {
        file: "/src/routes/index.tachyon.html",
        modules: [{ id: "/src/routes/index.tachyon.html" }],
        server: {
          ws: {
            send: (payload: unknown) => sent.push(payload),
          },
          moduleGraph: {
            getModuleById: () => module,
            invalidateModule: (invalidated: unknown) => sent.push({ invalidated }),
          },
        },
      } as never,
    );

    expect(result).toEqual([module, { id: "/src/routes/index.tachyon.html" }]);
    expect(sent).toContainEqual({
      type: "custom",
      event: "tachyon-dom:routes-update",
      data: { routeIds: ["home"] },
    });
  });
});
