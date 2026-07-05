import { escapeHtml as escapeText } from "../html-escape.js";

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
const attributeContextPattern = /(?:^|[\s<])(?:[A-Za-z_:][A-Za-z0-9_.:-]*)(?:\s*)=(?:\s*)$/;

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
};

const renderValue = (value: HtmlValue, context: "text" | "attribute"): string => {
  if (value == null || value === false) {
    return "";
  }
  if (Array.isArray(value)) {
    return value.map((item) => renderValue(item, context)).join("");
  }
  if (isHtmlAttribute(value)) {
    return value.toString();
  }
  if (isHtmlFragment(value)) {
    return value.toString();
  }
  if (context === "attribute") {
    return `"${escapeAttribute(value)}"`;
  }
  return escapeText(value);
};

export const rawHtml = (value: string): HtmlFragment => fragment(value);

export const join = (values: readonly HtmlValue[], separator = ""): HtmlFragment =>
  fragment(values.map((value) => renderValue(value, "text")).join(separator));

export const attr = (name: string, value: unknown): HtmlAttribute => {
  assertAttributeName(name);
  if (value == null || value === false) {
    return attributeFragment("");
  }
  if (value === true) {
    return attributeFragment(` ${name}`);
  }
  return attributeFragment(` ${name}="${escapeAttribute(value)}"`);
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
  for (let index = 0; index < strings.length; index += 1) {
    const literal = strings[index] ?? "";
    output += literal;
    if (index < values.length) {
      const context = attributeContextPattern.test(literal) ? "attribute" : "text";
      output += renderValue(values[index], context);
    }
  }
  return fragment(output);
};
