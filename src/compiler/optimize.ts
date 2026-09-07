import { parseExpression, type ExpressionNode } from "./expression.js";
import type {
  ClientBinding,
  ComponentBoundary,
  ElementNode,
  ListBinding,
  StoreDefinition,
  TemplateNode,
} from "./types.js";
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
 * Parent scope names a keyed list's rows can read, or `undefined` when any expression in the list cannot be
 * bounded. `undefined` means the runtime must keep tracking the whole parent scope.
 *
 * Row-local names are excluded because a row scope defines them itself: the item, the index, row stores, and
 * component props and stores all shadow a parent key of the same name. A name is kept whenever it could reach
 * the parent, including when a row-local definition's own initial expression reads it.
 */
export const listParentScopeNames = (binding: ListBinding): ReadonlySet<string> | undefined => {
  const names = new Set<string>();
  const local = new Set<string>([binding.itemName, ...(binding.indexName ? [binding.indexName] : [])]);
  let bounded = true;

  const add = (expression: string): void => {
    const found = expressionScopeNames(expression);
    if (!found) {
      bounded = false;
      return;
    }
    for (const name of found) names.add(name);
  };

  const visitDefinitions = (
    stores: readonly StoreDefinition[] | undefined,
    components: readonly ComponentBoundary[] | undefined,
  ): void => {
    for (const store of stores ?? []) {
      local.add(store.name);
      add(store.initial);
    }
    for (const component of components ?? []) {
      for (const prop of component.props) {
        local.add(prop.name);
        add(prop.expression);
      }
      for (const store of component.stores) {
        local.add(store.name);
        add(store.initial);
      }
    }
  };

  const visitBindings = (bindings: readonly ClientBinding[]): void => {
    for (const binding of bindings) {
      if (binding.kind === "event") add(binding.handler);
      else if (binding.kind === "if") {
        add(binding.test);
        visitDefinitions(binding.stores, binding.components);
        visitBindings(binding.bindings);
      } else if (binding.kind === "list") {
        add(binding.each);
        add(binding.key);
        local.add(binding.itemName);
        if (binding.indexName) local.add(binding.indexName);
        visitDefinitions(binding.stores, binding.components);
        visitBindings(binding.bindings);
      } else {
        add(binding.expression);
      }
    }
  };

  add(binding.key);
  visitDefinitions(binding.stores, binding.components);
  visitBindings(binding.bindings);
  if (!bounded) return undefined;
  for (const name of local) names.delete(name);
  return names;
};
