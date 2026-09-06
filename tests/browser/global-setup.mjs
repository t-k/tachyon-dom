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
  const output = await build({
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
  // Static and dynamic module closures from the real production module graph.
  const chunks = (Array.isArray(output) ? output : [output]).flatMap((result) =>
    "output" in result ? result.output.filter((item) => item.type === "chunk") : [],
  );
  const byName = new Map(chunks.map((chunk) => [chunk.fileName, chunk]));
  const closure = (fileName, dynamic) => {
    const modules = new Set();
    const visited = new Set();
    const visit = (name) => {
      if (visited.has(name)) return;
      visited.add(name);
      const chunk = byName.get(name);
      if (!chunk) return;
      for (const id of Object.keys(chunk.modules)) modules.add(id.replace(distRoot, "dist"));
      for (const imported of chunk.imports) visit(imported);
      if (dynamic) for (const imported of chunk.dynamicImports) visit(imported);
    };
    visit(fileName);
    return [...modules].sort();
  };
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
    `${JSON.stringify(
      {
        entry: "entry.js",
        boundaryChunk: chunkImport[2],
        ssrMarkup: markup,
        staticClosure: closure("entry.js", false),
        boundaryClosure: closure(chunkImport[2], true),
      },
      null,
      2,
    )}\n`,
  );
};

export default async function globalSetup() {
  await buildLazyFixture();
}
