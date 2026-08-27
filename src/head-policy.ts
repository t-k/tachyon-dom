import { sanitizeElementUrlAttributes } from "./url-policy.js";

const headAttributeNamePattern = /^[A-Za-z_:][A-Za-z0-9_.:-]*$/;

export const sanitizeHeadAttributes = (
  element: "meta" | "link" | "script",
  attributes: Readonly<Record<string, string>>,
  options: { dropOnUnsafeUrl?: boolean } = {},
): Record<string, string> | undefined => {
  const normalizedNames = new Set<string>();
  const safeNames = Object.fromEntries(
    Object.entries(attributes).filter(([name]) => {
      if (!headAttributeNamePattern.test(name) || name.toLowerCase().startsWith("on")) return false;
      const normalizedName = name.toLowerCase();
      if (normalizedNames.has(normalizedName)) return false;
      normalizedNames.add(normalizedName);
      return true;
    }),
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
