import { expect, it } from "vitest";
import { compileTemplate, generateClientModule } from "../src/compiler";
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
  ["flag ? /a/ : /b/", true],
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
