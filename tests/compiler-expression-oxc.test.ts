import { describe, expect, it } from "vitest";
import { compileTemplate, renderServerTemplate } from "../src/compiler";
import {
  evaluateExpression,
  expressionToJs,
  isAssignableExpression,
  parseExpression,
} from "../src/compiler/expression";

describe("compiler expression OXC backend", () => {
  it("reuses parsed expression results for repeated source and backend pairs", () => {
    const first = parseExpression("user.name", { backend: "native" });
    const second = parseExpression("user.name", { backend: "native" });
    const oxc = parseExpression("user.name", { backend: "oxc" });

    expect(first.ok).toBe(true);
    expect(second).toBe(first);
    expect(oxc).not.toBe(first);
  });

  it("parses optional chaining, nullish coalescing, computed members, and template literals through OXC", () => {
    const parsed = parseExpression("user?.profile?.name ?? `Guest ${fallback}`", { backend: "oxc" });

    expect(parsed.ok).toBe(true);
    expect(evaluateExpression("user?.profile?.name ?? `Guest ${fallback}`", { user: {}, fallback: "Ada" })).toBe(
      "Guest Ada",
    );
    expect(
      evaluateExpression("items[index].label", { items: [{ label: "first" }, { label: "second" }], index: 1 }),
    ).toBe("second");
    const computedJs = expressionToJs("items[index].label", new Set(), "scope");
    expect(
      Function(
        "scope",
        `return ${computedJs}`,
      )({
        items: [{ label: "first" }, { label: "second" }],
        index: 1,
      }),
    ).toBe("second");
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

  it.each([
    ["false && fail()", false],
    ["0 && fail()", 0],
    ['"" && fail()', ""],
    ["null && fail()", null],
    ["undefined && fail()", undefined],
    ["true || fail()", true],
  ])("short-circuits %s without evaluating the right operand", (source, expected) => {
    let rightCalls = 0;
    const scope = {
      fail: () => {
        rightCalls += 1;
        throw new Error("right operand evaluated");
      },
    };

    const interpreted = evaluateExpression(source, scope);
    const generated = Function("scope", `return ${expressionToJs(source, new Set(), "scope")}`)(scope);

    expect(interpreted).toBe(expected);
    expect(generated).toBe(expected);
    expect(rightCalls).toBe(0);
  });

  it("evaluates logical operands in order and preserves operand values", () => {
    let leftCalls = 0;
    let rightCalls = 0;
    const scope = {
      left: () => {
        leftCalls += 1;
        return "left";
      },
      right: () => {
        rightCalls += 1;
        return "right";
      },
    };
    const source = "left() && right()";

    expect(evaluateExpression(source, scope)).toBe("right");
    expect(Function("scope", `return ${expressionToJs(source, new Set(), "scope")}`)(scope)).toBe("right");
    expect(leftCalls).toBe(2);
    expect(rightCalls).toBe(2);
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

  it("keeps eval-free method calls bound to their receiver", () => {
    const scope = {
      counter: {
        value: 1,
        add(amount: number) {
          this.value += amount;
          return this.value;
        },
      },
      method: "add",
    };

    expect(evaluateExpression("counter.add(2)", scope)).toBe(3);
    expect(evaluateExpression("counter[method](4)", scope)).toBe(7);

    const directJs = expressionToJs("counter.add(2)", new Set(), "scope");
    const computedJs = expressionToJs("counter[method](4)", new Set(), "scope");
    expect(Function("scope", `return ${directJs}`)(scope)).toBe(9);
    expect(Function("scope", `return ${computedJs}`)(scope)).toBe(13);
  });

  it("rejects prototype escape property names before evaluation or JS emission", () => {
    for (const source of [
      "user.constructor",
      "user.__proto__",
      "user.prototype",
      "user['constructor']",
      "user['__proto__']",
      "user['prototype']",
    ]) {
      expect(parseExpression(source).ok, source).toBe(false);
      expect(parseExpression(source, { backend: "oxc" }).ok, source).toBe(false);
      expect(expressionToJs(source, new Set(), "scope"), source).toBe("undefined");
      expect(evaluateExpression(source, { user: {} }), source).toBeUndefined();
    }
  });

  it("blocks computed prototype escape property names at evaluation and JS emission time", () => {
    for (const key of ["constructor", "__proto__", "prototype"]) {
      const source = "user[key]";
      const scope = { user: {}, key };
      const js = expressionToJs(source, new Set(), "scope");

      expect(parseExpression(source).ok, key).toBe(true);
      expect(evaluateExpression(source, scope), key).toBeUndefined();
      expect(Function("scope", `return ${js}`)(scope), key).toBeUndefined();
    }

    const attack = "value['con' + 'structor']['con' + 'structor']('return 7')()";
    const attackJs = expressionToJs(attack, new Set(), "scope");

    expect(parseExpression(attack).ok).toBe(true);
    expect(evaluateExpression(attack, { value: {} })).toBeUndefined();
    expect(Function("scope", `return ${attackJs}`)({ value: {} })).toBeUndefined();
  });
});
