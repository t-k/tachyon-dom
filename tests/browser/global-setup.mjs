// Builds the real `.td` lazy hydration fixture with the published Vite plugin
// before the browser suite runs, so the browser test exercises compiler and
// Vite generated output instead of hand-written JavaScript.
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "vite";

const here = dirname(fileURLToPath(import.meta.url));
const projectRoot = resolve(here, "..", "..");
const distRoot = resolve(projectRoot, "dist");
const fixtureRoot = resolve(here, "lazy-sfc");
const outDir = resolve(here, "generated");

const buildLazyFixture = async () => {
  const { tachyonDom } = await import(`${distRoot}/vite.js`);
  const { compileTachyonSfc, renderServerTemplate } = await import(`${distRoot}/compiler.js`);
  await rm(outDir, { recursive: true, force: true });
  await mkdir(outDir, { recursive: true });
  await build({
    configFile: false,
    logLevel: "silent",
    root: fixtureRoot,
    mode: "production",
    plugins: [tachyonDom({ reactive: true })],
    resolve: {
      alias: [
        { find: /^tachyon-dom\/(.+)$/, replacement: `${distRoot}/$1.js` },
        { find: "tachyon-dom", replacement: `${distRoot}/index.js` },
      ],
    },
    build: {
      outDir,
      emptyOutDir: true,
      minify: true,
      rollupOptions: {
        input: resolve(fixtureRoot, "main.js"),
        output: { entryFileNames: "entry.js", chunkFileNames: "[name].js", format: "es" },
      },
    },
  });
  const entry = await readFile(resolve(outDir, "entry.js"), "utf8");
  const chunkImport = /import\((["`'])\.\/([^"`']+\.js)\1\)/.exec(entry);
  if (!chunkImport) throw new Error("The built lazy fixture entry has no dynamic boundary chunk import.");
  const source = await readFile(resolve(fixtureRoot, "lazy.td"), "utf8");
  const compiled = compileTachyonSfc(source);
  if (!compiled.ok) throw new Error(compiled.error.message);
  const markup = renderServerTemplate(compiled.value.template, { label: "Send" });
  await writeFile(
    resolve(outDir, "lazy-sfc-fixture.html"),
    `<!doctype html>\n<html>\n  <body>\n    ${markup}\n    <script type="module" src="./entry.js"></script>\n  </body>\n</html>\n`,
  );
  await writeFile(
    resolve(outDir, "manifest.json"),
    `${JSON.stringify({ entry: "entry.js", boundaryChunk: chunkImport[2], ssrMarkup: markup }, null, 2)}\n`,
  );
};

export default async function globalSetup() {
  await buildLazyFixture();
}
