import { expect, it } from "vitest";
import { transformSfcScript } from "../src/compiler/sfc";

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
