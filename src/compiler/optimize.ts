import { parseExpression, type ExpressionNode } from "./expression.js";
import type { ElementNode, TemplateNode } from "./types.js";
import { attrExpression } from "./utils.js";

/**
 * Static analysis of a template's conditional tests, classified so later passes can tell what they may act on.
 *
 * - `constant`: the test is a literal, or a negation of one, so it is decided at compile time.
 * - `dynamic`: anything else. Identifiers, calls, member access, and getters stay dynamic even when a type or a
 *   declaration suggests a value, because evaluating them could observe or change program state.
 */
export type ConditionalTestAnalysis =
  | { kind: "constant"; value: boolean }
  | { kind: "dynamic" };

export type RemovedConditional = {
  /** Template child path of the removed `<if>`, in the tree it was removed from. */
  path: readonly number[];
  test: string;
};

export type StaticTemplateOptimization = {
  root: ElementNode;
  removedConditionals: readonly RemovedConditional[];
};

const literalTruthiness = (node: ExpressionNode): boolean | undefined => {
  if (node.type === "literal") return Boolean(node.value);
  if (node.type === "unary" && node.operator === "!") {
    const argument = literalTruthiness(node.argument);
    return argument === undefined ? undefined : !argument;
  }
  return undefined;
};

/** Classifies an `<if test={...}>` expression that is present and parses. */
export const analyzeConditionalTest = (test: string): ConditionalTestAnalysis => {
  const parsed = parseExpression(test);
  if (!parsed.ok) return { kind: "dynamic" };
  const value = literalTruthiness(parsed.value);
  return value === undefined ? { kind: "dynamic" } : { kind: "constant", value };
};

const isConditional = (node: TemplateNode): node is ElementNode =>
  node.type === "element" && node.tagName === "if";

/**
 * Removes `<if>` elements whose test is constant and false, before the IR is built. Doing it here keeps the
 * template HTML, the SSR output, binding paths, and hydration regions derived from one tree, so nothing has to
 * be renumbered afterwards. Conditionals with a constant true test are left in place: unwrapping them would
 * change the DOM shape that SSR adoption and hydration validation already agree on.
 */
export const removeConstantFalseConditionals = (root: ElementNode): StaticTemplateOptimization => {
  const removedConditionals: RemovedConditional[] = [];

  const visitChildren = (children: readonly TemplateNode[], path: readonly number[]): TemplateNode[] => {
    const next: TemplateNode[] = [];
    for (const [index, child] of children.entries()) {
      const childPath = [...path, index];
      // A missing or unparsable test is left in place so the IR still reports it as a diagnostic.
      const test = isConditional(child) ? attrExpression(child, "test") : undefined;
      if (test !== undefined) {
        const analysis = analyzeConditionalTest(test);
        if (analysis.kind === "constant" && !analysis.value) {
          removedConditionals.push({ path: childPath, test });
          continue;
        }
      }
      next.push(child.type === "element" ? visitElement(child, childPath) : child);
    }
    return next;
  };

  const visitElement = (node: ElementNode, path: readonly number[]): ElementNode => {
    const children = visitChildren(node.children, path);
    return children.length === node.children.length && children.every((child, index) => child === node.children[index])
      ? node
      : { ...node, children };
  };

  return { root: visitElement(root, []), removedConditionals };
};
