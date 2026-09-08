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
