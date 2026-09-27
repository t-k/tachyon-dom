// @vitest-environment node
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { brotliCompressSync } from "node:zlib";
import { build } from "esbuild";
import { expect, it } from "vitest";
import { compileFile } from "../src/cli";

it("removes the component runtime when the named .td export is unused", async () => {
  const dir = await mkdtemp(path.join(process.cwd(), ".codex", "component-size-test-"));
  try {
    const input = path.join(dir, "Card.td");
    await writeFile(input, `<script setup lang="ts">const label = "Card";</script><p>{label}</p>`);
    const compiled = await compileFile({ input, target: "client", reactive: true, sourcemap: false });
    expect(compiled.ok).toBe(true);
    if (!compiled.ok) return;
    const exportStart = compiled.value.indexOf("import { createTemplateComponent as __tachyonCreateTemplateComponent }");
    expect(exportStart).toBeGreaterThan(0);
    const module = path.join(dir, "generated.mjs");
    const entry = path.join(dir, "entry.mjs");
    await writeFile(entry, `export { bind, templateHtml } from ${JSON.stringify(module)};`);
    const bundles: Uint8Array[] = [];
    for (const code of [compiled.value, compiled.value.slice(0, exportStart)]) {
      await writeFile(module, code);
      const bundle = await build({
        entryPoints: [entry],
        bundle: true,
        write: false,
        minify: true,
        format: "esm",
        platform: "browser",
        target: "es2022",
      });
      bundles.push(bundle.outputFiles[0]!.contents);
    }
    expect(bundles[0]!.length).toBe(bundles[1]!.length);
    expect(brotliCompressSync(bundles[0]!).length - brotliCompressSync(bundles[1]!).length).toBeLessThanOrEqual(16);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
