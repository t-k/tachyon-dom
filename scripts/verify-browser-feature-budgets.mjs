import { execFileSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { version as esbuildVersion } from "esbuild";
import { checkFeatureMeasurements } from "./browser-feature-report.mjs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { compileTemplate, generateClientModule } from "../dist/compiler.js";
import {
  buildClientBundle,
  checkBundleBudget,
  findForbiddenInputs,
  summarizeClientBundle,
} from "./client-bundle-attribution.mjs";

export const budgetsPath = fileURLToPath(new URL("./browser-feature-budgets.json", import.meta.url));
export const baselinePath = fileURLToPath(new URL("./browser-feature-sizes.json", import.meta.url));
export const defaultArtifactRoot = fileURLToPath(new URL("../benchmark/browser-feature-results/", import.meta.url));

const generatedClientSource = (source, options = {}) => {
  const compiled = compileTemplate(source);
  if (!compiled.ok) throw new Error(compiled.error.message);
  return generateClientModule(compiled.value, { instrumentBindings: false, ...options }).replaceAll(
    'from "tachyon-dom/',
    'from "./dist/',
  );
};

export const createFeatureFixtures = () => ({
  "runtime/list": generatedClientSource(
    `<ul><for each={rows} key={row.id}><li class:active={row.active}>{row.label}</li></for></ul>`,
  ),
  "runtime/form": generatedClientSource(`<form><input bind:value={value}></form>`),
  "runtime/conditional": generatedClientSource(
    `<main><if test={visible}><button on:click={save}>Save</button></if></main>`,
  ),
  // The rows and branches the generic runtimes drive. A ref keeps the row off the text adapter, and a row store
  // keeps the branch off the core, so these two measure exactly the paths the generated entries own.
  "runtime/generic-list": generatedClientSource(
    `<ul><for each={rows} key={row.id}><li ref={row.node}>{row.label}</li></for></ul>`,
  ),
  "runtime/generic-conditional": generatedClientSource(
    `<main><if test={visible}><store draft={seed}/><b>{draft}</b></if></main>`,
  ),
  "runtime/router": `import { createClientRouter, rawHtml } from "./dist/runtime/router.js"; export { createClientRouter, rawHtml };`,
});

const provenanceFor = (cwd) => ({
  commit: execFileSync("git", ["rev-parse", "HEAD"], { cwd, encoding: "utf8" }).trim(),
  dirty: execFileSync("git", ["status", "--porcelain"], { cwd, encoding: "utf8" }).trim().length > 0,
  node: process.version,
  esbuild: esbuildVersion,
  minify: true,
  define: { __TACHYON_PRODUCTION__: "true" },
  compression: "node:brotli-default",
});

// Budget failures are the reports worth keeping, so every measurement made before the failure is saved before
// the error is rethrown. CI uploads this directory unconditionally.
export const runBrowserFeatureBudgets = async ({
  cwd = process.cwd(),
  artifactRoot = defaultArtifactRoot,
  budgets,
  features = createFeatureFixtures(),
  log = () => {},
} = {}) => {
  const resolvedCwd = resolve(cwd);
  const resolvedBudgets = budgets ?? JSON.parse(await readFile(budgetsPath, "utf8"));
  const report = { schemaVersion: 1, provenance: provenanceFor(resolvedCwd), fixtures: [] };
  let validationError;
  try {
    for (const [name, contents] of Object.entries(features)) {
      const budget = resolvedBudgets[name];
      if (
        !budget ||
        !Number.isSafeInteger(budget.maxMinifiedBytes) ||
        budget.maxMinifiedBytes <= 0 ||
        !Number.isSafeInteger(budget.maxBrotliBytes) ||
        budget.maxBrotliBytes <= 0
      ) {
        throw new Error(`Missing valid browser feature budget for ${name}.`);
      }
      const result = await buildClientBundle(contents, { cwd: resolvedCwd });
      const summary = summarizeClientBundle(result);
      const inputHashes = await Promise.all(
        Object.keys(result.metafile.inputs)
          .sort()
          .map(async (input) => [input, input === "<stdin>" ? contents : await readFile(join(resolvedCwd, input), "utf8")]),
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
      log(
        `${name}: ${summary.minifiedBytes}/${budget.maxMinifiedBytes} minified bytes, ${summary.brotliBytes}/${budget.maxBrotliBytes} Brotli bytes, ${Object.keys(result.metafile.inputs).length} distribution inputs.`,
      );
    }
  } catch (error) {
    validationError = error;
  }
  report.validation = { ok: validationError === undefined, error: validationError?.message };
  const runDirectory = join(resolve(artifactRoot), `${Date.now()}-${randomUUID()}`);
  await mkdir(runDirectory, { recursive: true });
  const artifactPath = join(runDirectory, "report.json");
  const json = `${JSON.stringify(report, null, 2)}\n`;
  await writeFile(artifactPath, json);
  log(`Browser feature report: ${artifactPath}`);
  if (validationError) throw validationError;
  return { report, json, artifactPath };
};

const pathArgument = (flag, fallback) => {
  const index = process.argv.indexOf(flag);
  return index >= 0 && process.argv[index + 1] ? resolve(process.argv[index + 1]) : fallback;
};

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const budgets = JSON.parse(await readFile(pathArgument("--budgets", budgetsPath), "utf8"));
  const { json } = await runBrowserFeatureBudgets({
    artifactRoot: pathArgument("--artifact-root", defaultArtifactRoot),
    budgets,
    log: (message) => console.log(message),
  });
  if (process.argv.includes("--write-baseline")) await writeFile(baselinePath, json);
  if (process.argv.includes("--check-baseline")) {
    checkFeatureMeasurements(JSON.parse(await readFile(baselinePath, "utf8")), JSON.parse(json));
  }
}
