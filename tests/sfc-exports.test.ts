import { execFileSync } from "node:child_process";
import { expect, it } from "vitest";
import { transformSfcScript } from "../src/compiler/sfc";

it.each([
  'const text = "export default"; export default { text };',
  'export const other = 1, scope = { text: "scope" };',
  'function helper() {} class Helper {} const local = 1; export default { text: "ordinary declarations" };',
  '// export default\nconst text = "comment"; export default { text };',
  '/* export const scope = */ const text = "export const scope ="; export default { text };',
  "export const scope = { value: 0, increment() { return ++scope.value; } };",
  "export default function scope() { return scope.name; }",
  "export default class Scope { static label() { return Scope.name; } }",
])("preserves native ESM exports and lexical references: %s", (content) => {
  const transformed = transformSfcScript({ attrs: 'lang="js"', content, offset: 0 });
  if (!transformed.ok) throw new Error(transformed.error.message);
  const evaluate = (code: string) =>
    execFileSync(
      process.execPath,
      [
        "--input-type=module",
        "-e",
        `
    const m = await import("data:text/javascript;base64," + Buffer.from(${JSON.stringify(code)}).toString("base64"));
    const value = m.scope ?? m.default;
    console.log(JSON.stringify(value.increment ? value.increment() : value.label ? value.label() : typeof value === "function" ? value() : value));
  `,
      ],
      { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
    );
  expect(transformed.value.defaultScopeName).toBeDefined();
  const connected = transformed.value.code + `\nexport { ${transformed.value.defaultScopeName} as __connected };`;
  expect(evaluate(connected)).toBe(evaluate(content));
  expect(
    execFileSync(
      process.execPath,
      [
        "--input-type=module",
        "-e",
        `
    const m = await import("data:text/javascript;base64," + Buffer.from(${JSON.stringify(connected)}).toString("base64"));
    if (m.__connected !== (m.scope ?? m.default)) throw new Error("Generated scope alias differs from the original export");
  `,
      ],
      { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
    ),
  ).toBe("");
});

it("rejects actual competing scope exports", () => {
  const result = transformSfcScript({
    attrs: 'lang="js"',
    content: "export const scope = {}; export default {};",
    offset: 42,
  });
  expect(result).toEqual({
    ok: false,
    error: { message: "Use either export const scope or export default, not both.", offset: 42 },
  });
});

it("preserves comments around the default export tokens", () => {
  const result = transformSfcScript({
    attrs: 'lang="js"',
    content: 'export /* before */ default /* after */ { text: "ok" };',
    offset: 0,
  });
  if (!result.ok) throw new Error(result.error.message);
  expect(result.value.code).toContain("/* before */");
  expect(result.value.code).toContain("/* after */");
});

it.each([
  'export const text = "export default";',
  'const scope = {}; export const text = "export const scope =";',
  "export function ordinary() {} export class Other {}",
  "const { scope } = { scope: {} };",
])("does not invent a default scope for unrelated declarations: %s", (content) => {
  const result = transformSfcScript({ attrs: 'lang="js"', content, offset: 0 });
  if (!result.ok) throw new Error(result.error.message);
  expect(result.value.defaultScopeName).toBeUndefined();
  expect(result.value.code.trim()).toBe(content);
});
