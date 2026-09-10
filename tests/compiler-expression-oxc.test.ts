import { describe, expect, it } from "vitest";
import { compileTemplate, renderServerTemplate } from "../src/compiler";
import {
  evaluateExpression,
  evaluateExpressionNode,
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

  it.each([null, undefined])("skips computed keys and arguments on optional nullish access: %s", (user) => {
    for (const source of ["object()?.[key()]", "object()?.[key()](arg())"]) {
      const parsed = parseExpression(source, { backend: "oxc" });
      expect(parsed.ok).toBe(true);
      if (!parsed.ok) throw new Error("Expected expression IR");
      for (const run of [
        (scope: Record<string, unknown>) => evaluateExpressionNode(parsed.value, scope),
        Function("scope", `return ${expressionToJs(source, new Set(), "scope", { backend: "oxc" })}`),
        Function("scope", `with (scope) { return ${source}; }`),
      ]) {
        const calls: string[] = [];
        expect(
          run({
            object: () => {
              calls.push("object");
              return user;
            },
            key: () => {
              throw new Error("key must not run");
            },
            arg: () => {
              throw new Error("arg must not run");
            },
          }),
        ).toBeUndefined();
        expect(calls).toEqual(["object"]);
      }
    }
  });

  it.each(["__tachyonObject", "__tachyonProperty"])("preserves computed key locals named %s", (local) => {
    for (const suffix of ["", "()"]) {
      const source = `user?.[${local}]${suffix}`;
      const user = { value: () => 7 };
      const js = expressionToJs(source, new Set([local]));
      expect(Function("scope", local, `return ${js}`)({ user }, "value")).toBe(suffix ? 7 : user.value);
    }
  });

  it("preserves optional computed method evaluation order and receiver", () => {
    const source = "object()?.[key()](arg())";
    for (const run of [
      (scope: Record<string, unknown>) => evaluateExpression(source, scope),
      Function("scope", `return ${expressionToJs(source)}`),
      Function("scope", `with (scope) { return ${source}; }`),
    ]) {
      const calls: string[] = [];
      const receiver = {
        value: 7,
        method(this: { value: number }, value: number) {
          calls.push("method");
          return this.value + value;
        },
      };
      expect(
        run({
          object: () => {
            calls.push("object");
            return receiver;
          },
          key: () => {
            calls.push("key");
            return "method";
          },
          arg: () => {
            calls.push("arg");
            return 2;
          },
        }),
      ).toBe(9);
      expect(calls).toEqual(["object", "key", "arg", "method"]);
    }
  });

  it("returns present values through optional computed access and calls", () => {
    for (const [source, expected] of [
      ["object()?.[key()]", "found"],
      ["object()?.[key()]()", "found"],
    ] as const) {
      for (const run of [
        (scope: Record<string, unknown>) => evaluateExpression(source, scope),
        Function("scope", `return ${expressionToJs(source, new Set(), "scope", { backend: "oxc" })}`),
        Function("scope", `with (scope) { return ${source}; }`),
      ]) {
        const calls: string[] = [];
        expect(
          run({
            object: () => {
              calls.push("object");
              return { label: source.endsWith("()") ? () => "found" : "found" };
            },
            key: () => {
              calls.push("key");
              return "label";
            },
          }),
        ).toBe(expected);
        expect(calls).toEqual(["object", "key"]);
      }
    }
  });

  // The interpreter reports the nullish object itself before touching it, so the message never depends on the
  // property that was about to be read. Generated code and plain JavaScript raise the engine's own TypeError.
  it("rejects non-optional computed access and calls on nullish objects", () => {
    for (const source of ["object()[key()]", "object()[key()]()"]) {
      for (const value of [null, undefined]) {
        const scope = { object: () => value, key: () => "label" };
        expect(() => evaluateExpression(source, scope)).toThrow(new TypeError(`Cannot read properties of ${value}.`));
        for (const run of [
          Function("scope", `return ${expressionToJs(source, new Set(), "scope", { backend: "oxc" })}`),
          Function("scope", `with (scope) { return ${source}; }`),
        ]) {
          expect(() => run(scope)).toThrow(TypeError);
        }
      }
    }
  });

  // Template expressions deliberately diverge from JavaScript here: calling a non-function member yields
  // undefined instead of throwing, so plain JavaScript is not the oracle for this case.
  it("returns undefined when a computed member call target is not a function", () => {
    for (const source of ["object()?.[key()]()", "object()[key()]()"]) {
      for (const run of [
        (scope: Record<string, unknown>) => evaluateExpression(source, scope),
        Function("scope", `return ${expressionToJs(source, new Set(), "scope", { backend: "oxc" })}`),
      ]) {
        expect(run({ object: () => ({ label: "not callable" }), key: () => "label" })).toBeUndefined();
      }
      expect(() =>
        Function(
          "scope",
          `with (scope) { return ${source}; }`,
        )({
          object: () => ({ label: "not callable" }),
          key: () => "label",
        }),
      ).toThrow(TypeError);
    }
  });

  it("passes every computed member call argument in source order", () => {
    for (const source of [
      "object()?.[key()](first(), second(), third())",
      "object()[key()](first(), second(), third())",
    ]) {
      for (const run of [
        (scope: Record<string, unknown>) => evaluateExpression(source, scope),
        Function("scope", `return ${expressionToJs(source, new Set(), "scope", { backend: "oxc" })}`),
        Function("scope", `with (scope) { return ${source}; }`),
      ]) {
        const calls: string[] = [];
        expect(
          run({
            object: () => ({ join: (...args: unknown[]) => args.join("|") }),
            key: () => "join",
            first: () => {
              calls.push("first");
              return "a";
            },
            second: () => {
              calls.push("second");
              return "b";
            },
            third: () => {
              calls.push("third");
              return "c";
            },
          }),
        ).toBe("a|b|c");
        expect(calls).toEqual(["first", "second", "third"]);
      }
    }
  });

  it("short-circuits optional computed keys in compiled SSR", () => {
    const compiled = compileTemplate("<p>{user?.[key()]}</p>");
    expect(compiled.ok).toBe(true);
    if (!compiled.ok) throw new Error("Expected template");
    expect(
      renderServerTemplate(compiled.value, {
        user: null,
        key: () => {
          throw new Error("key must not run");
        },
      }),
    ).toBe("<p><!--td:text--></p>");
  });

  it("retains denied-key guards on optional computed access and calls", () => {
    for (const key of ["__proto__", "constructor", "prototype"]) {
      for (const source of ["user?.[key]", "user?.[key](arg())"]) {
        const scope = {
          user: {},
          key,
          arg: () => {
            throw new Error("denied call argument");
          },
        };
        expect(evaluateExpression(source, scope)).toBeUndefined();
        expect(Function("scope", `return ${expressionToJs(source)}`)(scope)).toBeUndefined();
      }
    }
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
