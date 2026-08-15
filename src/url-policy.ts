import { err, ok, type Result } from "./result.js";

export type UrlAttributeName = "href" | "src" | "action" | "formaction" | "xlink:href";
export type UrlPurpose = "document-navigation" | "subresource" | "form-submission";

export type UrlAttributeContext = {
  element: string;
  attribute: UrlAttributeName;
  purpose: UrlPurpose;
  allowedOrigins?: readonly string[];
  value: string;
};

type UrlPolicyDecision = { ok: true; value: string } | { ok: false; message: string };

const decideUrlAttribute = (context: {
  element: string;
  attribute: string;
  purpose: string;
  allowedOrigins?: readonly string[];
  value: string;
}): UrlPolicyDecision => {
  const element = context.element.toLowerCase();
  const attribute = context.attribute.toLowerCase();
  const purpose = context.purpose;
  const expectedPurpose =
    attribute === "src" ||
    ((attribute === "href" || attribute === "xlink:href") &&
      (element === "link" || element === "script" || element === "use" || element === "image"))
      ? "subresource"
      : attribute === "action" || attribute === "formaction"
        ? "form-submission"
        : attribute === "href" || attribute === "xlink:href"
          ? "document-navigation"
          : undefined;
  if (!expectedPurpose || purpose !== expectedPurpose) {
    return { ok: false, message: `Invalid URL context for ${context.attribute}.` };
  }

  const normalized = Array.from(context.value)
    .filter((character) => {
      const code = character.charCodeAt(0);
      return code > 0x1f && code !== 0x7f;
    })
    .join("")
    .trim();
  let decoded: string;
  try {
    decoded = decodeURIComponent(normalized);
  } catch {
    return { ok: false, message: `Unsafe URL for ${context.attribute}.` };
  }
  const decodedHasControlOrBackslash = Array.from(decoded).some((character) => {
    const code = character.charCodeAt(0);
    return code <= 0x1f || code === 0x7f || character === "\\";
  });
  if (decodedHasControlOrBackslash || normalized.startsWith("//") || decoded.startsWith("//")) {
    return { ok: false, message: `Unsafe URL for ${context.attribute}.` };
  }
  if (normalized === "") {
    return { ok: true, value: normalized };
  }

  const decodedScheme = /^([A-Za-z][A-Za-z0-9+.-]*):/.exec(decoded)?.[1]?.toLowerCase();
  const scheme = /^([A-Za-z][A-Za-z0-9+.-]*):/.exec(normalized)?.[1]?.toLowerCase() ?? decodedScheme;
  if (!scheme) {
    if (
      context.allowedOrigins !== undefined &&
      !normalized.startsWith("/") &&
      !(purpose === "document-navigation" && normalized.startsWith("#"))
    ) {
      return { ok: false, message: `Unsafe URL for ${context.attribute}.` };
    }
    return { ok: true, value: normalized };
  }
  if ((scheme === "mailto" || scheme === "tel") && purpose === "document-navigation") {
    return { ok: true, value: normalized };
  }
  if (scheme !== "http" && scheme !== "https") {
    return { ok: false, message: `Unsafe URL for ${context.attribute}.` };
  }
  try {
    const url = new URL(normalized);
    if (context.allowedOrigins !== undefined && !context.allowedOrigins.includes(url.origin)) {
      return { ok: false, message: `Unsafe URL for ${context.attribute}.` };
    }
    return { ok: true, value: normalized };
  } catch {
    return { ok: false, message: `Unsafe URL for ${context.attribute}.` };
  }
};

export class UnsafeUrlError extends TypeError {
  readonly attribute: UrlAttributeName;

  constructor(attribute: UrlAttributeName, message = `Unsafe URL for ${attribute}.`) {
    super(message);
    this.name = "UnsafeUrlError";
    this.attribute = attribute;
  }
}

export const urlPurposeForAttribute = (element: string, attribute: string): UrlPurpose | undefined => {
  const normalizedElement = element.toLowerCase();
  const normalizedAttribute = attribute.toLowerCase();
  if (
    normalizedAttribute === "src" ||
    ((normalizedAttribute === "href" || normalizedAttribute === "xlink:href") &&
      (normalizedElement === "link" ||
        normalizedElement === "script" ||
        normalizedElement === "use" ||
        normalizedElement === "image"))
  ) {
    return "subresource";
  }
  if (normalizedAttribute === "action" || normalizedAttribute === "formaction") return "form-submission";
  return normalizedAttribute === "href" || normalizedAttribute === "xlink:href" ? "document-navigation" : undefined;
};

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
  const result = sanitizeUrlAttribute({
    element,
    attribute: attribute.toLowerCase() as UrlAttributeName,
    purpose,
    value,
    ...(allowedOrigins === undefined ? {} : { allowedOrigins }),
  });
  if (!result.ok) throw result.error;
  return result.value;
};

export const generatedUrlAttributeHelperLines = [
  `const __tachyonDecideUrlAttribute = ${decideUrlAttribute.toString()};`,
  `const __tachyonSafeUrlAttribute = (element, attribute, value) => { const normalizedElement = element.toLowerCase(); const normalizedAttribute = attribute.toLowerCase(); const purpose = normalizedAttribute === "src" || ((normalizedAttribute === "href" || normalizedAttribute === "xlink:href") && ["link", "script", "use", "image"].includes(normalizedElement)) ? "subresource" : normalizedAttribute === "action" || normalizedAttribute === "formaction" ? "form-submission" : "document-navigation"; const result = __tachyonDecideUrlAttribute({ element: normalizedElement, attribute: normalizedAttribute, purpose, value: String(value) }); if (!result.ok) throw new TypeError(result.message); return result.value; };`,
] as const;
