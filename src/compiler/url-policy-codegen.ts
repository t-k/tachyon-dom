import { decideUrlAttribute } from "../url-policy.js";

export const generatedUrlAttributeHelperLines = [
  `const __tachyonDecideUrlAttribute = ${decideUrlAttribute.toString()};`,
  `const __tachyonSafeUrlAttribute = (element, attribute, value) => { const normalizedElement = element.toLowerCase(); const normalizedAttribute = attribute.toLowerCase(); const purpose = normalizedAttribute === "src" || ((normalizedAttribute === "href" || normalizedAttribute === "xlink:href") && ["link", "script", "use", "image"].includes(normalizedElement)) ? "subresource" : normalizedAttribute === "action" || normalizedAttribute === "formaction" ? "form-submission" : "document-navigation"; const result = __tachyonDecideUrlAttribute({ element: normalizedElement, attribute: normalizedAttribute, purpose, value: String(value) }); if (!result.ok) throw new TypeError(result.message); return result.value; };`,
] as const;
