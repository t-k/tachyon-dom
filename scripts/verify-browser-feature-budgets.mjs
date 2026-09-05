import { readFile } from "node:fs/promises";
import { brotliCompressSync } from "node:zlib";
import { build } from "esbuild";
import { compileTemplate, generateClientModule } from "../dist/compiler.js";

const budgets = JSON.parse(await readFile(new URL("./browser-feature-budgets.json", import.meta.url), "utf8"));

const generatedClientSource = (source, options = {}) => {
  const compiled = compileTemplate(source);
  if (!compiled.ok) throw new Error(compiled.error.message);
  return generateClientModule(compiled.value, options).replaceAll('from "tachyon-dom/', 'from "./dist/');
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

const forbiddenPatterns = [
  /(?:^|[/\\])typescript(?:[/\\]|$)/,
  /(?:^|[/\\])parse5(?:[/\\]|$)/,
  /vscode-languageserver/,
  /[/\\]runtime[/\\]diagnostics\.js$/,
  /[/\\]compiler[/\\]/,
  /[/\\]server[/\\]/,
  /[/\\]app\.js$/,
];

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
  const result = await build({
    bundle: true,
    format: "esm",
    logLevel: "silent",
    metafile: true,
    minify: true,
    platform: "browser",
    stdin: { contents, loader: "js", resolveDir: process.cwd() },
    write: false,
  });
  const forbiddenInputs = Object.keys(result.metafile.inputs).filter((input) =>
    forbiddenPatterns.some((pattern) => pattern.test(input)),
  );
  if (forbiddenInputs.length > 0) {
    throw new Error(`${name} feature bundle includes forbidden dependencies:\n${forbiddenInputs.join("\n")}`);
  }
  const distributionInputs = Object.keys(result.metafile.inputs).filter((input) => input.includes("dist/"));
  if (distributionInputs.length === 0) {
    throw new Error(`${name} feature bundle did not resolve any distribution module.`);
  }
  const outputBytes = result.outputFiles.reduce((total, output) => total + output.contents.byteLength, 0);
  const brotliBytes = result.outputFiles.reduce(
    (total, output) => total + brotliCompressSync(output.contents).byteLength,
    0,
  );
  if (outputBytes > budget.maxMinifiedBytes) {
    throw new Error(
      `${name} feature bundle is ${outputBytes} bytes minified; expected at most ${budget.maxMinifiedBytes} bytes.`,
    );
  }
  if (brotliBytes > budget.maxBrotliBytes) {
    throw new Error(
      `${name} feature bundle is ${brotliBytes} bytes Brotli; expected at most ${budget.maxBrotliBytes} bytes.`,
    );
  }
  console.log(
    `${name}: ${outputBytes}/${budget.maxMinifiedBytes} minified bytes, ${brotliBytes}/${budget.maxBrotliBytes} Brotli bytes, ${Object.keys(result.metafile.inputs).length} distribution inputs.`,
  );
}
