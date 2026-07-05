const htmlEscapeMap: Record<string, string> = {
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  '"': "&quot;",
  "'": "&#39;",
};

const htmlEscapePattern = /[&<>"']/;
const htmlEscapeGlobalPattern = /[&<>"']/g;

export const escapeHtml = (value: unknown): string => {
  const text = String(value ?? "");
  return htmlEscapePattern.test(text)
    ? text.replace(htmlEscapeGlobalPattern, (char) => htmlEscapeMap[char] ?? char)
    : text;
};

export const generatedEscapeHtmlHelperLines = [
  `const HTML_ESCAPE = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };`,
  `const HTML_ESCAPE_PATTERN = /[&<>"']/;`,
  `const escapeHtml = (value) => { const text = String(value ?? ""); return HTML_ESCAPE_PATTERN.test(text) ? text.replace(/[&<>"']/g, (char) => HTML_ESCAPE[char]) : text; };`,
];
