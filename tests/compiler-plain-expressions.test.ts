import { expect, it, vi } from "vitest";
import { compileTemplate, generateClientModule } from "../src/compiler";
import { expressionToScopeAccess } from "../src/compiler/utils";
import { expressionAlwaysPlainValue } from "../src/compiler/optimize";
import { createSignal } from "../src/runtime/signal";
import { evaluateGeneratedClientModule } from "./generated-client-module";

it.each([
  ["ternary", "plain", "plain"],
  ["and", "plain", "plain"],
  ["or", "plain", "plain"],
  ["nullish", "plain", "plain"],
  ["ternary", "unknown", "plain"],
  ["and", "plain", "unknown"],
  ["nullish", "unknown", "unknown"],
  ["or", "unknown", "unknown"],
  ["and", "unknown", "unknown"],
  ["ternary", "plain", "unknown"],
] as const)("classifies %s with %s and %s results", (operator, leftKind, rightKind) => {
  const left = leftKind === "plain" ? '"left"' : "left";
  const right = rightKind === "plain" ? '"right"' : "right";
  const expression =
    operator === "ternary"
      ? `flag ? ${left} : ${right}`
      : `${left} ${{ and: "&&", or: "||", nullish: "??" }[operator]} ${right}`;
  const plain = leftKind === "plain" && rightKind === "plain";
  expect(expressionAlwaysPlainValue(expression)).toBe(plain);

  const result = compileTemplate(`<p>{${expression}}</p>`);
  if (!result.ok) throw new Error(result.error.message);
  const generated = generateClientModule(result.value, { reactive: true });
  expect(generated.includes("__tachyonRead(")).toBe(!plain);
});

it.each([
  ['flag ? (null ?? "left") : (!value && ("yes" || "no"))', true],
  ['flag ? (null ?? accessor()) : "right"', false],
  ['("plain" || object.member) && "right"', false],
  ["flag ? ready() : value.member", false],
  ["accessor ? 1 : 2", true],
  ["left + right", true],
  ["flag ? /a/ : /b/", false],
  ["/a/", true],
  ["flag ? `before ${value}` : `after`", true],
  ["flag ? [value] : [other]", true],
  ["flag ? { value: value } : { value: other }", true],
  ["flag ? !value : -other", true],
  ["flag ? 1 :", false],
] as const)("classifies nested result possibilities for %s", (expression, plain) => {
  expect(expressionAlwaysPlainValue(expression)).toBe(plain);
});

it("preserves selected branch effects and updates while removing a plain binding's unwrap", () => {
  const result = compileTemplate(
    '<main><p>{enabled() ? left() + "!" : right() + "?"}</p><b>{enabled() ? online : "offline"}</b></main>',
  );
  if (!result.ok) throw new Error(result.error.message);
  const code = generateClientModule(result.value, { reactive: true, mountOnly: true });
  expect(Array.from(code.matchAll(/__tachyonRead\(/g))).toHaveLength(1);
  const generated = evaluateGeneratedClientModule(code);
  const wrapper = document.createElement("div");
  wrapper.innerHTML = generated.templateHtml;
  const element = wrapper.firstElementChild as HTMLElement;
  const enabled = createSignal(false);
  const online = createSignal("online");
  const calls: string[] = [];
  const cleanup = generated.bind(element, {
    enabled,
    online,
    left: () => {
      calls.push("left");
      return "active";
    },
    right: () => {
      calls.push("right");
      return "inactive";
    },
  });
  try {
    expect(element.textContent).toBe("inactive?offline");
    expect(calls).toEqual(["right"]);
    enabled.set(true);
    expect(element.textContent).toBe("active!online");
    expect(calls).toEqual(["right", "left"]);
    online.set("connected");
    expect(element.textContent).toBe("active!connected");
    expect(calls).toEqual(["right", "left"]);
  } finally {
    if (typeof cleanup === "function") cleanup();
  }
});

it("unwraps a signal returned by a replaced RegExp in a selection", () => {
  const result = compileTemplate('<p>{flag() ? /pattern/ : "off"}</p>');
  if (!result.ok) throw new Error(result.error.message);
  const code = generateClientModule(result.value, { reactive: true, mountOnly: true });
  const generated = evaluateGeneratedClientModule(code);
  const wrapper = document.createElement("div");
  wrapper.innerHTML = generated.templateHtml;
  const element = wrapper.firstElementChild as HTMLElement;
  const replacement = createSignal("replacement");
  const original = RegExp;
  let cleanup: ReturnType<typeof generated.bind> = undefined;
  let replaced = false;
  try {
    cleanup = generated.bind(element, {
      flag: () => {
        vi.stubGlobal("RegExp", function () {
          return replacement;
        });
        return true;
      },
    });
    replaced = RegExp !== original;
  } finally {
    vi.unstubAllGlobals();
    if (typeof cleanup === "function") cleanup();
  }
  expect(replaced).toBe(true);
  expect(code).toContain("__tachyonRead(");
  expect(element.textContent).toBe("replacement");
});

it("does not return an accessor from a template with only an interpolation and a replaced String", () => {
  const expression = 'flag ? `${value}` : "off"';
  const emitted = expressionToScopeAccess(expression);
  const accessor = createSignal("replacement");
  Object.defineProperty(accessor, Symbol.toPrimitive, { value: () => "coerced" });
  const evaluate = new Function("scope", "String", `return ${emitted};`);
  expect(expressionAlwaysPlainValue(expression)).toBe(true);
  expect(evaluate({ flag: true, value: 1 }, () => accessor)).toBe("coerced");
});
