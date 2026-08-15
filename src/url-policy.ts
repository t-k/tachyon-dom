import { err, ok, type Result } from "./result.js";

export type UrlAttributeName =
  | "href"
  | "src"
  | "action"
  | "formaction"
  | "xlink:href"
  | "data"
  | "poster"
  | "srcset"
  | "content";
export type UrlPurpose = "document-navigation" | "subresource" | "form-submission";
export type UrlAttributeKind = "url" | "srcset";

export type UrlAttributeContext = {
  element: string;
  attribute: UrlAttributeName;
  purpose: UrlPurpose;
  allowedOrigins?: readonly string[];
  value: string;
};

export type UrlPolicyDecision = { ok: true; value: string } | { ok: false; message: string };

export type UrlAttributeRule = {
  attribute: Exclude<UrlAttributeName, "content">;
  elements: "*" | readonly string[];
  kind: UrlAttributeKind;
  purpose: UrlPurpose;
};

export const urlAttributeRules: readonly UrlAttributeRule[] = [
  { attribute: "data", elements: ["object"], kind: "url", purpose: "subresource" },
  { attribute: "poster", elements: ["video", "audio"], kind: "url", purpose: "subresource" },
  { attribute: "srcset", elements: ["img", "source"], kind: "srcset", purpose: "subresource" },
  {
    attribute: "href",
    elements: ["link", "script", "use", "image"],
    kind: "url",
    purpose: "subresource",
  },
  { attribute: "xlink:href", elements: ["use", "image"], kind: "url", purpose: "subresource" },
  { attribute: "action", elements: "*", kind: "url", purpose: "form-submission" },
  { attribute: "formaction", elements: "*", kind: "url", purpose: "form-submission" },
  { attribute: "src", elements: "*", kind: "url", purpose: "subresource" },
  { attribute: "href", elements: "*", kind: "url", purpose: "document-navigation" },
  { attribute: "xlink:href", elements: "*", kind: "url", purpose: "document-navigation" },
] as const;

const ruleForAttribute = (element: string, attribute: string): UrlAttributeRule | undefined => {
  const normalizedElement = element.toLowerCase();
  const normalizedAttribute = attribute.toLowerCase();
  return urlAttributeRules.find(
    (rule) =>
      rule.attribute === normalizedAttribute && (rule.elements === "*" || rule.elements.includes(normalizedElement)),
  );
};

export const urlPurposeForAttribute = (element: string, attribute: string): UrlPurpose | undefined =>
  ruleForAttribute(element, attribute)?.purpose;

export const urlKindForAttribute = (element: string, attribute: string): UrlAttributeKind | undefined =>
  ruleForAttribute(element, attribute)?.kind;

const unsafeDecision = (attribute: string): UrlPolicyDecision => ({
  ok: false,
  message: `Unsafe URL for ${attribute}.`,
});

const hasControlCharacter = (value: string): boolean =>
  Array.from(value).some((character) => {
    const code = character.charCodeAt(0);
    return code <= 0x1f || code === 0x7f;
  });

const decideSingleUrl = (context: {
  attribute: string;
  purpose: UrlPurpose;
  allowedOrigins?: readonly string[];
  value: string;
}): UrlPolicyDecision => {
  const normalized = context.value.trim();
  if (hasControlCharacter(normalized) || normalized.includes("\\") || normalized.startsWith("//")) {
    return unsafeDecision(context.attribute);
  }

  let decoded: string | undefined;
  try {
    decoded = decodeURIComponent(normalized);
  } catch {
    // Raw checks remain authoritative. Decoding is an additional check only when the input is decodable.
    decoded = undefined;
  }
  if (decoded !== undefined && (hasControlCharacter(decoded) || decoded.includes("\\") || decoded.startsWith("//"))) {
    return unsafeDecision(context.attribute);
  }
  if (normalized === "") return { ok: true, value: normalized };

  const rawScheme = /^([A-Za-z][A-Za-z0-9+.-]*):/.exec(normalized)?.[1]?.toLowerCase();
  const decodedScheme = decoded ? /^([A-Za-z][A-Za-z0-9+.-]*):/.exec(decoded)?.[1]?.toLowerCase() : undefined;
  const scheme = rawScheme ?? decodedScheme;
  if (!scheme) {
    if (
      context.allowedOrigins !== undefined &&
      !normalized.startsWith("/") &&
      !(context.purpose === "document-navigation" && normalized.startsWith("#"))
    ) {
      return unsafeDecision(context.attribute);
    }
    return { ok: true, value: normalized };
  }
  if ((scheme === "mailto" || scheme === "tel") && context.purpose === "document-navigation") {
    return { ok: true, value: normalized };
  }
  if (scheme !== "http" && scheme !== "https") return unsafeDecision(context.attribute);
  try {
    const url = new URL(normalized);
    if (context.allowedOrigins !== undefined && !context.allowedOrigins.includes(url.origin)) {
      return unsafeDecision(context.attribute);
    }
    return { ok: true, value: normalized };
  } catch {
    return unsafeDecision(context.attribute);
  }
};

const validSrcsetDescriptor = (descriptor: string): boolean => {
  if (/^[1-9]\d*w$/.test(descriptor)) return true;
  if (!/^(?:\d+(?:\.\d+)?|\.\d+)x$/.test(descriptor)) return false;
  return Number.parseFloat(descriptor.slice(0, -1)) > 0;
};

export const decideSrcset = (context: {
  attribute?: string;
  allowedOrigins?: readonly string[];
  value: string;
}): UrlPolicyDecision => {
  const attribute = context.attribute ?? "srcset";
  const normalized = context.value.trim();
  if (normalized === "") return unsafeDecision(attribute);
  const candidates = normalized.split(",");
  for (const candidate of candidates) {
    const tokens = candidate.trim().split(/[\t\n\f\r ]+/);
    const url = tokens[0];
    if (!url || tokens.length > 2 || (tokens[1] !== undefined && !validSrcsetDescriptor(tokens[1]))) {
      return unsafeDecision(attribute);
    }
    const decision = decideSingleUrl({
      attribute,
      purpose: "subresource",
      value: url,
      ...(context.allowedOrigins === undefined ? {} : { allowedOrigins: context.allowedOrigins }),
    });
    if (!decision.ok) return decision;
  }
  return { ok: true, value: normalized };
};

export const decideUrlAttribute = (context: {
  element: string;
  attribute: string;
  purpose: string;
  allowedOrigins?: readonly string[];
  value: string;
}): UrlPolicyDecision => {
  const rule = ruleForAttribute(context.element, context.attribute);
  if (!rule || rule.purpose !== context.purpose) {
    return { ok: false, message: `Invalid URL context for ${context.attribute}.` };
  }
  return rule.kind === "srcset"
    ? decideSrcset({
        attribute: context.attribute,
        value: context.value,
        ...(context.allowedOrigins === undefined ? {} : { allowedOrigins: context.allowedOrigins }),
      })
    : decideSingleUrl({
        attribute: context.attribute,
        purpose: rule.purpose,
        value: context.value,
        ...(context.allowedOrigins === undefined ? {} : { allowedOrigins: context.allowedOrigins }),
      });
};

export class UnsafeUrlError extends TypeError {
  readonly attribute: UrlAttributeName;

  constructor(attribute: UrlAttributeName, message = `Unsafe URL for ${attribute}.`) {
    super(message);
    this.name = "UnsafeUrlError";
    this.attribute = attribute;
  }
}

export const sanitizeUrlAttribute = (context: UrlAttributeContext): Result<string, UnsafeUrlError> => {
  const decision = decideUrlAttribute(context);
  return decision.ok ? ok(decision.value) : err(new UnsafeUrlError(context.attribute, decision.message));
};

export const sanitizeUrlAttributeValue = (
  element: string,
  attribute: string,
  value: string,
  allowedOrigins?: readonly string[],
): string => {
  const purpose = urlPurposeForAttribute(element, attribute);
  if (!purpose) return value;
  const decision = decideUrlAttribute({
    element,
    attribute,
    purpose,
    value,
    ...(allowedOrigins === undefined ? {} : { allowedOrigins }),
  });
  if (!decision.ok) throw new UnsafeUrlError(attribute.toLowerCase() as UrlAttributeName, decision.message);
  return decision.value;
};

export const sanitizeMetaRefreshContent = (
  value: string,
  allowedOrigins?: readonly string[],
): Result<string, UnsafeUrlError> => {
  if (hasControlCharacter(value)) return err(new UnsafeUrlError("content"));
  const urlTokens = value.match(/\burl\s*=/gi) ?? [];
  const match = /^\s*\d+(?:\.\d+)?\s*(?:;\s*url\s*=\s*(?:"([^"]*)"|'([^']*)'|([^;]*?))\s*)?$/i.exec(value);
  if (!match || urlTokens.length > 1) return err(new UnsafeUrlError("content"));
  const target = match[1] ?? match[2] ?? match[3];
  if (target === undefined) return ok(value.trim());
  const decision = decideSingleUrl({
    attribute: "content",
    purpose: "document-navigation",
    value: target.trim(),
    ...(allowedOrigins === undefined ? {} : { allowedOrigins }),
  });
  return decision.ok ? ok(value.trim()) : err(new UnsafeUrlError("content", decision.message));
};

export const sanitizeElementUrlAttributes = (
  element: string,
  attributes: Readonly<Record<string, string>>,
  allowedOrigins?: readonly string[],
): Result<Record<string, string>, UnsafeUrlError> => {
  const normalizedElement = element.toLowerCase();
  const output = { ...attributes };
  if (normalizedElement === "meta") {
    const httpEquiv = Object.entries(attributes).find(([name]) => name.toLowerCase() === "http-equiv")?.[1];
    const contentEntry = Object.entries(attributes).find(([name]) => name.toLowerCase() === "content");
    if (httpEquiv?.trim().toLowerCase() === "refresh" && contentEntry) {
      const result = sanitizeMetaRefreshContent(contentEntry[1], allowedOrigins);
      if (!result.ok) return result;
      output[contentEntry[0]] = result.value;
    }
  }
  for (const [name, value] of Object.entries(attributes)) {
    if (!urlPurposeForAttribute(normalizedElement, name)) continue;
    try {
      output[name] = sanitizeUrlAttributeValue(normalizedElement, name, value, allowedOrigins);
    } catch (error) {
      return err(error instanceof UnsafeUrlError ? error : new UnsafeUrlError(name.toLowerCase() as UrlAttributeName));
    }
  }
  return ok(output);
};
