import { execFileSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { version as esbuildVersion } from "esbuild";
import { checkFeatureMeasurements } from "./browser-feature-report.mjs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
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

const report = {
  schemaVersion: 1,
  provenance: {
    commit: execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim(),
    dirty: execFileSync("git", ["status", "--porcelain"], { encoding: "utf8" }).trim().length > 0,
    node: process.version,
    esbuild: esbuildVersion,
    minify: true,
    define: { __TACHYON_PRODUCTION__: "true" },
    compression: "node:brotli-default",
  },
  fixtures: [],
};
let validationError;
try {
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
    const inputHashes = await Promise.all(
      Object.keys(result.metafile.inputs)
        .sort()
        .map(async (input) => [input, input === "<stdin>" ? contents : await readFile(input, "utf8")]),
    );
    report.fixtures.push({
      name,
      inputHash: createHash("sha256").update(JSON.stringify(inputHashes)).digest("hex"),
      minifiedBytes: summary.minifiedBytes,
      brotliBytes: summary.brotliBytes,
    });
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
} catch (error) {
  validationError = error;
}
report.validation = { ok: validationError === undefined, error: validationError?.message };
const runDirectory = new URL(`../benchmark/browser-feature-results/${Date.now()}-${randomUUID()}/`, import.meta.url);
await mkdir(runDirectory, { recursive: true });
const json = `${JSON.stringify(report, null, 2)}\n`;
await writeFile(new URL("report.json", runDirectory), json);
console.log(`Browser feature report: ${runDirectory.pathname}report.json`);
if (validationError) throw validationError;
const baselineUrl = new URL("./browser-feature-sizes.json", import.meta.url);
if (process.argv.includes("--write-baseline")) await writeFile(baselineUrl, json);
if (process.argv.includes("--check-baseline")) {
  checkFeatureMeasurements(JSON.parse(await readFile(baselineUrl, "utf8")), report);
}
