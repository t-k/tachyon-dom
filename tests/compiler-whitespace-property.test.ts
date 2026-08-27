import fc from "fast-check";
import { describe, expect, it } from "vitest";

import { compileTemplate, generateServerStreamModule, renderServerTemplate } from "../src/compiler";
import { propertyParameters } from "./fast-check-config";

const whitespaceForms = ["\n  ", "\r\n    ", "\n\t", "\r  "] as const;
const contexts = ["ordinary", "title", "pre", "svg", "math", "foreignObject"] as const;
const policies = ["preserve", "condense"] as const;

const sourceFor = (context: (typeof contexts)[number], content: string): string => {
  if (context === "title" || context === "pre") return `<${context}>${content}</${context}>`;
  if (context === "svg") return `<svg xml:space="preserve"><text>${content}</text></svg>`;
  if (context === "math") return `<math xml:space="preserve"><mtext>${content}</mtext></math>`;
  if (context === "foreignObject") {
    return `<svg xml:space="preserve"><foreignObject><p>${content}</p></foreignObject></svg>`;
  }
  return `<p>${content}</p>`;
};

describe("compiler whitespace bounded properties", () => {
  it("preserves semantic contexts and condenses ordinary contexts", () => {
    fc.assert(
      fc.property(
        fc.constantFrom(...contexts),
        fc.constantFrom(...policies),
        fc.constantFrom(...whitespaceForms),
        (context, policy, whitespace) => {
          const content = `left${whitespace}right`;
          const protectedContext = context === "title" || context === "pre" || context === "svg" || context === "math";
          const expectedContent = policy === "preserve" || protectedContext ? content : "left right";
          const result = compileTemplate(sourceFor(context, content), { whitespace: policy });
          expect(result.ok).toBe(true);
          if (!result.ok) return;
          const serverHtml = renderServerTemplate(result.value, {});
          expect(serverHtml).toBe(result.value.client.templateHtml);
          expect(serverHtml).toContain(expectedContent);
          expect(generateServerStreamModule(result.value)).toContain(JSON.stringify(expectedContent));
        },
      ),
      propertyParameters({ seed: 0x7a11c0de, numRuns: 128 }),
    );
  });
});
