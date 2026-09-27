import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import ts from "typescript";
import { describe, expect, it } from "vitest";
import { generateTachyonModuleTypes } from "../src/app";
import { compileFile } from "../src/cli";
import { tachyonDom } from "../src/vite";

describe("named .td component export", () => {
  const source = `<script setup lang="ts">
type Props = { label: string };
const title = "Card";
</script>
<article>{title}: {label}</article>`;

  it("emits a typed named component without changing the setup scope contract", () => {
    const types = generateTachyonModuleTypes(source);
    expect(types.ok).toBe(true);
    if (!types.ok) throw new Error(types.error);
    expect(types.value).toContain("type Props = {");
    expect(types.value).toContain("export declare const component:");
    expect(types.value).toContain("__TachyonComponent<Props");
    expect(types.value).toContain("export declare const bind:");
  });

  it("emits a client component and matching server and stream renderers", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "tachyon-component-export-"));
    try {
      const input = path.join(dir, "Card.td");
      await writeFile(input, source);
      const client = await compileFile({ input, target: "client", reactive: true, sourcemap: false });
      const server = await compileFile({ input, target: "server", reactive: false, sourcemap: false });
      const stream = await compileFile({ input, target: "stream", reactive: false, sourcemap: false });
      expect(client.ok).toBe(true);
      expect(server.ok).toBe(true);
      expect(stream.ok).toBe(true);
      if (!client.ok || !server.ok || !stream.ok) return;
      expect(client.value).toContain("createTemplateComponent as __tachyonCreateTemplateComponent");
      expect(client.value).toContain("export const component = /* @__PURE__ */ __tachyonCreateTemplateComponent(");
      expect(client.value).toContain("const __tachyonSfcSetupScope =");
      expect(server.value).toContain("export const component = { render };");
      expect(stream.value).toContain("export const component = { stream };");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("checks required, extra, and wrongly typed props through adjacent module declarations", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "tachyon-component-props-"));
    try {
      const types = generateTachyonModuleTypes(source);
      expect(types.ok).toBe(true);
      if (!types.ok) return;
      await writeFile(path.join(dir, "Card.td.d.ts"), types.value);
      const app = path.join(dir, "app.ts");
      await writeFile(
        app,
        `import { component as Card } from "./Card.td";
const root = document.createElement("div");
Card.mount(root, { label: "ok" });
Card.mount(root, {});
Card.mount(root, { label: 1 });
Card.mount(root, { label: "ok", extra: true });`,
      );
      const program = ts.createProgram([app], {
        strict: true,
        noEmit: true,
        target: ts.ScriptTarget.ES2022,
        module: ts.ModuleKind.ESNext,
        moduleResolution: ts.ModuleResolutionKind.Bundler,
        lib: ["lib.es2022.d.ts", "lib.dom.d.ts"],
      });
      const messages = ts
        .getPreEmitDiagnostics(program)
        .map((diagnostic) => ts.flattenDiagnosticMessageText(diagnostic.messageText, " "));
      expect(messages).toHaveLength(3);
      expect(messages.some((message) => message.includes("label") && message.includes("missing"))).toBe(true);
      expect(messages.some((message) => message.includes("number") && message.includes("string"))).toBe(true);
      expect(messages.some((message) => message.includes("extra"))).toBe(true);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("uses the required template scope when a Props type is absent", () => {
    const types = generateTachyonModuleTypes("<article>{label}</article>");
    expect(types.ok).toBe(true);
    if (!types.ok) throw new Error(types.error);
    expect(types.value).toContain("__TachyonComponent<TemplateScope");
  });

  it("recognizes an interface Props but ignores unrelated type declarations", () => {
    const withInterface = generateTachyonModuleTypes(
      `<script setup lang="ts">interface Props { label: string }</script><p>{label}</p>`,
    );
    const withOtherType = generateTachyonModuleTypes(
      `<script setup lang="ts">type Other = { label: string }</script><p>{label}</p>`,
    );
    expect(withInterface.ok && withOtherType.ok).toBe(true);
    if (!withInterface.ok || !withOtherType.ok) return;
    expect(withInterface.value).toContain("__TachyonComponent<Props");
    expect(withOtherType.value).toContain("__TachyonComponent<TemplateScope");
  });

  it("does not declare a component for a script-only module", () => {
    const types = generateTachyonModuleTypes('<script setup lang="ts">const value = 1;</script>');
    expect(types.ok).toBe(true);
    if (types.ok) expect(types.value).not.toContain("export declare const component:");
  });

  it("does not emit a component from a script-only CLI module", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "tachyon-component-script-only-"));
    try {
      const input = path.join(dir, "Only.td");
      await writeFile(input, '<script setup lang="ts">const value = 1;</script>');
      const result = await compileFile({ input, target: "client", reactive: false, sourcemap: false });
      expect(result.ok).toBe(true);
      if (result.ok) expect(result.value).not.toContain("export const component =");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("exports the component from normal Vite targets while keeping reduced client targets small", async () => {
    const plugin = tachyonDom({ reactive: true, declarationOutput: false });
    const transform = plugin.transform;
    if (typeof transform !== "function") throw new Error("Missing transform hook.");
    const context = {
      error(message: string): never {
        throw new Error(message);
      },
    } as never;
    const code = async (id: string): Promise<string> => {
      const result = await transform.call(context, source, id);
      return typeof result === "object" && result !== null && "code" in result ? String(result.code) : "";
    };
    expect(await code("/src/Card.td?client")).toContain(
      "export const component = /* @__PURE__ */ __tachyonCreateTemplateComponent(",
    );
    expect(await code("/src/Card.td?server")).toContain("export const component = { render };");
    expect(await code("/src/Card.td?stream")).toContain("export const component = { stream };");
    expect(await code("/src/Card.td?client&hydrate-only")).not.toContain("export const component =");
    expect(await code("/src/Card.td?client&mount-only")).not.toContain("export const component =");
    const scriptOnly = await transform.call(
      context,
      '<script setup lang="ts">const value = 1;</script>',
      "/src/Only.td?client",
    );
    expect(String(scriptOnly && typeof scriptOnly === "object" ? scriptOnly.code : scriptOnly)).not.toContain(
      "export const component =",
    );
    const lazySource = `<main><section hydrate:interaction="click"><button>{label}</button></section></main>`;
    const lazyEntry = await transform.call(context, lazySource, "/src/Lazy.td?client");
    const lazyChunk = await transform.call(context, lazySource, "/src/Lazy.td?client&tachyon-hydration=td-h-0");
    expect(String(lazyEntry && typeof lazyEntry === "object" ? lazyEntry.code : lazyEntry)).toContain(
      "bind, hydrate, hydrationChunks",
    );
    expect(String(lazyChunk && typeof lazyChunk === "object" ? lazyChunk.code : lazyChunk)).not.toContain(
      "export const component =",
    );
  });

  it("preserves an explicit component export from an ordinary script", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "tachyon-existing-component-"));
    try {
      const input = path.join(dir, "Existing.td");
      const script = `<script lang="ts">export const component = { mount: () => "custom" };</script><p>Static</p>`;
      await writeFile(input, script);
      const result = await compileFile({ input, target: "client", reactive: false, sourcemap: false });
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value.match(/export const component\s*=/g)).toHaveLength(1);
      expect(result.value).not.toContain("__tachyonCreateTemplateComponent");
      const types = generateTachyonModuleTypes(script);
      expect(types.ok).toBe(true);
      if (types.ok) expect(types.value.match(/export declare const component\s*:/g)).toHaveLength(1);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("generates a component for an ordinary script without a custom component binding", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "tachyon-ordinary-component-"));
    try {
      const input = path.join(dir, "Ordinary.td");
      const script = `<script lang="ts">export const title = "Ordinary";</script><p>{title}</p>`;
      await writeFile(input, script);
      const result = await compileFile({ input, target: "client", reactive: false, sourcemap: false });
      expect(result.ok).toBe(true);
      if (result.ok) expect(result.value).toContain("export const component = /* @__PURE__ */");
      const types = generateTachyonModuleTypes(script);
      expect(types.ok).toBe(true);
      if (types.ok) expect(types.value).toContain("export declare const component:");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("preserves a re-exported component from an ordinary script", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "tachyon-reexported-component-"));
    try {
      const input = path.join(dir, "Reexport.td");
      const script = `<script lang="ts">export { component } from "./other.js";</script><p>Static</p>`;
      await writeFile(input, script);
      const result = await compileFile({ input, target: "client", reactive: false, sourcemap: false });
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value).toContain('export { component } from "./other.js";');
        expect(result.value).not.toContain("__tachyonCreateTemplateComponent");
      }
      const types = generateTachyonModuleTypes(script);
      expect(types.ok).toBe(true);
      if (types.ok) expect(types.value).not.toContain("export declare const component:");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("mounts independent generated instances, retains local state on prop updates, and hydrates SSR DOM", async () => {
    await mkdir(path.join(process.cwd(), ".codex"), { recursive: true });
    const dir = await mkdtemp(path.join(process.cwd(), ".codex", "component-export-"));
    try {
      const input = path.join(dir, "Counter.td");
      const clientOutput = path.join(dir, "client.mjs");
      const serverOutput = path.join(dir, "server.mjs");
      await writeFile(
        input,
        `<script setup lang="ts">
import { createSignal } from "tachyon-dom/runtime/signal";
type Props = { label: string };
const clicks = createSignal(0);
const increment = () => clicks.update((value) => value + 1);
</script>
<button on:click={increment}>{label}: {clicks}</button>`,
      );
      const client = await compileFile({
        input,
        output: clientOutput,
        target: "client",
        reactive: true,
        sourcemap: false,
      });
      const server = await compileFile({
        input,
        output: serverOutput,
        target: "server",
        reactive: false,
        sourcemap: false,
      });
      expect(client.ok && server.ok).toBe(true);
      if (!client.ok || !server.ok) return;
      const clientModule = (await import(pathToFileURL(clientOutput).href)) as {
        component: {
          mount: (
            root: Element,
            props: { label: string },
          ) => { update: (props: { label: string }) => void; dispose: () => void };
          hydrate: (
            root: Element,
            props: { label: string },
          ) => { ok: boolean; value?: { dispose: () => void }; error?: { message: string } };
        };
      };
      const serverModule = (await import(pathToFileURL(serverOutput).href)) as {
        component: { render: (props: { label: string }) => string };
      };
      const left = document.createElement("div");
      const right = document.createElement("div");
      const first = clientModule.component.mount(left, { label: "first" });
      const second = clientModule.component.mount(right, { label: "second" });
      left.querySelector("button")?.click();
      first.update({ label: "updated" });
      expect(left.textContent).toBe("updated: 1");
      expect(right.textContent).toBe("second: 0");
      first.dispose();
      second.dispose();

      const hydrated = document.createElement("div");
      hydrated.innerHTML = serverModule.component.render({ label: "server" });
      const before = hydrated.firstElementChild;
      const result = clientModule.component.hydrate(hydrated, { label: "server" });
      expect(result.ok, result.error?.message).toBe(true);
      expect(hydrated.firstElementChild).toBe(before);
      hydrated.querySelector("button")?.click();
      expect(hydrated.textContent).toBe("server: 1");
      result.value?.dispose();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
