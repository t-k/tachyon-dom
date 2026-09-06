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

const buildConditionalFixture = async () => {
  const { compileTemplate, generateClientModule, renderServerTemplate } = await import(`${distRoot}/compiler.js`);
  const source = `<main><if test={leftVisible}><button data-branch="left" on:click={saveLeft}>{left}</button></if><if test={rightVisible}><button data-branch="right" on:click={saveRight}>{right}</button></if><if test={ssrVisible}><p>{ssrLabel}<span>{ssrOther}</span></p></if><if test={genericVisible}><form><input bind:value={genericValue}></form></if><footer>{tail}</footer></main>`;
  const compiled = compileTemplate(source);
  if (!compiled.ok) throw new Error(compiled.error.message);
  const generated = generateClientModule(compiled.value, { reactive: true, instrumentBindings: false });
  const entrySource = resolve(outDir, "conditional-source.js");
  await writeFile(
    entrySource,
    `import { createSignal } from "tachyon-dom";
import { hydrate, mount } from "tachyon-dom/runtime/mount";
${generated}
const clientModule = { templateHtml, hydrationBoundaries, hydrationDynamicAttributes, hydrationDynamicRegions, bind };
window.runConditionalFollowup = () => {
  const mountRoot = document.querySelector("#conditional-mount");
  if (!mountRoot) throw new Error("Missing conditional mount root.");
  const leftVisible = createSignal(true);
  const rightVisible = createSignal(true);
  const left = createSignal("A");
  const right = createSignal("B");
  const genericVisible = createSignal(true);
  const tail = createSignal("Static");
  let leftClicks = 0;
  let rightClicks = 0;
  const mounted = mount(mountRoot, clientModule, {
    leftVisible,
    rightVisible,
    left,
    right,
    ssrVisible: createSignal(false),
    ssrLabel: createSignal("unused"),
    ssrOther: createSignal("unused"),
    genericVisible,
    genericValue: "input",
    tail,
    saveLeft: () => leftClicks++,
    saveRight: () => rightClicks++,
  });
  const firstRight = mountRoot.querySelector('[data-branch="right"]');
  const firstForm = mountRoot.querySelector("form");
  leftVisible.set(false);
  firstRight?.click();
  leftVisible.set(true);
  left.set("A2");
  right.set("B2");
  tail.set("Static2");
  genericVisible.set(false);
  const formRemoved = mountRoot.querySelector("form") === null;
  genericVisible.set(true);
  const secondForm = mountRoot.querySelector("form");
  tail.set("Static3");
  const rightPreserved = mountRoot.querySelector('[data-branch="right"]') === firstRight;
  const mountedText = mountRoot.textContent;
  const beforeDisposeRightClicks = rightClicks;
  mounted.dispose();
  firstRight?.click();
  const mountResult = {
    text: mountedText,
    rightPreserved,
    leftClicks,
    rightClicks,
    disposedRightListener: rightClicks === beforeDisposeRightClicks,
    formRemoved,
    formRecreated: secondForm !== firstForm,
  };

  const ssrRoot = document.querySelector("#conditional-ssr");
  if (!ssrRoot) throw new Error("Missing conditional SSR root.");
  const ssrVisible = createSignal(true);
  const ssrLabel = createSignal("");
  const ssrOther = createSignal(null);
  const hydratedGenericVisible = createSignal(true);
  const hydratedTail = createSignal("Hydrated footer");
  const serverForm = ssrRoot.querySelector("form");
  const serverFooter = ssrRoot.querySelector("footer");
  const hydrated = hydrate(ssrRoot, clientModule, {
    leftVisible: createSignal(false),
    rightVisible: createSignal(false),
    left: createSignal("unused"),
    right: createSignal("unused"),
    ssrVisible,
    ssrLabel,
    ssrOther,
    genericVisible: hydratedGenericVisible,
    genericValue: "hydrated input",
    tail: hydratedTail,
    saveLeft: () => undefined,
    saveRight: () => undefined,
  });
  if (!hydrated.ok) throw new Error(hydrated.error.message);
  const paragraph = ssrRoot.querySelector("p");
  if (!paragraph) throw new Error("Missing hydrated paragraph.");
  const serverParagraph = paragraph;
  ssrLabel.set("ready");
  const materialized = paragraph.firstChild?.nodeType === Node.TEXT_NODE && paragraph.textContent === "ready";
  ssrLabel.set("");
  ssrOther.set("second");
  const multipleTextBindings = paragraph.textContent === "second";
  ssrVisible.set(false);
  ssrVisible.set(true);
  const genericFormPreserved = ssrRoot.querySelector("form") === serverForm;
  hydratedTail.set("Hydrated footer 2");
  hydratedGenericVisible.set(false);
  const genericFormRemoved = ssrRoot.querySelector("form") === null;
  hydratedGenericVisible.set(true);
  const recreatedForm = ssrRoot.querySelector("form");
  const recreatedParagraph = ssrRoot.querySelector("p");
  const hydrateResult = {
    materialized,
    multipleTextBindings,
    serverIdentity: serverParagraph === ssrRoot.querySelector("p"),
    recreated: recreatedParagraph !== serverParagraph,
    genericFormPreserved,
    genericFormRemoved,
    genericFormRecreated: recreatedForm !== serverForm,
    genericFooterUpdated: serverFooter?.textContent === "Hydrated footer 2",
    text: ssrRoot.textContent,
  };
  hydrated.value.dispose();
  return { mount: mountResult, hydrate: hydrateResult };
};
window.__conditionalReady = true;
`,
  );
  await build({
    configFile: false,
    logLevel: "silent",
    root: outDir,
    mode: "production",
    resolve: {
      alias: [
        { find: /^tachyon-dom\/(.+)$/, replacement: `${distRoot}/$1.js` },
        { find: "tachyon-dom", replacement: `${distRoot}/index.js` },
      ],
    },
    build: {
      outDir,
      emptyOutDir: false,
      minify: true,
      rollupOptions: {
        input: entrySource,
        output: { entryFileNames: "conditional-entry.js", format: "es" },
      },
    },
  });
  const markup = renderServerTemplate(compiled.value, {
    leftVisible: false,
    rightVisible: false,
    left: "unused",
    right: "unused",
    ssrVisible: true,
    ssrLabel: "",
    ssrOther: null,
    genericVisible: true,
    genericValue: "server input",
    tail: "Server footer",
  });
  await writeFile(
    resolve(outDir, "conditional-fixture.html"),
    `<!doctype html>
<html>
  <body>
    <div id="conditional-mount"></div>
    <div id="conditional-ssr">${markup}</div>
    <script type="module" src="./conditional-entry.js"></script>
  </body>
</html>
`,
  );
};

export default async function globalSetup() {
  await buildLazyFixture();
  await buildConditionalFixture();
}
