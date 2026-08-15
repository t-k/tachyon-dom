import { escapeHtml as escapeText } from "../html-escape.js";
import { validateAttributeName } from "../attribute-policy.js";
import { sanitizeUrlAttributeValue, urlPurposeForAttribute } from "../url-policy.js";

const htmlFragmentBrand = Symbol("tachyon.htmlFragment");
const htmlAttributeBrand = Symbol("tachyon.htmlAttribute");

export type HtmlFragment = {
  readonly [htmlFragmentBrand]: true;
  toString(): string;
};

export type HtmlAttribute = {
  readonly [htmlAttributeBrand]: true;
  toString(): string;
};

type HtmlValue = HtmlFragment | HtmlAttribute | readonly HtmlValue[] | string | number | boolean | null | undefined;
type ClassValue = string | number | false | null | undefined | readonly ClassValue[];

const attributeNamePattern = /^[A-Za-z_:][A-Za-z0-9_.:-]*$/;

type HtmlState =
  | "text"
  | "tag"
  | "before-attribute-value"
  | "double-quoted-attribute"
  | "single-quoted-attribute"
  | "unquoted-attribute"
  | "comment";

const fragment = (value: string): HtmlFragment => ({
  [htmlFragmentBrand]: true,
  toString: () => value,
});

const attributeFragment = (value: string): HtmlAttribute => ({
  [htmlAttributeBrand]: true,
  toString: () => value,
});

const isHtmlFragment = (value: unknown): value is HtmlFragment =>
  Boolean(value && typeof value === "object" && (value as Record<symbol, unknown>)[htmlFragmentBrand] === true);

const isHtmlAttribute = (value: unknown): value is HtmlAttribute =>
  Boolean(value && typeof value === "object" && (value as Record<symbol, unknown>)[htmlAttributeBrand] === true);

const attributeEscapeMap: Record<string, string> = {
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  '"': "&quot;",
  "'": "&#39;",
  "`": "&#96;",
};

const attributeEscapePattern = /[&<>"'`]/;
const attributeEscapeGlobalPattern = /[&<>"'`]/g;

const escapeAttribute = (value: unknown): string => {
  const text = String(value ?? "");
  return attributeEscapePattern.test(text)
    ? text.replace(attributeEscapeGlobalPattern, (char) => attributeEscapeMap[char] ?? char)
    : text;
};

const assertAttributeName = (name: string): void => {
  if (!attributeNamePattern.test(name)) {
    throw new Error(`Invalid attribute name: ${name}`);
  }
  const validatedName = validateAttributeName(name);
  if (!validatedName.ok) {
    throw validatedName.error;
  }
};

const renderTextValue = (value: HtmlValue): string => {
  if (value == null || value === false) {
    return "";
  }
  if (Array.isArray(value)) {
    return value.map(renderTextValue).join("");
  }
  if (isHtmlAttribute(value)) {
    throw new TypeError("Attribute fragments can only be interpolated inside an opening tag");
  }
  if (isHtmlFragment(value)) {
    return value.toString();
  }
  return escapeText(value);
};

const renderAttributeValue = (value: HtmlValue): string => {
  if (value == null || value === false) {
    return "";
  }
  if (Array.isArray(value)) {
    return value.map(renderAttributeValue).join("");
  }
  if (isHtmlFragment(value)) {
    throw new TypeError("Trusted HTML fragments can only be interpolated in text context");
  }
  if (isHtmlAttribute(value)) {
    throw new TypeError("Attribute fragments can only be interpolated inside an opening tag");
  }
  return escapeAttribute(value);
};

const renderTagValue = (value: HtmlValue): string => {
  if (value == null || value === false) {
    return "";
  }
  if (Array.isArray(value)) {
    return value.map(renderTagValue).join("");
  }
  if (isHtmlAttribute(value)) {
    return value.toString();
  }
  if (isHtmlFragment(value)) {
    throw new TypeError("Trusted HTML fragments can only be interpolated in text context");
  }
  throw new TypeError("Only attribute fragments can be interpolated directly inside an opening tag");
};

const containsHtmlFragment = (value: HtmlValue): boolean =>
  isHtmlFragment(value) || (Array.isArray(value) && value.some(containsHtmlFragment));

const plainAttributeValue = (value: HtmlValue): string => {
  if (value == null || value === false) return "";
  if (Array.isArray(value)) return value.map(plainAttributeValue).join("");
  if (isHtmlFragment(value)) {
    throw new TypeError("Trusted HTML fragments can only be interpolated in text context");
  }
  if (isHtmlAttribute(value)) {
    throw new TypeError("Attribute fragments can only be interpolated inside an opening tag");
  }
  return String(value);
};

const currentUrlAttributeContext = (
  output: string,
): { element: string; attribute: string; prefix: string } | undefined => {
  const tagStart = output.lastIndexOf("<");
  if (tagStart < 0) return undefined;
  const openTag = output.slice(tagStart);
  const element = /^<\s*([A-Za-z][A-Za-z0-9:-]*)/.exec(openTag)?.[1];
  const attributeMatch = /([A-Za-z_:][A-Za-z0-9_.:-]*)\s*=\s*(?:(["'])([^"']*)?)?$/.exec(openTag);
  const attribute = attributeMatch?.[1];
  return element && attribute && urlPurposeForAttribute(element, attribute)
    ? { element, attribute, prefix: attributeMatch?.[3] ?? "" }
    : undefined;
};

const isHtmlWhitespace = (char: string): boolean =>
  char === " " || char === "\t" || char === "\n" || char === "\r" || char === "\f";

const renderValue = (value: HtmlValue, state: HtmlState, nextLiteral: string, isLastValue: boolean): string => {
  if (state === "text") {
    return renderTextValue(value);
  }
  if (state === "tag") {
    return renderTagValue(value);
  }
  if (state === "double-quoted-attribute" || state === "single-quoted-attribute") {
    return renderAttributeValue(value);
  }
  if (state === "unquoted-attribute") {
    throw new TypeError("Interpolation inside an unquoted attribute value is not supported; quote the complete value");
  }
  if (state === "comment") {
    throw new TypeError("Interpolation inside an HTML comment is not supported");
  }
  const nextStartsBoundary =
    nextLiteral === ""
      ? isLastValue
      : isHtmlWhitespace(nextLiteral[0] as string) || nextLiteral.startsWith(">") || nextLiteral.startsWith("/>");
  if (!nextStartsBoundary) {
    throw new TypeError("Interpolated attribute values with literal suffixes must be quoted in the template");
  }
  return `"${renderAttributeValue(value)}"`;
};

const scanHtmlState = (input: string, initialState: HtmlState): HtmlState => {
  let state = initialState;
  for (let index = 0; index < input.length; index += 1) {
    const char = input[index] as string;
    if (state === "comment") {
      if (input.startsWith("-->", index)) {
        state = "text";
        index += 2;
      }
      continue;
    }
    if (state === "text") {
      if (input.startsWith("<!--", index)) {
        state = "comment";
        index += 3;
      } else if (char === "<") {
        state = "tag";
      }
      continue;
    }
    if (state === "double-quoted-attribute") {
      if (char === '"') {
        state = "tag";
      }
      continue;
    }
    if (state === "single-quoted-attribute") {
      if (char === "'") {
        state = "tag";
      }
      continue;
    }
    if (state === "before-attribute-value") {
      if (isHtmlWhitespace(char)) {
        continue;
      }
      if (char === '"') {
        state = "double-quoted-attribute";
      } else if (char === "'") {
        state = "single-quoted-attribute";
      } else if (char === ">") {
        state = "text";
      } else {
        state = "unquoted-attribute";
      }
      continue;
    }
    if (state === "unquoted-attribute") {
      if (isHtmlWhitespace(char)) {
        state = "tag";
      } else if (char === ">") {
        state = "text";
      }
      continue;
    }
    if (char === ">") {
      state = "text";
    } else if (char === "=") {
      state = "before-attribute-value";
    }
  }
  return state;
};

export const rawHtml = (value: string): HtmlFragment => fragment(value);

export const join = (values: readonly HtmlValue[], separator = ""): HtmlFragment =>
  fragment(values.map(renderTextValue).join(separator));

export const attr = (name: string, value: unknown): HtmlAttribute => {
  assertAttributeName(name);
  if (value == null || value === false) {
    return attributeFragment("");
  }
  if (value === true) {
    return attributeFragment(` ${name}`);
  }
  const normalizedName = name.toLowerCase();
  const defaultElement =
    normalizedName === "src"
      ? "img"
      : normalizedName === "action"
        ? "form"
        : normalizedName === "formaction"
          ? "button"
          : "a";
  const safeValue = urlPurposeForAttribute(defaultElement, normalizedName)
    ? sanitizeUrlAttributeValue(defaultElement, normalizedName, String(value))
    : value;
  return attributeFragment(` ${name}="${escapeAttribute(safeValue)}"`);
};

export const booleanAttr = (name: string, enabled: boolean | null | undefined): HtmlAttribute => {
  assertAttributeName(name);
  return enabled ? attributeFragment(` ${name}`) : attributeFragment("");
};

export const classList = (...values: readonly ClassValue[]): string => {
  const classes: string[] = [];
  const collect = (value: ClassValue): void => {
    if (!value) {
      return;
    }
    if (Array.isArray(value)) {
      for (const item of value) {
        collect(item);
      }
      return;
    }
    classes.push(String(value));
  };
  for (const value of values) {
    collect(value);
  }
  return classes.join(" ");
};

export const html = (strings: TemplateStringsArray, ...values: readonly HtmlValue[]): HtmlFragment => {
  let output = "";
  let state: HtmlState = "text";
  for (let index = 0; index < strings.length; index += 1) {
    const literal = strings[index] ?? "";
    output += literal;
    state = scanHtmlState(literal, state);
    if (index < values.length) {
      const value = values[index];
      const interpolationState = state;
      const urlContext =
        state === "before-attribute-value" || state === "double-quoted-attribute" || state === "single-quoted-attribute"
          ? currentUrlAttributeContext(output)
          : undefined;
      const nextLiteral = strings[index + 1] ?? "";
      if (
        urlContext &&
        state !== "before-attribute-value" &&
        (urlContext.prefix !== "" || !nextLiteral.startsWith(state === "double-quoted-attribute" ? '"' : "'"))
      ) {
        throw new TypeError("URL attribute interpolation must provide the complete value");
      }
      const safeValue = urlContext
        ? sanitizeUrlAttributeValue(urlContext.element, urlContext.attribute, plainAttributeValue(value))
        : value;
      const rendered = renderValue(safeValue, state, nextLiteral, index === values.length - 1);
      output += rendered;
      if (interpolationState === "before-attribute-value") {
        state = "tag";
      } else if (interpolationState === "text" && containsHtmlFragment(value)) {
        state = scanHtmlState(rendered, state);
      }
    }
  }
  return fragment(output);
};
