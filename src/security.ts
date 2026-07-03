import { unsafeHtml, type TrustedHtml } from "./router.js";
import { timingSafeEqual } from "./constant-time.js";

export type CsrfOptions = {
  token: string;
  headerName?: string;
  fieldName?: string;
};

export type SanitizeHtmlOptions = {
  allowedTags?: readonly string[];
  allowedAttributes?: readonly string[];
  allowedUrlOrigins?: readonly string[];
  adapter?: HtmlSanitizer;
};

export type HtmlSanitizer = (markup: string) => TrustedHtml;

const defaultAllowedTags = [
  "a",
  "article",
  "aside",
  "b",
  "blockquote",
  "br",
  "button",
  "code",
  "div",
  "em",
  "footer",
  "form",
  "h1",
  "h2",
  "h3",
  "h4",
  "h5",
  "h6",
  "header",
  "i",
  "img",
  "input",
  "label",
  "li",
  "main",
  "nav",
  "ol",
  "option",
  "p",
  "pre",
  "section",
  "select",
  "small",
  "span",
  "strong",
  "textarea",
  "ul",
];

const defaultAllowedAttributes = [
  "action",
  "alt",
  "aria-label",
  "aria-labelledby",
  "checked",
  "class",
  "data-prefetch",
  "disabled",
  "for",
  "href",
  "id",
  "method",
  "name",
  "placeholder",
  "role",
  "src",
  "type",
  "value",
];

const escapeAttribute = (value: string): string =>
  value.replaceAll("&", "&amp;").replaceAll(`"`, "&quot;").replaceAll("<", "&lt;");

const escapeText = (value: string): string =>
  value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll(`"`, "&quot;")
    .replaceAll("'", "&#39;");

const isSafeUrl = (value: string, allowedOrigins: readonly string[] = []): boolean => {
  const trimmed = value.trim().toLowerCase();
  if (trimmed.startsWith("/") && !trimmed.startsWith("//")) {
    try {
      const decoded = decodeURIComponent(trimmed);
      return !decoded.startsWith("//") && !decoded.includes("\\");
    } catch {
      return false;
    }
  }
  if (trimmed.startsWith("#") || trimmed.startsWith("mailto:")) {
    return true;
  }
  try {
    const url = new URL(value);
    return (url.protocol === "https:" || url.protocol === "http:") && allowedOrigins.includes(url.origin);
  } catch {
    return false;
  }
};

const sanitizeAttributes = (
  raw: string,
  allowedAttributes: Set<string>,
  allowedUrlOrigins: readonly string[],
): string =>
  Array.from(raw.matchAll(/([:\w-]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/g))
    .flatMap((match) => {
      const name = match[1]?.toLowerCase();
      if (!name || name.startsWith("on") || !allowedAttributes.has(name)) {
        return [];
      }
      const value = match[2] ?? match[3] ?? match[4] ?? "";
      if ((name === "href" || name === "src" || name === "action") && value && !isSafeUrl(value, allowedUrlOrigins)) {
        return [];
      }
      return value === "" ? [` ${name}`] : [` ${name}="${escapeAttribute(value)}"`];
    })
    .join("");

export const sanitizeHtml = (markup: string, options: SanitizeHtmlOptions = {}): TrustedHtml => {
  if (options.adapter) {
    return options.adapter(markup);
  }
  const allowedTags = new Set(options.allowedTags ?? defaultAllowedTags);
  const allowedAttributes = new Set(options.allowedAttributes ?? defaultAllowedAttributes);
  const allowedUrlOrigins = options.allowedUrlOrigins ?? [];
  const withoutScripts = markup.replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, "");
  const tagPattern = /<\/?([a-zA-Z][\w:-]*)([^>]*)>/g;
  let sanitized = "";
  let lastIndex = 0;
  for (const match of withoutScripts.matchAll(tagPattern)) {
    const index = match.index ?? 0;
    sanitized += escapeText(withoutScripts.slice(lastIndex, index));
    lastIndex = index + match[0].length;
    const rawName = match[1] ?? "";
    const rawAttributes = match[2] ?? "";
    const name = rawName.toLowerCase();
    if (!allowedTags.has(name)) {
      continue;
    }
    if (match[0].startsWith("</")) {
      sanitized += `</${name}>`;
    } else {
      sanitized += `<${name}${sanitizeAttributes(rawAttributes, allowedAttributes, allowedUrlOrigins)}>`;
    }
  }
  sanitized += escapeText(withoutScripts.slice(lastIndex));
  return unsafeHtml(sanitized);
};

export const createHtmlSanitizer =
  (adapter: { sanitize: (markup: string) => string | TrustedHtml }): HtmlSanitizer =>
  (markup) => {
    const result = adapter.sanitize(markup);
    return typeof result === "string" ? unsafeHtml(result) : result;
  };

export const createCsrfToken = (seed?: string): string => {
  if (seed !== undefined) {
    return seed;
  }
  const bytes = new Uint8Array(24);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
};

export const csrfInput = (token: string, fieldName = "_csrf"): TrustedHtml =>
  unsafeHtml(`<input type="hidden" name="${escapeAttribute(fieldName)}" value="${escapeAttribute(token)}">`);

export const verifyCsrfRequest = async (request: Request, options: CsrfOptions): Promise<boolean> => {
  const headerName = options.headerName ?? "x-csrf-token";
  const fieldName = options.fieldName ?? "_csrf";
  if (await timingSafeEqual(request.headers.get(headerName), options.token)) {
    return true;
  }
  const contentType = request.headers.get("content-type") ?? "";
  if (
    contentType.includes("application/x-www-form-urlencoded") ||
    contentType.includes("multipart/form-data") ||
    contentType.includes("text/plain")
  ) {
    const form = await request.clone().formData();
    return await timingSafeEqual(form.get(fieldName), options.token);
  }
  return false;
};
