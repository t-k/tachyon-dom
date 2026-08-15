import { Buffer } from "node:buffer";
import { generatedUrlAttributeHelperLines } from "../dist/compiler/url-policy-codegen.js";
import { sanitizeMetaRefreshContent, sanitizeUrlAttributeValue } from "../dist/url-policy.js";

const code = `${generatedUrlAttributeHelperLines.join("\n")}\nexport { __tachyonSafeMetaRefreshContent, __tachyonSafeUrlAttribute };`;
const generated = await import(`data:text/javascript;base64,${Buffer.from(code).toString("base64")}`);

const outcome = (run) => {
  try {
    return { ok: true, value: run() };
  } catch (error) {
    return { ok: false, message: error instanceof Error ? error.message : String(error) };
  }
};

const corpus = [
  ["a", "href", "/safe"],
  ["a", "href", "https://example.com/?q=100%"],
  ["a", "href", "https://example.com/a%zz"],
  ["a", "href", "javascript:alert(1)"],
  ["a", "href", "java%73cript:alert(1)"],
  ["object", "data", "data:text/html,<script>alert(1)</script>"],
  ["audio", "poster", "/poster.jpg"],
  ["img", "srcset", "/a.jpg 1x, /b.jpg 2x"],
  ["img", "srcset", "/a.jpg 1x, javascript:alert(1) 2x"],
];

for (const [element, attribute, value] of corpus) {
  const sourceOutcome = outcome(() => sanitizeUrlAttributeValue(element, attribute, value));
  const generatedOutcome = outcome(() => generated.__tachyonSafeUrlAttribute(element, attribute, value));
  if (JSON.stringify(sourceOutcome) !== JSON.stringify(generatedOutcome)) {
    throw new Error(
      `Built URL policy mismatch for ${element}[${attribute}]=${JSON.stringify(value)}: ${JSON.stringify({ sourceOutcome, generatedOutcome })}`,
    );
  }
}

for (const value of ["0;url=/safe", "5", "0;url=javascript:alert(1)", "0;url=/safe;url=//evil.test"]) {
  const sourceOutcome = outcome(() => {
    const result = sanitizeMetaRefreshContent(value);
    if (!result.ok) throw result.error;
    return result.value;
  });
  const generatedOutcome = outcome(() => generated.__tachyonSafeMetaRefreshContent(value));
  if (JSON.stringify(sourceOutcome) !== JSON.stringify(generatedOutcome)) {
    throw new Error(
      `Built meta refresh policy mismatch for ${JSON.stringify(value)}: ${JSON.stringify({ sourceOutcome, generatedOutcome })}`,
    );
  }
}

console.log("Built URL policy code generation parity verified.");
