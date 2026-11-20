import { expect, it, vi } from "vitest";
import { compileTemplate } from "../src/compiler";
import * as expression from "../src/compiler/expression";
import { createTemplateIr } from "../src/compiler/ir";
import { parseTemplate } from "../src/compiler/parser";

it.each([
  ["attribute", "valid", "nested"],
  ["text", "valid", "nested"],
  ["text", "invalid", "nested"],
  ["text", "valid", "shallow"],
  ["attribute", "invalid", "shallow"],
] as const)("validates a %s expression once (%s, %s)", (kind, validity, depth) => {
  const value = validity === "valid" ? "value" : "value +";
  const element = kind === "attribute" ? `<p title={${value}}>content</p>` : `<p>{${value}}</p>`;
  const source = depth === "nested" ? "<div>".repeat(6) + element + "</div>".repeat(6) : element;
  const root = parseTemplate(source);
  if (!root.ok) throw new Error(root.error.message);
  const parseExpression = vi.spyOn(expression, "parseExpression");
  try {
    const result = createTemplateIr(root.value);
    if (validity === "invalid") {
      expect(result).toEqual({
        ok: false,
        error: {
          message: `Invalid ${kind === "attribute" ? "title attribute" : "text"} expression: ${value}.`,
          offset: source.indexOf(kind === "attribute" ? "title" : "{"),
          endOffset: source.indexOf("}") + 1,
        },
      });
    } else {
      expect(result.ok).toBe(true);
    }
    expect(parseExpression).toHaveBeenCalledExactlyOnceWith(value);
  } finally {
    parseExpression.mockRestore();
  }
});

it("keeps expression diagnostics ahead of structural diagnostics", () => {
  const source = "<main><if><p>{value +}</p></if></main>";
  const root = parseTemplate(source);
  if (!root.ok) throw new Error(root.error.message);
  expect(createTemplateIr(root.value)).toEqual({
    ok: false,
    error: {
      message: "Invalid text expression: value +.",
      offset: source.indexOf("{"),
      endOffset: source.indexOf("}") + 1,
    },
  });
});

it("freezes each reachable compiled object once before caching it", () => {
  const source = "<article><p title={title}>{title}</p></article>";
  const freeze = vi.spyOn(Object, "freeze");
  try {
    const result = compileTemplate(source);
    if (!result.ok) throw new Error(result.error.message);
    expect(result.value.root).toBe(result.value.ir.root);
    for (const object of [result, result.value, result.value.root, result.value.root.children]) {
      expect(Object.isFrozen(object)).toBe(true);
      expect(freeze.mock.calls.filter(([value]) => value === object)).toHaveLength(1);
    }
    expect(compileTemplate(source)).toBe(result);
  } finally {
    freeze.mockRestore();
  }
});
