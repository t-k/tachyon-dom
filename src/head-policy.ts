import { sanitizeElementUrlAttributes } from "./url-policy.js";

const headAttributeNamePattern = /^[A-Za-z_:][A-Za-z0-9_.:-]*$/;

export const sanitizeHeadAttributes = (
  element: "meta" | "link" | "script",
  attributes: Readonly<Record<string, string>>,
  options: { dropOnUnsafeUrl?: boolean } = {},
): Record<string, string> | undefined => {
  const safeNames = Object.fromEntries(
    Object.entries(attributes).filter(
      ([name]) => headAttributeNamePattern.test(name) && !name.toLowerCase().startsWith("on"),
    ),
  );
  while (true) {
    const result = sanitizeElementUrlAttributes(element, safeNames);
    if (result.ok) return result.value;
    if (options.dropOnUnsafeUrl) return undefined;
    const unsafeName = Object.keys(safeNames).find(
      (name) => name.toLowerCase() === result.error.attribute.toLowerCase(),
    );
    if (!unsafeName) return safeNames;
    delete safeNames[unsafeName];
  }
};
