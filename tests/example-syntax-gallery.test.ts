import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { generateServerStreamModule } from "../src/compiler";
import { compileTachyonSfc } from "../src/compiler/sfc";

describe("syntax gallery example", () => {
  it("uses every documented template syntax family in one compileable example", async () => {
    const file = join(process.cwd(), "examples", "syntax-gallery.td");

    expect(existsSync(file)).toBe(true);
    const source = readFileSync(file, "utf8");
    for (const token of [
      "<script",
      "<store",
      "<component",
      "<slot",
      "<if",
      "<for",
      "<await",
      "hydrate:idle",
      "hydrate:visible",
      "on:click",
      "bind:value",
      "bind:checked",
      "class:selected",
      "style:width",
      "ref={",
      "fallback=",
      "error=",
      "reorder=",
    ]) {
      expect(source).toContain(token);
    }

    const compiled = compileTachyonSfc(source);
    expect(compiled.ok).toBe(true);
    if (!compiled.ok) {
      throw new Error(compiled.error.message);
    }
    expect(compiled.value.template.client.hydrationBoundaries).toContainEqual({
      path: [],
      id: "td-h-root",
      idKind: "static",
      strategy: "idle",
    });
    const visibleBoundary = compiled.value.template.client.hydrationBoundaries.find(
      (boundary) => boundary.strategy === "visible",
    );
    expect(visibleBoundary).toMatchObject({
      idKind: "static",
      strategy: "visible",
      rootMargin: "80px",
    });

    const code = generateServerStreamModule(compiled.value.template);
    const module = (await import(`data:text/javascript;base64,${Buffer.from(code).toString("base64")}`)) as {
      stream: (scope: Record<string, unknown>) => AsyncIterable<string>;
    };
    const chunks: string[] = [];
    for await (const chunk of module.stream({
      active: true,
      count: 1,
      form: { enabled: true, name: "Ada" },
      initialCount: 1,
      messagePromise: Promise.resolve("Stream ready"),
      panelWidth: "64%",
      refs: {},
      rows: [{ id: 1, label: "Hydration shorthand" }],
      selectedId: 1,
      slots: { header: "<h2>Projected header</h2>" },
      title: "Syntax Gallery",
    })) {
      chunks.push(chunk);
    }
    const html = chunks.join("");
    expect(html).toContain(`<!--tachyon-hydrate:td-h-root:start-->`);
    expect(html).toContain(`<!--tachyon-hydrate:${visibleBoundary?.id}:start-->`);
    expect(html).toContain("Projected header");
    expect(html).toContain("Stream ready");
  });
});
