import { readFile } from "node:fs/promises";
import { brotliCompressSync } from "node:zlib";
import { build } from "esbuild";
import { compileTemplate, generateClientModule } from "../dist/compiler.js";
import { checkQuickExampleSizes } from "./quick-example-size-policy.mjs";

const expectedSizes = JSON.parse(
  await readFile(new URL("./browser-bundle-sizes.json", import.meta.url), "utf8"),
);

const templateSource = `<main>
  <button on:click={increment}>{count}</button>
  <ul>
    <for each={rows} key={row.id}>
      <li>{row.label}</li>
    </for>
  </ul>
</main>`;

const compiled = compileTemplate(templateSource, { whitespace: "condense" });
if (!compiled.ok) throw new Error(compiled.error.message);

const generated = generateClientModule(compiled.value, { reactive: true });
const clientSource = `
import { createSignal } from "tachyon-dom";
${generated}
export const scope = {
  count: createSignal(0),
  rows: createSignal([{ id: 1, label: "Alpha" }, { id: 2, label: "Beta" }]),
};
scope.increment = () => scope.count.update((value) => value + 1);
export const mount = (root) => bind(root, scope);
`;

const result = await build({
  bundle: true,
  format: "esm",
  logLevel: "silent",
  metafile: true,
  minify: true,
  platform: "browser",
  stdin: { contents: clientSource, loader: "js", resolveDir: process.cwd() },
  write: false,
});

const forbiddenPatterns = [
  /(?:^|[/\\])typescript(?:[/\\]|$)/,
  /(?:^|[/\\])parse5(?:[/\\]|$)/,
  /vscode-languageserver/,
  /[/\\]compiler[/\\]/,
  /[/\\]server[/\\]/,
  /[/\\]app\.js$/,
  /[/\\]html-whitespace\.js$/,
];
const forbiddenInputs = Object.keys(result.metafile.inputs).filter((input) =>
  forbiddenPatterns.some((pattern) => pattern.test(input)),
);
if (forbiddenInputs.length > 0) {
  throw new Error(`Quick example includes forbidden dependencies:\n${forbiddenInputs.join("\n")}`);
}

const minifiedBytes = result.outputFiles.reduce((total, output) => total + output.contents.byteLength, 0);
const brotliBytes = result.outputFiles.reduce(
  (total, output) => total + brotliCompressSync(output.contents).byteLength,
  0,
);
const maxMinifiedBytes = 16_000;
const maxBrotliBytes = 5_200;
const sizeResult = checkQuickExampleSizes({
  expectedMinified: expectedSizes.quickExampleMinifiedBytes,
  actualMinified: minifiedBytes,
  expectedBrotli: expectedSizes.quickExampleBrotliBytes,
  actualBrotli: brotliBytes,
  maxMinified: maxMinifiedBytes,
  maxBrotli: maxBrotliBytes,
});
if (!sizeResult.ok) {
  throw new Error(
    `Quick example failed its ${sizeResult.reason} check at ${minifiedBytes} minified/${brotliBytes} Brotli bytes; update the implementation, README, and browser-bundle-sizes.json together.`,
  );
}

console.log(
  `Quick example client bundle: ${minifiedBytes} bytes minified, ${brotliBytes} bytes Brotli (±${sizeResult.tolerance}), ${Object.keys(result.metafile.inputs).length} inputs, Node ${process.version}, zlib ${process.versions.zlib}.`,
);
