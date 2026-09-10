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
export type ConditionalTestAnalysis = { kind: "constant"; value: boolean } | { kind: "dynamic" };

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

const isConditional = (node: TemplateNode): node is ElementNode => node.type === "element" && node.tagName === "if";

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

const collectRootIdentifiers = (node: ExpressionNode, into: Set<string>): void => {
  switch (node.type) {
    case "identifier": {
      const root = node.path[0];
      if (root !== undefined) into.add(root);
      return;
    }
    case "member":
      collectRootIdentifiers(node.object, into);
      collectRootIdentifiers(node.property, into);
      return;
    case "call":
      collectRootIdentifiers(node.callee, into);
      for (const argument of node.args) collectRootIdentifiers(argument, into);
      return;
    case "unary":
      collectRootIdentifiers(node.argument, into);
      return;
    case "binary":
      collectRootIdentifiers(node.left, into);
      collectRootIdentifiers(node.right, into);
      return;
    case "conditional":
      collectRootIdentifiers(node.test, into);
      collectRootIdentifiers(node.consequent, into);
      collectRootIdentifiers(node.alternate, into);
      return;
    case "array":
      for (const item of node.items) collectRootIdentifiers(item, into);
      return;
    case "object":
      for (const entry of node.entries) collectRootIdentifiers(entry.value, into);
      return;
    case "template":
      for (const part of node.parts) if (typeof part !== "string") collectRootIdentifiers(part, into);
      return;
    default:
      return;
  }
};

/**
 * Names an expression reads from its enclosing scope, or `undefined` when the expression cannot be parsed and
 * therefore cannot be bounded.
 */
export const expressionScopeNames = (expression: string): ReadonlySet<string> | undefined => {
  const parsed = parseExpression(expression);
  if (!parsed.ok) return undefined;
  const names = new Set<string>();
  collectRootIdentifiers(parsed.value, names);
  return names;
};

/**
 * Whether an expression's result can never be a signal accessor, so the runtime's `read` unwrapping is
 * unnecessary.
 *
 * Compound expressions are evaluated in JavaScript before the result reaches the binding, so an operator that
 * always produces a primitive, array, or object literal cannot yield an accessor. Anything that can return one
 * of its operands unchanged - `&&`, `||`, `??`, and the conditional operator - is excluded, as are identifiers,
 * member access, and calls, whose value the compiler cannot see.
 */
export const expressionAlwaysPlainValue = (expression: string): boolean => {
  const parsed = parseExpression(expression);
  if (!parsed.ok) return false;
  const node = parsed.value;
  switch (node.type) {
    case "literal":
    case "regex":
    case "template":
    case "array":
    case "object":
    case "unary":
      return true;
    case "binary":
      return !["&&", "||", "??"].includes(node.operator);
    default:
      return false;
  }
};

const containsCall = (node: ExpressionNode): boolean => {
  switch (node.type) {
    case "call":
      return true;
    case "member":
      return containsCall(node.object) || containsCall(node.property);
    case "unary":
      return containsCall(node.argument);
    case "binary":
      return containsCall(node.left) || containsCall(node.right);
    case "conditional":
      return containsCall(node.test) || containsCall(node.consequent) || containsCall(node.alternate);
    case "array":
      return node.items.some(containsCall);
    case "object":
      return node.entries.some((entry) => containsCall(entry.value));
    case "template":
      return node.parts.some((part) => typeof part !== "string" && containsCall(part));
    default:
      return false;
  }
};

/**
 * Whether an expression calls anything. A call reaches state the compiler cannot see: a scope member invoked as
 * a method receives the scope as `this`, and any function can close over names the expression never mentions.
 */
export const expressionCallsSomething = (expression: string): boolean => {
  const parsed = parseExpression(expression);
  return parsed.ok ? containsCall(parsed.value) : true;
};
