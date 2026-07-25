import { readFile } from "node:fs/promises";
import { build } from "esbuild";

const expectedSizes = JSON.parse(
  await readFile(new URL("./browser-bundle-sizes.json", import.meta.url), "utf8"),
);

const forbiddenInputs = [
  /(?:^|[/\\])typescript(?:[/\\]|$)/,
  /(?:^|[/\\])parse5(?:[/\\]|$)/,
  /vscode-languageserver/,
  /[/\\]compiler[/\\]/,
  /[/\\]server[/\\]/,
  /[/\\]app\.js$/,
  /[/\\]html-whitespace\.js$/,
];

const result = await build({
  bundle: true,
  format: "esm",
  logLevel: "silent",
  metafile: true,
  minify: true,
  platform: "browser",
  stdin: {
    contents: 'import { createSignal } from "tachyon-dom"; export const value = createSignal(1);',
    loader: "js",
    resolveDir: process.cwd(),
  },
  write: false,
});

const forbidden = Object.keys(result.metafile.inputs).filter((input) =>
  forbiddenInputs.some((pattern) => pattern.test(input)),
);
if (forbidden.length > 0) {
  throw new Error(`Browser entry includes forbidden dependencies:\n${forbidden.join("\n")}`);
}

const outputBytes = result.outputFiles.reduce((total, output) => total + output.contents.byteLength, 0);
if (outputBytes !== expectedSizes.browserEntryMinifiedBytes) {
  throw new Error(
    `Browser entry bundle is ${outputBytes} bytes; update the implementation, README, and browser-bundle-sizes.json together.`,
  );
}
if (outputBytes > 2_048) {
  throw new Error(`Browser entry bundle is ${outputBytes} bytes; expected at most 2048 bytes.`);
}

const cookiesResult = await build({
  bundle: true,
  format: "esm",
  logLevel: "silent",
  metafile: true,
  minify: true,
  platform: "browser",
  stdin: {
    contents:
      'import { parseCookies, signCookieValue, verifySignedCookieValue } from "tachyon-dom/cookies"; export const cookies = parseCookies("theme=dark"); export const signed = signCookieValue("hello", "key"); export const verified = verifySignedCookieValue(signed, "key");',
    loader: "js",
    resolveDir: process.cwd(),
  },
  write: false,
});
const cookiesOutput = cookiesResult.outputFiles.map((output) => output.text).join("\n");
if (cookiesOutput.includes("node:") || /\bBuffer\b/.test(cookiesOutput)) {
  throw new Error("The cookies browser bundle includes Node-only runtime dependencies.");
}
const cookiesOutputBytes = cookiesResult.outputFiles.reduce(
  (total, output) => total + output.contents.byteLength,
  0,
);
if (cookiesOutputBytes !== expectedSizes.cookiesEntryMinifiedBytes) {
  throw new Error(
    `Cookies entry bundle is ${cookiesOutputBytes} bytes; update the implementation and browser-bundle-sizes.json together.`,
  );
}
if (cookiesOutputBytes > 8_192) {
  throw new Error(`Cookies entry bundle is ${cookiesOutputBytes} bytes; expected at most 8192 bytes.`);
}

console.log(
  `Browser entry bundle: ${outputBytes} bytes, ${Object.keys(result.metafile.inputs).length} inputs. Cookies entry bundle: ${cookiesOutputBytes} bytes, ${Object.keys(cookiesResult.metafile.inputs).length} inputs.`,
);
