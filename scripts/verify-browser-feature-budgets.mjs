import { readFile } from "node:fs/promises";
import { compileTemplate, generateClientModule } from "../dist/compiler.js";
import {
  buildClientBundle,
  checkBundleBudget,
  findForbiddenInputs,
  summarizeClientBundle,
} from "./client-bundle-attribution.mjs";

const budgets = JSON.parse(await readFile(new URL("./browser-feature-budgets.json", import.meta.url), "utf8"));

const generatedClientSource = (source, options = {}) => {
  const compiled = compileTemplate(source);
  if (!compiled.ok) throw new Error(compiled.error.message);
  return generateClientModule(compiled.value, { instrumentBindings: false, ...options }).replaceAll(
    'from "tachyon-dom/',
    'from "./dist/',
  );
};

const features = {
  "runtime/list": generatedClientSource(
    `<ul><for each={rows} key={row.id}><li class:active={row.active}>{row.label}</li></for></ul>`,
  ),
  "runtime/form": generatedClientSource(`<form><input bind:value={value}></form>`),
  "runtime/conditional": generatedClientSource(
    `<main><if test={visible}><button on:click={save}>Save</button></if></main>`,
  ),
  "runtime/router": `import { createClientRouter, rawHtml } from "./dist/runtime/router.js"; export { createClientRouter, rawHtml };`,
};

for (const [name, contents] of Object.entries(features)) {
  const budget = budgets[name];
  if (
    !budget ||
    !Number.isSafeInteger(budget.maxMinifiedBytes) ||
    budget.maxMinifiedBytes <= 0 ||
    !Number.isSafeInteger(budget.maxBrotliBytes) ||
    budget.maxBrotliBytes <= 0
  ) {
    throw new Error(`Missing valid browser feature budget for ${name}.`);
  }
  const result = await buildClientBundle(contents);
  const summary = summarizeClientBundle(result);
  const forbiddenInputs = findForbiddenInputs(Object.keys(result.metafile.inputs));
  if (forbiddenInputs.length > 0) {
    throw new Error(`${name} feature bundle includes forbidden dependencies:\n${forbiddenInputs.join("\n")}`);
  }
  const distributionInputs = Object.keys(result.metafile.inputs).filter((input) => input.includes("dist/"));
  if (distributionInputs.length === 0) {
    throw new Error(`${name} feature bundle did not resolve any distribution module.`);
  }
  const budgetResult = checkBundleBudget({ ...summary, budget });
  if (!budgetResult.ok) {
    throw new Error(
      `${name} feature bundle exceeds its ${budgetResult.reason}: ${summary.minifiedBytes} minified/${summary.brotliBytes} Brotli bytes.`,
    );
  }
  console.log(
    `${name}: ${summary.minifiedBytes}/${budget.maxMinifiedBytes} minified bytes, ${summary.brotliBytes}/${budget.maxBrotliBytes} Brotli bytes, ${Object.keys(result.metafile.inputs).length} distribution inputs.`,
  );
}
