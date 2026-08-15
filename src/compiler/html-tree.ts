import { err, ok, type Result } from "../result.js";
import type { CompilerError, ElementNode, TemplateNode } from "./types.js";
import { renderableChildren } from "./utils.js";

type ImpliedContainer = "tbody" | "colgroup";

const whitespaceText = (node: TemplateNode): boolean => node.type === "text" && node.value.trim() === "";

const impliedContainerFor = (node: TemplateNode): ImpliedContainer | undefined => {
  if (node.type !== "element") return undefined;
  if (node.tagName === "tr") return "tbody";
  if (node.tagName === "col") return "colgroup";
  if (node.tagName !== "for" && node.tagName !== "if") return undefined;
  const children = renderableChildren(node).filter((child) => !whitespaceText(child));
  if (children.length === 0 || children.some((child) => child.type !== "element")) return undefined;
  if (children.every((child) => child.type === "element" && child.tagName === "tr")) return "tbody";
  if (children.every((child) => child.type === "element" && child.tagName === "col")) return "colgroup";
  return undefined;
};

const treeError = (parent: ElementNode, child: TemplateNode): Result<never, CompilerError> =>
  err({
    message: `Unsupported HTML tree construction: ${
      child.type === "element" ? `<${child.tagName}>` : "non-whitespace text"
    } cannot be a direct child of <${parent.tagName}>.`,
    offset: child.start ?? parent.openEnd ?? parent.start ?? 0,
    ...(child.end === undefined ? {} : { endOffset: child.end }),
  });

const tableAllowedChildren = new Set(["caption", "colgroup", "thead", "tbody", "tfoot", "style", "script", "template"]);
const selectAllowedChildren = new Set(["option", "optgroup", "hr", "script", "template"]);
const optgroupAllowedChildren = new Set(["option", "script", "template"]);

const normalizeElement = (node: ElementNode): Result<ElementNode, CompilerError> => {
  const children: TemplateNode[] = [];
  for (const child of node.children) {
    if (child.type === "text") {
      children.push(child);
      continue;
    }
    const normalized = normalizeElement(child);
    if (!normalized.ok) return normalized;
    children.push(normalized.value);
  }

  if (node.tagName === "select" || node.tagName === "optgroup") {
    const allowed = node.tagName === "select" ? selectAllowedChildren : optgroupAllowedChildren;
    for (const child of children) {
      if (child.type === "element" && !allowed.has(child.tagName)) return treeError(node, child);
    }
  }
  if (node.tagName !== "table") return ok({ ...node, children });

  const normalizedChildren: TemplateNode[] = [];
  for (let index = 0; index < children.length; ) {
    const child = children[index] as TemplateNode;
    const implied = impliedContainerFor(child);
    if (implied) {
      const grouped: TemplateNode[] = [child];
      index += 1;
      while (index < children.length) {
        const next = children[index] as TemplateNode;
        if (impliedContainerFor(next) === implied) {
          grouped.push(next);
          index += 1;
          continue;
        }
        if (
          whitespaceText(next) &&
          index + 1 < children.length &&
          impliedContainerFor(children[index + 1] as TemplateNode) === implied
        ) {
          grouped.push(next);
          index += 1;
          continue;
        }
        break;
      }
      normalizedChildren.push({ type: "element", tagName: implied, attrs: [], children: grouped });
      continue;
    }
    if (child.type === "text") {
      if (!whitespaceText(child)) return treeError(node, child);
    } else if (!tableAllowedChildren.has(child.tagName)) {
      return treeError(node, child);
    }
    normalizedChildren.push(child);
    index += 1;
  }
  return ok({ ...node, children: normalizedChildren });
};

export const normalizeHtmlTree = (root: ElementNode): Result<ElementNode, CompilerError> => normalizeElement(root);
