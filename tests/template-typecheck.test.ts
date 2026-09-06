import { describe, expect, it } from "vitest";
import { checkTachyonTemplateTypes, formatTemplateTypeDiagnostic } from "../src/template-typecheck";

describe("Tachyon template TypeScript checker", () => {
  it("accepts typed script scope, for aliases, event handlers, and model bindings", () => {
    const source = `<script lang="ts">
export const scope = () => ({
  rows: [{ id: 1, label: "Ada" }],
  title: "Users",
  save: (_event: Event) => undefined,
  value: "",
});
</script>
<main>
  <h1>{title}</h1>
  <for each={rows} as="row" index="index" key={row.id}>
    <button on:click={save}>{index}: {row.label}</button>
  </for>
  <input bind:value={value}>
</main>`;

    const result = checkTachyonTemplateTypes(source, { fileName: "/tmp/users.td" });

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(result.error);
    expect(result.value).toEqual([]);
  });

  it("reports shared TypeScript diagnostics at the original template expressions", () => {
    const source = `<script lang="ts">
export const scope = () => ({
  user: { name: "Ada" },
  save: 123,
  value: "",
});
</script>
<main>
  <p>{user.missing}</p>
  <button on:click={save}>Save</button>
  <input bind:value={value.missing}>
</main>`;

    const result = checkTachyonTemplateTypes(source, { fileName: "/tmp/users.td" });

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(result.error);
    expect(result.value).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: 2339, message: expect.stringContaining("missing") }),
        expect.objectContaining({ code: 2322, message: expect.stringContaining("Event") }),
      ]),
    );
    const missing = result.value.find((diagnostic) => diagnostic.code === 2339);
    expect(missing?.offset).toBe(source.indexOf("user.missing"));
    expect(formatTemplateTypeDiagnostic(missing!, "/tmp/users.td")).toContain("/tmp/users.td:9:7:");
  });

  it("checks script setup bindings and maps Unicode SFC offsets", () => {
    const source = `<script setup lang="ts">
const title = "日本語";
</script>
<main><h1>{title}</h1><p>{missing}</p></main>`;

    const result = checkTachyonTemplateTypes(source, { fileName: "/tmp/setup.td" });

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(result.error);
    expect(result.value).toEqual(
      expect.arrayContaining([expect.objectContaining({ code: 2339, message: expect.stringContaining("missing") })]),
    );
    const diagnostic = result.value.find((item) => item.message.includes("missing"));
    expect(diagnostic?.offset).toBe(source.indexOf("missing"));
    expect(diagnostic?.line).toBe(4);
    expect(diagnostic?.column).toBe(27);
  });

  it("does not invent scope diagnostics for a template without a type source", () => {
    const result = checkTachyonTemplateTypes("<main>{title}</main>");

    expect(result).toEqual({ ok: true, value: [] });
  });

  it("derives DOM event types for known events and keeps unknown events flexible", () => {
    const source = `<script setup lang="ts">
const save = (event: MouseEvent) => event.clientX;
const onKey = (event: KeyboardEvent) => event.key;
const onCustom = (event: CustomEvent<string>) => event.detail;
const onAny = (event: Event) => event.type;
</script>
<main>
  <button on:click={save}>Save</button>
  <button on:click={onAny}>Any</button>
  <input on:keydown={onKey}>
  <div on:my-custom={onCustom}></div>
  <button on:click={onKey}>Wrong</button>
</main>`;

    const result = checkTachyonTemplateTypes(source, { fileName: "/tmp/events.td" });

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(result.error);
    expect(result.value.map((diagnostic) => [diagnostic.code, source.slice(diagnostic.offset, diagnostic.endOffset)])).toEqual([
      [2322, "onKey"],
    ]);
    expect(result.value[0]?.message).toContain("KeyboardEvent");
  });

  it("rejects model bindings to readonly signal accessors and accepts writable signals", () => {
    const source = `<script setup lang="ts">
import { createMemo, createSignal } from "../src/runtime/signal";
const readonlyName = createMemo(() => "Alice");
const writableName = createSignal("Alice");
const plainName = "Alice";
</script>
<main>
  <input bind:value={writableName}>
  <input bind:value={plainName}>
  <input bind:value={readonlyName}>
</main>`;

    const result = checkTachyonTemplateTypes(source, { fileName: `${process.cwd()}/tests/virtual-model.td` });

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(result.error);
    expect(result.value.map((diagnostic) => source.slice(diagnostic.offset, diagnostic.endOffset))).toEqual(["readonlyName"]);
    expect(result.value[0]?.message).toMatch(/readonly/i);
  });
});
