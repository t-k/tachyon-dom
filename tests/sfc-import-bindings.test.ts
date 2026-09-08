import { expect, it } from "vitest";
import { templateScopeIdentifiers, transformSfcScript } from "../src/compiler/sfc";
import { compileTachyonSfc, sfcSetupScopeName } from "../src/compiler/sfc";
import { expressionToJs } from "../src/compiler/expression";

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
const format = (value) => String(value);
import { createSignal } from "tachyon-dom";
const state = createSignal(0);
const count = () => state();
const step = 2;
const increment = () => state.set(count() + step);
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
    "state",
    "step",
    "title",
  ]);
  expect(transformed.value.exposedBindings).toEqual(["count", "format", "increment", "rows", "title"]);
  expect(transformed.value.code).toContain(
    "return { count: count, format: format, increment: increment, rows: rows, title: title };",
  );
  expect(transformed.value.code).toContain("step: step");
  expect(transformed.value.code).toContain("internalCache: internalCache");
  expect(transformed.value.code).toContain("createSignal: createSignal");
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

it("collects expression identifiers without retaining static markup or literal strings", () => {
  const identifiers = templateScopeIdentifiers(
    `<section hydrate:id={panelId}><input bind:value={draft.text} style:color={active ? "red" : \`\${tone}\`}><p>{t("greeting")}</p></section>`,
  );
  for (const name of ["panelId", "draft", "active", "tone", "t"]) {
    expect(identifiers?.has(name)).toBe(true);
  }
  for (const name of ["missing", "section", "hydrate", "red"]) expect(identifiers?.has(name)).toBe(false);
});

it.each([undefined, { attrs: "setup", offset: 0, content: "  \n\t" }])(
  "returns no code and no bindings for an empty setup script (%o)",
  (script) => {
    const transformed = transformSfcScript(script, { templateIdentifiers: new Set(["x"]) });
    expect(transformed.ok).toBe(true);
    if (!transformed.ok) throw new Error(transformed.error.message);
    expect(transformed.value).toEqual({ code: "", setupBindings: [], exposedBindings: [], scopeEmission: "full" });
  },
);

it("collects no identifiers from a template without identifier tokens", () => {
  expect(templateScopeIdentifiers("")?.size).toBe(0);
  expect(templateScopeIdentifiers("<p>1 + 2 ...</p>")?.size).toBe(0);
});

it.each([
  ['const secret = "READY"; function label() { return this.secret; }', "label()", "READY"],
  ['const secret = "READY"; const key = "secret"; function label() { return this[key]; }', "label()", "READY"],
  [
    'const secret = "READY"; function label() { return Object.keys(this).sort().join(","); }',
    "label()",
    "label,secret",
  ],
  ["const 件数 = 7;", "件数", 7],
  ["const count = 7;", String.raw`\u0063ount`, 7],
  ["const count = 7;", String.raw`\u{63}ount`, 7],
])("preserves generated SFC expression behavior: %s", (content, expression, expected) => {
  const compiled = compileTachyonSfc(`<script setup>${content}</script><p>{${expression}}</p>`);
  expect(compiled.ok).toBe(true);
  if (!compiled.ok) throw new Error(compiled.error.message);
  const script = compiled.value.descriptor.script;
  const full = transformSfcScript(script);
  const narrowed = transformSfcScript(script, {
    templateIdentifiers: templateScopeIdentifiers(compiled.value.descriptor.template),
  });
  if (!full.ok || !narrowed.ok) throw new Error("SFC transformation failed");
  const run = (code: string) => {
    const scope = new Function(code.replace(/export \{[^}]*\};?/g, "") + `; return ${sfcSetupScopeName}();`)();
    return new Function("scope", `return ${expressionToJs(expression)};`)(scope);
  };
  expect(run(full.value.code)).toBe(expected);
  expect(run(narrowed.value.code)).toBe(expected);
});

it("retains the implicit server outlet reference", () => {
  expect(templateScopeIdentifiers("<main><outlet/></main>")?.has("outlet")).toBe(true);
});

it("falls back when a repeated variable declaration replaces a known function", () => {
  const result = transformSfcScript(
    {
      attrs: "setup",
      offset: 0,
      content: 'var label = () => "OLD"; var label = Function("return this.secret"); const secret = "READY";',
    },
    { templateIdentifiers: new Set(["label"]) },
  );
  if (!result.ok) throw new Error(result.error.message);
  expect(result.value.exposedBindings).toEqual(["label", "secret"]);
});

it.each([
  'import { label } from "./shared"; const secret = "READY";',
  'const label = Function("return this.secret"); const secret = "READY";',
  'const label = globalThis.external; const secret = "READY";',
  'const label = () => eval("this.secret"); const secret = "READY";',
  'let label = () => "OLD"; label = external; const secret = "READY";',
  'const label = () => "OLD"; label.read = external; const secret = "READY";',
])("keeps opaque or dynamically replaced callable scopes intact: %s", (content) => {
  const result = transformSfcScript(
    { attrs: "setup", offset: 0, content },
    { templateIdentifiers: new Set(["label"]) },
  );
  if (!result.ok) throw new Error(result.error.message);
  expect(result.value.exposedBindings).toEqual(result.value.setupBindings);
});

it.each([
  'var label = Function("return this.secret"); function label() { return "OLD"; } const secret = "READY";',
  'function label() { return "OLD"; } if (true) { var label = Function("return this.secret"); } const secret = "READY";',
])("keeps scopes intact across hoisted or block-scoped var replacements: %s", (content) => {
  const result = transformSfcScript(
    { attrs: "setup", offset: 0, content },
    { templateIdentifiers: new Set(["label"]) },
  );
  if (!result.ok) throw new Error(result.error.message);
  expect(result.value.exposedBindings).toContain("secret");
});

it.each([
  ['function label() { return "READY"; } const secret = "READY";', ["label"]],
  ['const shown = false; const nothing = null; const secret = "READY";', ["nothing", "shown"]],
  ['const label = () => 1 + 2 > 1 && secret !== ""; const secret = "READY";', ["label"]],
])("narrows scripts whose exposed values are known declarations: %s", (content, exposed) => {
  const result = transformSfcScript({ attrs: "setup", offset: 0, content }, { templateIdentifiers: new Set(exposed) });
  if (!result.ok) throw new Error(result.error.message);
  expect(result.value.exposedBindings).toEqual(exposed);
});

it("retains the implicit server slots reference", () => {
  expect(templateScopeIdentifiers('<main><slot/><slot name="named"/></main>')?.has("slots")).toBe(true);
});

it.each([
  ["[first, second]", ["first", "second"]],
  ["({value: first})", ["first"]],
  ["!enabled", ["enabled"]],
  ["left + right", ["left", "right"]],
  ["test ? yes : no", ["test", "yes", "no"]],
  ["fn(argument)", ["fn", "argument"]],
  ["object[key]", ["object", "key"]],
  ["`prefix ${value} suffix`", ["value"]],
] as const)("collects every operand in %s", (expression, names) => {
  expect(templateScopeIdentifiers(`<p>{${expression}}</p>`)).toEqual(new Set(names));
});

it("collects component, store, list, and awaited references conservatively", () => {
  const names = templateScopeIdentifiers(
    '<main><component name="Card" title={heading}/><store data={initial}/><for each={rows} key={row.id}><p>{row.name}:{suffix}</p></for><await value={promise}><p>{resolved}</p></await></main>',
  );
  for (const name of ["Card", "heading", "initial", "rows", "row", "suffix", "promise", "resolved"])
    expect(names?.has(name)).toBe(true);
});

it.each(["<p>{a +}</p>", "<p"])("disables narrowing when parsing fails: %s", (source) => {
  expect(templateScopeIdentifiers(source)).toBeUndefined();
});
