import { describe, expect, it } from "vitest";
import { compileTemplate, renderServerTemplate } from "../src/compiler";
import {
  evaluateExpression,
  expressionToJs,
  isAssignableExpression,
  parseExpression,
} from "../src/compiler/expression";

describe("compiler expression OXC backend", () => {
  it("parses optional chaining, nullish coalescing, computed members, and template literals through OXC", () => {
    const parsed = parseExpression("user?.profile?.name ?? `Guest ${fallback}`", { backend: "oxc" });

    expect(parsed.ok).toBe(true);
    expect(evaluateExpression("user?.profile?.name ?? `Guest ${fallback}`", { user: {}, fallback: "Ada" })).toBe(
      "Guest Ada",
    );
    expect(
      evaluateExpression("items[index].label", { items: [{ label: "first" }, { label: "second" }], index: 1 }),
    ).toBe("second");
    expect(expressionToJs("items[index].label", new Set(), "scope")).toBe("scope.items[scope.index].label");
    expect(isAssignableExpression("user[addressKey]", { backend: "oxc" })).toBe(true);
  });

  it("uses the OXC fallback from template validation through SSR rendering", () => {
    const result = compileTemplate(
      "<section title={user?.profile?.name ?? `Guest ${fallback}`}>{user?.profile?.name ?? `Guest ${fallback}`}</section>",
    );

    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    expect(renderServerTemplate(result.value, { user: {}, fallback: "Ada" })).toBe(
      '<section title="Guest Ada">Guest Ada</section>',
    );
  });

  it("keeps comparison semantics aligned between SSR evaluation and generated client JS", () => {
    const scope = { count: "10", limit: "2" };
    const js = expressionToJs("count > limit", new Set(), "scope");
    const clientValue = Function("scope", `return ${js}`)(scope);

    expect(evaluateExpression("count > limit", scope)).toBe(false);
    expect(clientValue).toBe(false);
  });

  it("evaluates equality and string comparisons with JavaScript semantics", () => {
    expect(evaluateExpression("a != b", { a: 3, b: 2 })).toBe(true);
    expect(evaluateExpression("a == b", { a: 1, b: 2 })).toBe(false);
    expect(evaluateExpression("'apple' < 'banana'", {})).toBe(true);
    expect(evaluateExpression("'apple' <= 'apple'", {})).toBe(true);
  });

  it("decodes native string literal escapes", () => {
    expect(evaluateExpression(String.raw`'a\nb'`, {})).toBe("a\nb");
    expect(evaluateExpression(String.raw`'it\'s ok'`, {})).toBe("it's ok");
  });

  it("aligns interpreter plus and member access semantics with generated JavaScript", () => {
    const plusScope = { label: "n=" };
    const plusJs = expressionToJs("label + count", new Set(), "scope");

    expect(evaluateExpression("label + count", plusScope)).toBe(Function("scope", `return ${plusJs}`)(plusScope));
    expect(evaluateExpression("label + count", plusScope)).toBe("n=undefined");

    const memberJs = expressionToJs("user.name", new Set(), "scope");
    expect(() => evaluateExpression("user.name", {})).toThrow(TypeError);
    expect(() => Function("scope", `return ${memberJs}`)({})).toThrow(TypeError);
  });
});
