import { escapeHtml as escapeText } from "../html-escape.js";
import { validateAttributeName } from "../attribute-policy.js";
import { sanitizeMetaRefreshContent, sanitizeUrlAttributeValue, urlPurposeForAttribute } from "../url-policy.js";
import { scanRawText, type RawTextTag, type ScriptDataState } from "../html-raw-text.js";

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
const validatedLiteralTemplates = new WeakSet<TemplateStringsArray>();

type HtmlState =
  | "text"
  | "tag"
  | "before-attribute-value"
  | "double-quoted-attribute"
  | "single-quoted-attribute"
  | "unquoted-attribute"
  | "comment"
  | "raw-text";

type HtmlScanContext = {
  state: HtmlState;
  tagName: string;
  readingTagName: boolean;
  closingTag: boolean;
  rawTextTag: RawTextTag | undefined;
  scriptDataState: ScriptDataState;
};

const createHtmlScanContext = (): HtmlScanContext => ({
  state: "text",
  tagName: "",
  readingTagName: false,
  closingTag: false,
  rawTextTag: undefined,
  scriptDataState: "data",
});

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

const assertSafeLiteralAttributeName = (name: string): void => {
  const validatedName = validateAttributeName(name);
  if (!validatedName.ok) {
    throw validatedName.error;
  }
};

const validateLiteralAttributeNames = (strings: TemplateStringsArray): void => {
  if (validatedLiteralTemplates.has(strings)) return;
  let state: HtmlState = "text";
  let tagNameSeen = false;
  let currentTagName = "";
  let closingTag = false;
  let rawTextTag: RawTextTag | undefined;
  let scriptDataState: ScriptDataState = "data";
  let token = "";
  const finishToken = (): void => {
    if (!token) return;
    if (tagNameSeen) {
      assertSafeLiteralAttributeName(token);
    } else {
      tagNameSeen = true;
      currentTagName = token.toLowerCase();
    }
    token = "";
  };
  for (let stringIndex = 0; stringIndex < strings.length; stringIndex += 1) {
    const input = strings[stringIndex] ?? "";
    for (let index = 0; index < input.length; index += 1) {
      const char = input[index] as string;
      if (state === "raw-text") {
        const scanned = scanRawText(input, index, {
          tagName: rawTextTag ?? "script",
          scriptState: scriptDataState,
        });
        scriptDataState = scanned.state.scriptState;
        if (scanned.closingTagStart === -1) return;
        const closingPrefix = `</${rawTextTag ?? "script"}`;
        state = "tag";
        closingTag = true;
        tagNameSeen = true;
        currentTagName = rawTextTag ?? "";
        rawTextTag = undefined;
        token = "";
        index = scanned.closingTagStart + closingPrefix.length - 1;
        continue;
      }
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
          tagNameSeen = false;
          currentTagName = "";
          closingTag = false;
          token = "";
        }
        continue;
      }
      if (state === "double-quoted-attribute") {
        if (char === '"') state = "tag";
        continue;
      }
      if (state === "single-quoted-attribute") {
        if (char === "'") state = "tag";
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
          if (!closingTag && (currentTagName === "script" || currentTagName === "style")) {
            state = "raw-text";
            rawTextTag = currentTagName;
            scriptDataState = "data";
          } else {
            state = "text";
          }
        } else {
          state = "unquoted-attribute";
        }
        continue;
      }
      if (state === "unquoted-attribute") {
        if (isHtmlWhitespace(char)) {
          state = "tag";
        } else if (char === ">") {
          if (!closingTag && (currentTagName === "script" || currentTagName === "style")) {
            state = "raw-text";
            rawTextTag = currentTagName;
            scriptDataState = "data";
          } else {
            state = "text";
          }
        }
        continue;
      }
      if (char === ">") {
        finishToken();
        if (!closingTag && (currentTagName === "script" || currentTagName === "style")) {
          state = "raw-text";
          rawTextTag = currentTagName;
          scriptDataState = "data";
        } else {
          state = "text";
          rawTextTag = undefined;
        }
      } else if (char === "=") {
        finishToken();
        state = "before-attribute-value";
      } else if (isHtmlWhitespace(char)) {
        finishToken();
      } else if (char === "/") {
        if (!tagNameSeen && token === "") closingTag = true;
        finishToken();
      } else {
        token += char;
      }
    }
    if (stringIndex < strings.length - 1 && state === "before-attribute-value") {
      state = "tag";
    }
  }
  if (state === "tag") finishToken();
  if (Object.isFrozen(strings)) validatedLiteralTemplates.add(strings);
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

const currentAttributeContext = (
  output: string,
): { element: string; attribute: string; prefix: string } | undefined => {
  const tagStart = output.lastIndexOf("<");
  if (tagStart < 0) return undefined;
  const openTag = output.slice(tagStart);
  const element = /^<\s*([A-Za-z][A-Za-z0-9:-]*)/.exec(openTag)?.[1];
  const attributeMatch = /([A-Za-z_:][A-Za-z0-9_.:-]*)\s*=\s*(?:(["'])([^"']*)?)?$/.exec(openTag);
  const attribute = attributeMatch?.[1];
  return element && attribute ? { element, attribute, prefix: attributeMatch?.[3] ?? "" } : undefined;
};

const openingTagAtInterpolation = (output: string, strings: TemplateStringsArray, index: number): string => {
  const tagStart = output.lastIndexOf("<");
  if (tagStart < 0) return "";
  return `${output.slice(tagStart)}${strings.slice(index + 1).join("\0")}`.split(">", 1)[0] ?? "";
};

const hasStaticMetaRefreshMode = (openingTag: string): boolean =>
  /\bhttp-equiv\s*=\s*(?:"\s*refresh\s*"|'\s*refresh\s*'|refresh(?=\s|\/?>))/i.test(openingTag);

const isHtmlWhitespace = (char: string): boolean =>
  char === " " || char === "\t" || char === "\n" || char === "\r" || char === "\f";

const renderValue = (
  value: HtmlValue,
  state: HtmlState,
  nextLiteral: string,
  isLastValue: boolean,
  rawTextTag?: "script" | "style",
): string => {
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
  if (state === "raw-text") {
    throw new TypeError(
      `Interpolation inside <${rawTextTag ?? "script"}> raw text is not supported; serialize data outside raw text`,
    );
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

const scanHtmlState = (input: string, context: HtmlScanContext): void => {
  for (let index = 0; index < input.length; index += 1) {
    const char = input[index] as string;
    if (context.state === "raw-text") {
      const scanned = scanRawText(input, index, {
        tagName: context.rawTextTag ?? "script",
        scriptState: context.scriptDataState,
      });
      context.scriptDataState = scanned.state.scriptState;
      if (scanned.closingTagStart === -1) return;
      const closingPrefix = `</${context.rawTextTag ?? "script"}`;
      context.state = "tag";
      context.tagName = context.rawTextTag ?? "";
      context.readingTagName = false;
      context.closingTag = true;
      context.rawTextTag = undefined;
      index = scanned.closingTagStart + closingPrefix.length - 1;
      continue;
    }
    if (context.state === "comment") {
      if (input.startsWith("-->", index)) {
        context.state = "text";
        index += 2;
      }
      continue;
    }
    if (context.state === "text") {
      if (input.startsWith("<!--", index)) {
        context.state = "comment";
        index += 3;
      } else if (char === "<") {
        context.state = "tag";
        context.tagName = "";
        context.readingTagName = true;
        context.closingTag = false;
      }
      continue;
    }
    if (context.state === "double-quoted-attribute") {
      if (char === '"') {
        context.state = "tag";
      }
      continue;
    }
    if (context.state === "single-quoted-attribute") {
      if (char === "'") {
        context.state = "tag";
      }
      continue;
    }
    if (context.state === "before-attribute-value") {
      if (isHtmlWhitespace(char)) {
        continue;
      }
      if (char === '"') {
        context.state = "double-quoted-attribute";
      } else if (char === "'") {
        context.state = "single-quoted-attribute";
      } else if (char === ">") {
        context.state =
          !context.closingTag && (context.tagName === "script" || context.tagName === "style") ? "raw-text" : "text";
        context.rawTextTag = context.state === "raw-text" ? (context.tagName as "script" | "style") : undefined;
        if (context.state === "raw-text") context.scriptDataState = "data";
      } else {
        context.state = "unquoted-attribute";
      }
      continue;
    }
    if (context.state === "unquoted-attribute") {
      if (isHtmlWhitespace(char)) {
        context.state = "tag";
      } else if (char === ">") {
        context.state =
          !context.closingTag && (context.tagName === "script" || context.tagName === "style") ? "raw-text" : "text";
        context.rawTextTag = context.state === "raw-text" ? (context.tagName as "script" | "style") : undefined;
        if (context.state === "raw-text") context.scriptDataState = "data";
      }
      continue;
    }
    if (context.readingTagName) {
      if (context.tagName === "" && char === "/") {
        context.closingTag = true;
        continue;
      }
      if (isHtmlWhitespace(char) || char === "/" || char === ">") {
        context.readingTagName = false;
      } else {
        context.tagName += char.toLowerCase();
        continue;
      }
    }
    if (char === ">") {
      if (!context.closingTag && (context.tagName === "script" || context.tagName === "style")) {
        context.state = "raw-text";
        context.rawTextTag = context.tagName;
        context.scriptDataState = "data";
      } else {
        context.state = "text";
        context.rawTextTag = undefined;
      }
    } else if (char === "=") {
      context.state = "before-attribute-value";
    }
  }
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
      : normalizedName === "srcset"
        ? "img"
        : normalizedName === "data"
          ? "object"
          : normalizedName === "poster"
            ? "video"
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
  validateLiteralAttributeNames(strings);
  let output = "";
  const context = createHtmlScanContext();
  for (let index = 0; index < strings.length; index += 1) {
    const literal = strings[index] ?? "";
    output += literal;
    scanHtmlState(literal, context);
    if (index < values.length) {
      const value = values[index];
      const interpolationState = context.state;
      const attributeContext =
        context.state === "before-attribute-value" ||
        context.state === "double-quoted-attribute" ||
        context.state === "single-quoted-attribute"
          ? currentAttributeContext(output)
          : undefined;
      const nextLiteral = strings[index + 1] ?? "";
      const openingTag = attributeContext ? openingTagAtInterpolation(output, strings, index) : "";
      if (
        attributeContext?.element.toLowerCase() === "meta" &&
        attributeContext.attribute.toLowerCase() === "http-equiv" &&
        /\bcontent\s*=/i.test(openingTag)
      ) {
        throw new TypeError(
          "Dynamic meta refresh mode cannot be combined with content; use a static http-equiv value.",
        );
      }
      const metaRefreshContext =
        attributeContext?.element.toLowerCase() === "meta" &&
        attributeContext.attribute.toLowerCase() === "content" &&
        hasStaticMetaRefreshMode(openingTag)
          ? attributeContext
          : undefined;
      const urlContext =
        attributeContext && urlPurposeForAttribute(attributeContext.element, attributeContext.attribute)
          ? attributeContext
          : undefined;
      const protectedContext = urlContext ?? metaRefreshContext;
      if (
        protectedContext &&
        context.state !== "before-attribute-value" &&
        (protectedContext.prefix !== "" ||
          !nextLiteral.startsWith(context.state === "double-quoted-attribute" ? '"' : "'"))
      ) {
        throw new TypeError("URL attribute interpolation must provide the complete value");
      }
      let safeValue = value;
      if (urlContext) {
        safeValue = sanitizeUrlAttributeValue(urlContext.element, urlContext.attribute, plainAttributeValue(value));
      } else if (metaRefreshContext) {
        const result = sanitizeMetaRefreshContent(plainAttributeValue(value));
        if (!result.ok) throw result.error;
        safeValue = result.value;
      }
      const rendered = renderValue(
        safeValue,
        context.state,
        nextLiteral,
        index === values.length - 1,
        context.rawTextTag,
      );
      output += rendered;
      if (interpolationState === "before-attribute-value") {
        context.state = "tag";
      } else if (interpolationState === "text" && containsHtmlFragment(value)) {
        scanHtmlState(rendered, context);
      }
    }
  }
  return fragment(output);
};
