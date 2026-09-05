import { readFile } from "node:fs/promises";
import { build } from "esbuild";

const budgets = JSON.parse(await readFile(new URL("./browser-feature-budgets.json", import.meta.url), "utf8"));

const features = {
  "runtime/list": 'import { mountKeyedList } from "./src/runtime/list.ts"; export { mountKeyedList };',
  "runtime/form":
    'import { bindControl, setControlValue, writeModelValue } from "./src/runtime/form.ts"; export { bindControl, setControlValue, writeModelValue };',
  "runtime/conditional":
    'import { mountConditional } from "./src/runtime/conditional.ts"; export { mountConditional };',
  "runtime/router":
    'import { createClientRouter, rawHtml } from "./src/runtime/router.ts"; export { createClientRouter, rawHtml };',
};

const forbiddenPatterns = [
  /(?:^|[/\\])typescript(?:[/\\]|$)/,
  /(?:^|[/\\])parse5(?:[/\\]|$)/,
  /vscode-languageserver/,
  /[/\\]compiler[/\\]/,
  /[/\\]server[/\\]/,
  /[/\\]app\.js$/,
];

for (const [name, contents] of Object.entries(features)) {
  const budget = budgets[name];
  if (!budget || !Number.isSafeInteger(budget.maxMinifiedBytes) || budget.maxMinifiedBytes <= 0) {
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
  const outputBytes = result.outputFiles.reduce((total, output) => total + output.contents.byteLength, 0);
  if (outputBytes > budget.maxMinifiedBytes) {
    throw new Error(
      `${name} feature bundle is ${outputBytes} bytes minified; expected at most ${budget.maxMinifiedBytes} bytes.`,
    );
  }
  console.log(
    `${name}: ${outputBytes}/${budget.maxMinifiedBytes} minified bytes, ${Object.keys(result.metafile.inputs).length} inputs.`,
  );
}
