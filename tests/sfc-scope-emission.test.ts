import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect, it } from "vitest";
import { compileFile } from "../src/cli";
import { createSignal } from "../src/index";
import {
  sfcScriptTransformCacheLimit,
  sfcSetupScopeName,
  templateScopeIdentifiers,
  transformSfcScript,
} from "../src/compiler/sfc";
import { tachyonDom } from "../src/vite";

// The generated entry always supplies an input scope, so the factory it calls
// must return every setup binding. Only the standalone factory keeps both paths.
const source = `<script setup>
const secret = "READY";
const label = () => secret;
</script>
<p>{label()}</p>`;
const fullReturn = "return { label: label, secret: secret };";
const narrowReturn = "return { label: label };";

it("reports full emission unless template identifiers narrow the factory", () => {
  const script = { attrs: "setup", offset: 0, content: 'const secret = "READY"; const label = () => secret;' };
  const full = transformSfcScript(script);
  const dual = transformSfcScript(script, { templateIdentifiers: templateScopeIdentifiers("<p>{label()}</p>") });
  const unnarrowable = transformSfcScript(script, { templateIdentifiers: new Set(["secret", "label"]) });
  if (!full.ok || !dual.ok || !unnarrowable.ok) throw new Error("Expected transformed scripts");
  expect(full.value.scopeEmission).toBe("full");
  expect(full.value.code).toContain(`${sfcSetupScopeName} = (inputScope = {}) =>`);
  expect(full.value.code).not.toContain("inputScope !== undefined");
  expect(dual.value.scopeEmission).toBe("dual");
  expect(dual.value.code).toContain(`${sfcSetupScopeName} = (inputScope) =>`);
  expect(dual.value.code).toContain(`if (inputScope !== undefined) ${fullReturn}`);
  expect(dual.value.code).toContain(narrowReturn);
  expect(unnarrowable.value.scopeEmission).toBe("full");
});

it("emits only the full scope from the CLI compiler", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "tachyon-dom-sfc-emission-"));
  try {
    const input = path.join(dir, "panel.td");
    const output = path.join(dir, "panel.js");
    await writeFile(input, source);
    const result = await compileFile({ input, output, target: "client", reactive: true, sourcemap: false });
    expect(result.ok).toBe(true);
    const code = await readFile(output, "utf8");
    expect(code).toContain(`${sfcSetupScopeName} = (inputScope = {}) =>`);
    expect(code).toContain(fullReturn);
    expect(code).not.toContain("inputScope !== undefined");
    expect(code).not.toContain(narrowReturn);
    expect(code).toContain("__tachyonCreateScope = (inputScope = {}) =>");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

it("emits only the full scope from the Vite plugin", async () => {
  const plugin = tachyonDom({ reactive: true });
  if (typeof plugin.transform !== "function") throw new Error("Missing transform hook.");
  const result = await plugin.transform.call(
    {
      error(error: string): never {
        throw new Error(error);
      },
    } as never,
    source,
    "/src/panel.td",
  );
  const code = typeof result === "object" && result ? result.code : "";
  expect(code).toContain(`${sfcSetupScopeName} = (inputScope = {}) =>`);
  expect(code).toContain(fullReturn);
  expect(code).not.toContain("inputScope !== undefined");
  expect(code).not.toContain(narrowReturn);
});

it.each(['setup lang="ts"', "setup"])(
  "keeps an import-free %s script a valid factory with a default parameter",
  (attrs) => {
    // TypeScript classifies an import-free file as a script and would prepend
    // "use strict", which is illegal inside a function with a default parameter.
    const transformed = transformSfcScript({
      attrs,
      offset: 0,
      content: 'const secret = "READY"; const label = () => secret;',
    });
    if (!transformed.ok) throw new Error(transformed.error.message);
    expect(transformed.value.code).not.toContain("use strict");
    const factory = new Function(`${transformed.value.code}; return ${sfcSetupScopeName};`)();
    expect(factory({}).label()).toBe("READY");
  },
);

it("strips only the leading prologue and keeps a directive inside a function", () => {
  const transformed = transformSfcScript({
    attrs: 'setup lang="ts"',
    offset: 0,
    content:
      'import { createSignal } from "tachyon-dom";\nconst run = function () { "use strict"; return createSignal(1); };',
  });
  if (!transformed.ok) throw new Error(transformed.error.message);
  expect(transformed.value.code.match(/"use strict"/g)).toHaveLength(1);
  expect(transformed.value.code).toMatch(/const run = function \(\) \{\s*"use strict";/);
});

it("reports full emission and no setup bindings for a non-setup script", () => {
  const transformed = transformSfcScript(
    { attrs: "", offset: 0, content: "export default () => ({ label: 1 });" },
    { templateIdentifiers: new Set(["label"]) },
  );
  if (!transformed.ok) throw new Error(transformed.error.message);
  expect(transformed.value.setupBindings).toEqual([]);
  expect(transformed.value.exposedBindings).toEqual([]);
  expect(transformed.value.scopeEmission).toBe("full");
});

const setupFactory = (attrs: string, content: string) => {
  const transformed = transformSfcScript({ attrs, offset: 0, content });
  if (!transformed.ok) throw new Error(transformed.error.message);
  // Function bodies cannot hold import declarations; the factory is what is under test.
  const code = transformed.value.code.replace(/^import [^\n]*\n/gm, "");
  return new Function("createSignal", `${code}; return ${sfcSetupScopeName};`)(createSignal) as (
    scope?: object,
  ) => Record<string, unknown>;
};

it("accepts a TS setup script whose only import is type-only", () => {
  // verbatimModuleSyntax erases the import and leaves `export {};` behind, which
  // is the compiler's module marker rather than a user export.
  const transformed = transformSfcScript({
    attrs: 'setup lang="ts"',
    offset: 0,
    content: 'import type { Row } from "./types";\nconst value: Row[] = [];',
  });
  if (!transformed.ok) throw new Error(transformed.error.message);
  expect(transformed.value.code).not.toContain("export");
  expect(transformed.value.setupBindings).toEqual(["value"]);
  expect(
    setupFactory('setup lang="ts"', 'import type { Row } from "./types";\nconst value: Row[] = [];')({}).value,
  ).toEqual([]);
});

it.each([
  ["a user export {}", "export {};\nconst value = 1;"],
  ["a re-export", 'export { value } from "./other";\nconst value = 1;'],
  ["an exported declaration", "export const value = 1;"],
  ["a default export", "const value = 1;\nexport default value;"],
])("still rejects %s in a TS setup script", (_label, content) => {
  const transformed = transformSfcScript({ attrs: 'setup lang="ts"', offset: 0, content });
  expect(transformed.ok).toBe(false);
  if (transformed.ok) return;
  expect(transformed.error.message).toContain("cannot contain exports");
});

it.each([
  ['setup lang="ts"', "'use strict';\nconst value = 1;"],
  ['setup lang="ts"', '// comment\n"use strict";\nconst value = 1;'],
  ['setup lang="ts"', '"other directive";\n"use strict";\nconst value = 1;'],
  ["setup", '"use strict";\nconst value = 1;'],
  ["setup", "'use strict';\n'use strict';\nconst value = 1;"],
  ["setup", 'import { createSignal } from "tachyon-dom";\n"use strict";\nconst value = createSignal(1)();'],
])("drops an explicit strict directive from the %s factory prologue: %s", (attrs, content) => {
  const transformed = transformSfcScript({ attrs, offset: 0, content });
  if (!transformed.ok) throw new Error(transformed.error.message);
  expect(transformed.value.code).not.toContain("use strict");
  expect(setupFactory(attrs, content)({}).value).toBe(1);
});

it("keeps other prologue directives and a non-prologue strict string", () => {
  const content = '"other directive";\nconst value = 1;\n"use strict";';
  const transformed = transformSfcScript({ attrs: "setup", offset: 0, content });
  if (!transformed.ok) throw new Error(transformed.error.message);
  expect(transformed.value.code).toContain('"other directive";');
  expect(transformed.value.code).toContain('"use strict";');
  expect(setupFactory("setup", content)({}).value).toBe(1);
});

it("keeps a strict directive inside a nested function of a JS setup script", () => {
  const content = '"use strict";\nconst run = function () { "use strict"; return 1; };';
  const transformed = transformSfcScript({ attrs: "setup", offset: 0, content });
  if (!transformed.ok) throw new Error(transformed.error.message);
  expect(transformed.value.code.match(/"use strict"/g)).toHaveLength(1);
  expect((setupFactory("setup", content)({}).run as () => number)()).toBe(1);
});

it("reports user exports and top-level await at their original script offsets", () => {
  const exported = transformSfcScript({
    attrs: 'setup lang="ts"',
    offset: 100,
    content: "const a = 1;\nexport const value = a;",
  });
  expect(exported.ok).toBe(false);
  if (exported.ok) return;
  expect(exported.error).toEqual({
    message: "<script setup> cannot contain exports; expose values through top-level declarations.",
    offset: 100 + "const a = 1;\n".length,
  });
  const awaited = transformSfcScript({ attrs: "setup", offset: 100, content: "const a = 1;\nconst value = await a;" });
  expect(awaited.ok).toBe(false);
  if (awaited.ok) return;
  expect(awaited.error).toEqual({
    message: "<script setup> does not support top-level await; move it into an async function.",
    offset: 100 + "const a = 1;\nconst value = ".length,
  });
});

it("accepts declarations whose modifiers are not export", () => {
  const content = "async function load() { return 1; }\nconst value = 1;";
  const transformed = transformSfcScript({ attrs: 'setup lang="ts"', offset: 0, content });
  if (!transformed.ok) throw new Error(transformed.error.message);
  expect(transformed.value.setupBindings).toEqual(["load", "value"]);
  expect(setupFactory('setup lang="ts"', content)({}).value).toBe(1);
});

it.each(["'use strict';\n\"other directive\";", "\"other directive\";\n'use strict';"])(
  "keeps a prologue made only of other directives: %s",
  (content) => {
    const transformed = transformSfcScript({ attrs: "setup", offset: 0, content });
    if (!transformed.ok) throw new Error(transformed.error.message);
    expect(transformed.value.code).toContain('"other directive";');
    expect(transformed.value.code).not.toContain("use strict");
    expect(setupFactory("setup", content)({})).toEqual({});
  },
);

it("reuses the transformed script for repeated identical inputs", () => {
  // The Vite plugin transforms the same script for the server module, the client
  // module, and every hydration chunk; only the source revision should cost a transpile.
  const script = { attrs: 'setup lang="ts"', offset: 0, content: "const value: number = 1;" };
  const first = transformSfcScript(script);
  const second = transformSfcScript({ ...script });
  const identifiers = new Set(["value"]);
  const narrowed = transformSfcScript(script, { templateIdentifiers: identifiers });
  const narrowedAgain = transformSfcScript(script, { templateIdentifiers: new Set(["value"]) });
  const other = transformSfcScript({ ...script, content: "const value: number = 2;" });
  if (!first.ok || !second.ok || !narrowed.ok || !narrowedAgain.ok || !other.ok) throw new Error("Expected ok");
  expect(second.value).toBe(first.value);
  expect(narrowedAgain.value).toBe(narrowed.value);
  expect(narrowed.value).not.toBe(first.value);
  expect(other.value).not.toBe(first.value);
  expect(Object.isFrozen(first.value)).toBe(true);
  expect(Object.isFrozen(first.value.setupBindings)).toBe(true);
  expect(Object.isFrozen(narrowed.value.setupBindings)).toBe(true);
  expect(Object.isFrozen(narrowed.value.exposedBindings)).toBe(true);
});

it("keeps the cached script result independent of the script offset", () => {
  const base = transformSfcScript({ attrs: "setup", offset: 0, content: "export const value = 1;" });
  const shifted = transformSfcScript({ attrs: "setup", offset: 7, content: "export const value = 1;" });
  expect(base.ok).toBe(false);
  expect(shifted.ok).toBe(false);
  if (base.ok || shifted.ok) return;
  expect(base.error.offset).toBe(0);
  expect(shifted.error.offset).toBe(7);
});

it("shifts nothing for a cached success and keys the cache on sorted template identifiers", () => {
  const script = { attrs: "setup", offset: 0, content: "const a = 1; const b = 2;" };
  const base = transformSfcScript(script, { templateIdentifiers: new Set(["a", "b"]) });
  const shifted = transformSfcScript({ ...script, offset: 9 }, { templateIdentifiers: new Set(["b", "a"]) });
  if (!base.ok || !shifted.ok) throw new Error("Expected ok");
  expect(shifted.value).toBe(base.value);
  expect(Object.isFrozen(base.value.exposedBindings)).toBe(true);
});

it("evicts the least recently used transformed script once the cache is full", () => {
  const scriptFor = (index: number) => ({ attrs: "setup", offset: 0, content: `const value = ${index};` });
  const first = transformSfcScript(scriptFor(0));
  const second = transformSfcScript(scriptFor(1));
  for (let index = 2; index < sfcScriptTransformCacheLimit; index++) transformSfcScript(scriptFor(index));
  // Touching the oldest entry keeps it alive; the next insertion evicts entry 1 instead.
  expect(transformSfcScript(scriptFor(0))).toBe(first);
  transformSfcScript(scriptFor(sfcScriptTransformCacheLimit));
  expect(transformSfcScript(scriptFor(0))).toBe(first);
  expect(transformSfcScript(scriptFor(1))).not.toBe(second);
});
