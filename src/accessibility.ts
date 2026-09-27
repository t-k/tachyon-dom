import { diagnoseTachyonSfc, locateOffset, type TemplateDiagnostic } from "./diagnostics.js";
import { readExpressionAttribute, textExpressionSegments } from "./compiler/utils.js";
import type { Attribute, ElementNode, TemplateNode } from "./compiler/types.js";
import { ok, type Result } from "./result.js";

export type AccessibilityDiagnostic = TemplateDiagnostic & {
  ruleId: "img-alt" | "img-alt-dynamic" | "input-image-name" | "control-name" | "button-name";
  confidence: "certain" | "needs-review";
};

const attribute = (node: ElementNode, name: string): Attribute | undefined =>
  node.attrs.find((candidate) => candidate.name.toLowerCase() === name);

const staticValue = (node: ElementNode, name: string): string | undefined => {
  const value = attribute(node, name)?.value;
  return typeof value === "string" && readExpressionAttribute(value) === undefined ? value : undefined;
};

type NameEvidence = "none" | "dynamic" | "static";

const combineEvidence = (left: NameEvidence, right: NameEvidence): NameEvidence =>
  left === "static" || right === "static" ? "static" : left === "dynamic" || right === "dynamic" ? "dynamic" : "none";

const valueEvidence = (value: string | true | undefined): NameEvidence => {
  if (typeof value !== "string") return "none";
  if (readExpressionAttribute(value) !== undefined) return "dynamic";
  return value.trim().length > 0 ? "static" : "none";
};

const nameAttributeEvidence = (node: ElementNode): NameEvidence =>
  ["aria-label", "aria-labelledby", "title"].reduce<NameEvidence>(
    (evidence, name) => combineEvidence(evidence, valueEvidence(attribute(node, name)?.value)),
    "none",
  );

const contentEvidence = (node: TemplateNode): NameEvidence => {
  if (node.type === "text") {
    return textExpressionSegments(node.value).reduce<NameEvidence>(
      (evidence, part) => combineEvidence(evidence, part.kind === "expression" ? "dynamic" : valueEvidence(part.value)),
      "none",
    );
  }
  if (staticValue(node, "aria-hidden") === "true" || attribute(node, "hidden")) return "none";
  if (node.tagName.toLowerCase() === "img") {
    return valueEvidence(attribute(node, "alt")?.value);
  }
  const tag = node.tagName.toLowerCase();
  if (tag === "slot" || tag === "outlet") return "dynamic";
  const children = node.children.reduce<NameEvidence>(
    (evidence, child) => combineEvidence(evidence, contentEvidence(child)),
    "none",
  );
  if (["if", "for", "await"].includes(tag) && children !== "none") return "dynamic";
  const ariaHidden = attribute(node, "aria-hidden")?.value;
  if (typeof ariaHidden === "string" && readExpressionAttribute(ariaHidden) !== undefined && children !== "none") {
    return "dynamic";
  }
  return children;
};

/** Audits only rules that the template can determine, and marks uncertain names for manual review. */
export const checkTachyonAccessibility = (
  source: string,
): Result<readonly AccessibilityDiagnostic[], TemplateDiagnostic> => {
  const parsed = diagnoseTachyonSfc(source);
  if (!parsed.ok) return parsed;
  if (parsed.value.scriptOnly) return ok([]);
  const { descriptor, template } = parsed.value;
  const findings: AccessibilityDiagnostic[] = [];
  const labelsFor = new Map<string, NameEvidence>();
  const visitLabels = (node: TemplateNode, conditional = false): void => {
    if (node.type !== "element") return;
    const tag = node.tagName.toLowerCase();
    if (tag === "label") {
      const target = staticValue(node, "for");
      if (target?.trim()) {
        const content = node.children.reduce<NameEvidence>(
          (current, child) => combineEvidence(current, contentEvidence(child)),
          "none",
        );
        const evidence = conditional && content !== "none" ? "dynamic" : content;
        labelsFor.set(target, combineEvidence(labelsFor.get(target) ?? "none", evidence));
      }
    }
    const childConditional = conditional || ["if", "for", "await"].includes(tag);
    node.children.forEach((child) => visitLabels(child, childConditional));
  };
  visitLabels(template.root);

  const add = (
    node: ElementNode,
    ruleId: AccessibilityDiagnostic["ruleId"],
    confidence: AccessibilityDiagnostic["confidence"],
    message: string,
  ): void => {
    const offset = descriptor.mapTemplateOffset(node.start ?? 0);
    const endOffset = descriptor.mapTemplateOffset(node.openEnd ?? (node.start ?? 0) + 1);
    const start = locateOffset(source, offset);
    const end = locateOffset(source, endOffset);
    findings.push({
      ruleId,
      confidence,
      message,
      offset,
      endOffset,
      ...start,
      endLine: end.line,
      endColumn: end.column,
    });
  };
  const visit = (node: TemplateNode, insideLabel: NameEvidence): void => {
    if (node.type !== "element") return;
    const tag = node.tagName.toLowerCase();
    if (tag === "img") {
      const alt = attribute(node, "alt");
      if (!alt) {
        const hidden =
          staticValue(node, "aria-hidden") === "true" ||
          ["presentation", "none"].includes(staticValue(node, "role")?.toLowerCase() ?? "");
        add(
          node,
          "img-alt",
          hidden ? "needs-review" : "certain",
          'Add an alt attribute; use alt="" for a decorative image.',
        );
      } else if (typeof alt.value === "string" && readExpressionAttribute(alt.value) !== undefined) {
        add(
          node,
          "img-alt-dynamic",
          "needs-review",
          "Verify that the dynamic alt text describes the image, or resolves to an empty string when decorative.",
        );
      }
    }
    if (tag === "input" || tag === "select" || tag === "textarea") {
      const type = staticValue(node, "type")?.toLowerCase();
      if (tag === "input" && type === "image") {
        const name = combineEvidence(nameAttributeEvidence(node), valueEvidence(attribute(node, "alt")?.value));
        if (name === "dynamic") {
          add(
            node,
            "input-image-name",
            "needs-review",
            "Verify that this image button's dynamic alt describes its action.",
          );
        } else if (name === "none") {
          add(node, "input-image-name", "certain", "Give this image button an accessible name describing its action.");
        }
      }
      if (tag === "input" && type === "button") {
        const name = combineEvidence(nameAttributeEvidence(node), valueEvidence(attribute(node, "value")?.value));
        if (name !== "static")
          add(node, "button-name", "needs-review", "Verify this input button has an accessible name.");
      }
      const nativeButton = tag === "input" && ["button", "submit", "reset", "image"].includes(type ?? "");
      const skipped = tag === "input" && (type === "hidden" || nativeButton);
      const id = staticValue(node, "id");
      const name = combineEvidence(
        combineEvidence(insideLabel, id ? (labelsFor.get(id) ?? "none") : "none"),
        nameAttributeEvidence(node),
      );
      if (!skipped && name !== "static") {
        add(
          node,
          "control-name",
          "needs-review",
          "Verify this form control has an associated label or accessible name; placeholder text is not a label.",
        );
      }
    }
    const childContent = node.children.reduce<NameEvidence>(
      (evidence, child) => combineEvidence(evidence, contentEvidence(child)),
      "none",
    );
    if (tag === "button" && combineEvidence(nameAttributeEvidence(node), childContent) !== "static") {
      add(node, "button-name", "needs-review", "Verify this button has an accessible name.");
    }
    node.children.forEach((child) =>
      visit(child, tag === "label" ? combineEvidence(insideLabel, childContent) : insideLabel),
    );
  };
  visit(template.root, "none");
  return ok(findings);
};

export const formatAccessibilityDiagnostic = (diagnostic: AccessibilityDiagnostic, file = "<template>"): string => {
  const pointer = `${" ".repeat(Math.max(0, diagnostic.column - 1))}^`;
  return `${file}:${diagnostic.line}:${diagnostic.column}: a11y ${diagnostic.ruleId} (${diagnostic.confidence}): ${diagnostic.message}\n${diagnostic.sourceLine}\n${pointer}`;
};
