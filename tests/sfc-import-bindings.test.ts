import { expect, it } from "vitest";
import { templateScopeIdentifiers, transformSfcScript } from "../src/compiler/sfc";

it("exposes runtime setup imports while excluding TypeScript-only imports", () => {
  const transformed = transformSfcScript({
    attrs: 'setup lang="ts"',
    offset: 0,
    content: `
import primary from "./shared";
import * as namespace from "./shared";
import { shared as renamed, type Row } from "./shared";
import type { TypeOnly } from "./types";
import "./side-effect";
const local = 1;
`,
  });
  expect(transformed.ok).toBe(true);
  if (!transformed.ok) throw new Error(transformed.error.message);
  expect(transformed.value.setupBindings).toEqual(["local", "namespace", "primary", "renamed"]);
  expect(transformed.value.code).toContain(
    "return { local: local, namespace: namespace, primary: primary, renamed: renamed }",
  );
  expect(transformed.value.code).not.toContain("Row: Row");
  expect(transformed.value.code).not.toContain("TypeOnly: TypeOnly");
});

it("collects setup functions and classes while excluding type declarations", () => {
  const result = transformSfcScript({
    attrs: 'setup lang="ts"',
    offset: 0,
    content: "function helper() {} class Model {} ; interface Shape {}",
  });
  expect(result.ok).toBe(true);
  if (!result.ok) throw new Error(result.error.message);
  expect(result.value.setupBindings).toEqual(["Model", "helper"]);
});

it.each(["function() {}", "class {}"])("reports anonymous default %s as a setup export error", (declaration) => {
  const result = transformSfcScript({ attrs: 'setup lang="ts"', offset: 0, content: `export default ${declaration}` });
  expect(result.ok).toBe(false);
  if (result.ok) throw new Error("Expected a setup export error");
  expect(result.error.message).toMatch(/export/i);
});

it("exposes only the setup bindings the template can reference when template identifiers are given", () => {
  const template = `<main><h1 class="helper">{title}</h1><button on:click={increment}>{count()}</button><if test={rows.length > 0}><p>{format(rows[0])}</p></if></main>`;
  const transformed = transformSfcScript(
    {
      attrs: 'setup lang="ts"',
      offset: 0,
      content: `
import { format } from "./format";
import { createSignal } from "tachyon-dom";
const count = createSignal(0);
const step = 2;
const increment = () => count.set(count() + step);
const title = "Counter";
const rows = [1];
const internalCache = new Map();
`,
    },
    { templateIdentifiers: templateScopeIdentifiers(template) },
  );
  expect(transformed.ok).toBe(true);
  if (!transformed.ok) throw new Error(transformed.error.message);
  // Every declaration stays a setup binding; only the names the template text can reach are returned.
  expect(transformed.value.setupBindings).toEqual([
    "count",
    "createSignal",
    "format",
    "increment",
    "internalCache",
    "rows",
    "step",
    "title",
  ]);
  expect(transformed.value.exposedBindings).toEqual(["count", "format", "increment", "rows", "title"]);
  expect(transformed.value.code).toContain(
    "return { count: count, format: format, increment: increment, rows: rows, title: title };",
  );
  expect(transformed.value.code).not.toContain("step: step");
  expect(transformed.value.code).not.toContain("internalCache: internalCache");
  expect(transformed.value.code).not.toContain("createSignal: createSignal");
  // The setup body itself is untouched: narrowing changes what the scope exposes, not what setup runs.
  expect(transformed.value.code).toContain("const step = 2;");
  expect(transformed.value.code).toContain("const internalCache = new Map();");
});

it("keeps every setup binding exposed when no template identifiers are known", () => {
  const transformed = transformSfcScript({ attrs: "setup", offset: 0, content: "const a = 1; const b = 2;" });
  expect(transformed.ok).toBe(true);
  if (!transformed.ok) throw new Error(transformed.error.message);
  expect(transformed.value.exposedBindings).toEqual(["a", "b"]);
  expect(transformed.value.code).toContain("return { a: a, b: b };");
});

it("collects template identifiers from expressions, attributes, and text alike", () => {
  const identifiers = templateScopeIdentifiers(
    `<section hydrate:id={panelId}><input bind:value={draft.text} style:color={active ? "red" : \`\${tone}\`}><p>{t("greeting")}</p></section>`,
  );
  for (const name of ["panelId", "draft", "active", "tone", "t", "section", "hydrate", "red"]) {
    expect(identifiers.has(name)).toBe(true);
  }
  expect(identifiers.has("missing")).toBe(false);
});

it.each([undefined, { attrs: "setup", offset: 0, content: "  \n\t" }])(
  "returns no code and no bindings for an empty setup script (%o)",
  (script) => {
    const transformed = transformSfcScript(script, { templateIdentifiers: new Set(["x"]) });
    expect(transformed.ok).toBe(true);
    if (!transformed.ok) throw new Error(transformed.error.message);
    expect(transformed.value).toEqual({ code: "", setupBindings: [], exposedBindings: [] });
  },
);

it("collects no identifiers from a template without identifier tokens", () => {
  expect(templateScopeIdentifiers("").size).toBe(0);
  expect(templateScopeIdentifiers("1 + 2 <> ...").size).toBe(0);
});
