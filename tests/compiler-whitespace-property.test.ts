import { describe, expect, it } from "vitest";

import { compileTemplate, generateServerStreamModule, renderServerTemplate } from "../src/compiler";

const seed = 0x7a11c0de;
const caseBudget = 128;

const randomValues = (): (() => number) => {
  let state = seed >>> 0;
  return () => {
    state = (Math.imul(state, 1_664_525) + 1_013_904_223) >>> 0;
    return state;
  };
};

const pick = <Value>(values: readonly Value[], next: () => number): Value => values[next() % values.length] as Value;

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
  it(`preserves semantic contexts and condenses ordinary contexts across ${caseBudget} seeded cases`, () => {
    const next = randomValues();
    for (let index = 0; index < caseBudget; index += 1) {
      const context = pick(contexts, next);
      const policy = pick(policies, next);
      const whitespace = pick(whitespaceForms, next);
      const content = `left${whitespace}right`;
      const protectedContext = context === "title" || context === "pre" || context === "svg" || context === "math";
      const expectedContent = policy === "preserve" || protectedContext ? content : "left right";
      const result = compileTemplate(sourceFor(context, content), { whitespace: policy });
      const message = `seed=${seed} case=${index} context=${context} policy=${policy} whitespace=${JSON.stringify(whitespace)}`;
      expect(result.ok, message).toBe(true);
      if (!result.ok) continue;
      const serverHtml = renderServerTemplate(result.value, {});
      expect(serverHtml, message).toBe(result.value.client.templateHtml);
      expect(serverHtml, message).toContain(expectedContent);
      expect(generateServerStreamModule(result.value), message).toContain(JSON.stringify(expectedContent));
    }
  });
});
