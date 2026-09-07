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
  const sharedParentSources = [
    `<main><for each={rows} key={row.id}><p>{row.label}</p></for><if test={active}><button>{label}</button></if><footer>{tail}</footer></main>`,
    `<main><if test={active}><button>{label}</button></if><for each={rows} key={row.id}><p>{row.label}</p></for><footer>{tail}</footer></main>`,
  ];
  const sharedParentModules = sharedParentSources.map((sharedSource, index) => {
    const sharedCompiled = compileTemplate(sharedSource);
    if (!sharedCompiled.ok) throw new Error(sharedCompiled.error.message);
    const sharedGenerated = generateClientModule(sharedCompiled.value, { reactive: true, instrumentBindings: false });
    const sharedMarkup = renderServerTemplate(sharedCompiled.value, {
      rows: [
        { id: "a", label: "R1" },
        { id: "b", label: "R2" },
      ],
      active: true,
      label: "A",
      tail: "F",
    });
    return {
      fileName: `shared-parent-${index === 0 ? "before" : "after"}.js`,
      source: `import { createSignal } from "tachyon-dom";
import { hydrate } from "tachyon-dom/runtime/mount";
${sharedGenerated}
const hydrationDynamicRegionErrors = hydrationDynamicRegions.errors ?? [];
export const runSharedParentGuard = () => {
  const root = document.createElement("div");
  root.innerHTML = ${JSON.stringify(sharedMarkup)};
  const before = root.innerHTML;
  const result = hydrate(root, { templateHtml, hydrationBoundaries, hydrationDynamicAttributes, hydrationDynamicRegions, hydrationDynamicRegionErrors, bind }, {
    rows: createSignal([{ id: "a", label: "R1" }, { id: "b", label: "R2" }]),
    active: createSignal(true),
    label: createSignal("A"),
    tail: createSignal("F"),
  });
  if (result.ok) result.value.dispose();
  return { ok: result.ok, unchanged: root.innerHTML === before, message: result.ok ? "" : result.error.message };
};
`,
    };
  });
  const conditionalShapeModules = [
    `<main><if test={visible}><p class="shared">{left}</p></if><p class="shared" data-static="yes">{tail}</p></main>`,
    `<main><if test={visible}><section><b>{left}</b></section></if><section><em>{tail}</em></section></main>`,
  ].map((shapeSource, index) => {
    const shapeCompiled = compileTemplate(shapeSource);
    if (!shapeCompiled.ok) throw new Error(shapeCompiled.error.message);
    const shapeGenerated = generateClientModule(shapeCompiled.value, { reactive: true, instrumentBindings: false });
    const shapeMarkup = renderServerTemplate(shapeCompiled.value, {
      visible: false,
      left: "SSR branch",
      tail: "SSR tail",
    });
    return {
      fileName: `conditional-shape-${index}.js`,
      source: `import { createSignal } from "tachyon-dom";
import { hydrate } from "tachyon-dom/runtime/mount";
${shapeGenerated}
const hydrationDynamicRegionErrors = hydrationDynamicRegions.errors ?? [];
const clientModule = { templateHtml, hydrationBoundaries, hydrationDynamicAttributes, hydrationDynamicRegions, hydrationDynamicRegionErrors, bind };
export const runConditionalShapeCase = () => {
  const root = document.createElement("div");
  root.innerHTML = ${JSON.stringify(shapeMarkup)};
  const staticSibling = root.querySelector("main")?.lastElementChild;
  const tail = createSignal("Client tail");
  const hydrated = hydrate(root, clientModule, {
    visible: createSignal(false),
    left: createSignal("Client branch"),
    tail,
  });
  if (!hydrated.ok) return { ok: false, staticPreserved: false, tailUpdated: false };
  const staticPreserved = root.querySelector("main")?.lastElementChild === staticSibling;
  tail.set("Client tail 2");
  const tailUpdated = staticSibling?.textContent === "Client tail 2";
  hydrated.value.dispose();
  return { ok: true, staticPreserved, tailUpdated };
      };
`,
    };
  });
  const dynamicShapeModules = [
    {
      source: `<main><if test={visible}><p title={title}>{left}</p></if><p title="static">{tail}</p></main>`,
      active: false,
    },
    {
      source: `<main><if test={visible}><p class="shared" class:active={active}>{left}</p></if><p class="shared active">{tail}</p></main>`,
      active: false,
    },
    {
      source: `<main><if test={visible}><p title={title}>{left}</p></if><p title="static" on:click={save}>{tail}</p></main>`,
      active: false,
    },
    {
      source: `<main><if test={visible}><p class="active" title="static">{left}</p></if><p class:active={active} title="static">{tail}</p></main>`,
      active: true,
    },
    {
      source: `<main><if test={visible}><p class="active" title={title}>{left}</p></if><p class={classes} class:extra={active} title="static">{tail}</p></main>`,
      active: false,
      classes: "active",
    },
  ].map(({ source: shapeSource, active: serverActive, classes: serverClasses }, index) => {
    const shapeCompiled = compileTemplate(shapeSource);
    if (!shapeCompiled.ok) throw new Error(shapeCompiled.error.message);
    const shapeGenerated = generateClientModule(shapeCompiled.value, { reactive: true, instrumentBindings: false });
    const shapeMarkup = renderServerTemplate(shapeCompiled.value, {
      visible: false,
      title: "server branch",
      active: serverActive,
      classes: serverClasses,
      left: "SSR branch",
      tail: "SSR static",
      save: () => undefined,
    });
    return {
      fileName: `conditional-dynamic-shape-${index}.js`,
      source: `import { createSignal } from "tachyon-dom";
import { hydrate } from "tachyon-dom/runtime/mount";
${shapeGenerated}
const hydrationDynamicRegionErrors = hydrationDynamicRegions.errors ?? [];
const clientModule = { templateHtml, hydrationBoundaries, hydrationDynamicAttributes, hydrationDynamicRegions, hydrationDynamicRegionErrors, bind };
export const runDynamicShapeCase = () => {
  const root = document.createElement("div");
  root.innerHTML = ${JSON.stringify(shapeMarkup)};
  const before = root.innerHTML;
  const staticSibling = root.querySelector("main > p");
  const result = hydrate(root, clientModule, {
    visible: createSignal(false),
    title: createSignal("client branch"),
    active: createSignal(${serverActive}),
    classes: createSignal(${JSON.stringify(serverClasses)}),
    left: createSignal("client branch"),
    tail: createSignal("client static"),
    save: () => undefined,
  });
  if (result.ok) result.value.dispose();
  return {
    ok: result.ok,
    unchanged: root.innerHTML === before,
    staticPreserved: root.querySelector("main > p") === staticSibling,
    message: result.ok ? "" : result.error.message,
  };
};
`,
    };
  });
  const dynamicAttributeSource = `<main><if test={visible}><p title={title} class:active={active}>{label}</p></if><footer>{tail}</footer></main>`;
  const dynamicAttributeCompiled = compileTemplate(dynamicAttributeSource);
  if (!dynamicAttributeCompiled.ok) throw new Error(dynamicAttributeCompiled.error.message);
  const dynamicAttributeGenerated = generateClientModule(dynamicAttributeCompiled.value, {
    reactive: true,
    instrumentBindings: false,
  });
  const dynamicAttributeModule = {
    fileName: "conditional-dynamic-attribute.js",
    source: `import { createSignal } from "tachyon-dom";
import { hydrate } from "tachyon-dom/runtime/mount";
${dynamicAttributeGenerated}
const hydrationDynamicRegionErrors = hydrationDynamicRegions.errors ?? [];
const clientModule = { templateHtml, hydrationBoundaries, hydrationDynamicAttributes, hydrationDynamicRegions, hydrationDynamicRegionErrors, bind };
export const runDynamicAttributeCase = () => {
  const root = document.createElement("div");
  root.innerHTML = ${JSON.stringify(renderServerTemplate(dynamicAttributeCompiled.value, { visible: true, title: "server title", active: false, label: "server label", tail: "server footer" }))};
  const paragraph = root.querySelector("p");
  const active = createSignal(false);
  const result = hydrate(root, clientModule, {
    visible: createSignal(true),
    title: createSignal("client title"),
    active,
    label: createSignal("client label"),
    tail: createSignal("client footer"),
  });
  if (!result.ok) return { ok: false, identity: false, titleUpdated: false, classToggled: false };
  active.set(true);
  const classAdded = paragraph?.classList.contains("active") === true;
  active.set(false);
  const classToggled = classAdded && paragraph?.classList.contains("active") === false;
  const titleUpdated = paragraph?.getAttribute("title") === "client title";
  const identity = root.querySelector("p") === paragraph;
  result.value.dispose();
  return { ok: true, identity, titleUpdated, classToggled };
};
`,
  };
  const componentSplitSource = `<main><component name="Region"><for each={rows} key={row.id}><p>{row.label}</p></for></component><if test={active}><button>{label}</button></if><footer>{tail}</footer></main>`;
  const componentSplitCompiled = compileTemplate(componentSplitSource);
  if (!componentSplitCompiled.ok) throw new Error(componentSplitCompiled.error.message);
  const componentSplitGenerated = generateClientModule(componentSplitCompiled.value, {
    reactive: true,
    instrumentBindings: false,
  });
  const componentSplitMarkup = renderServerTemplate(componentSplitCompiled.value, {
    rows: [
      { id: "a", label: "R1" },
      { id: "b", label: "R2" },
    ],
    active: true,
    label: "A",
    tail: "F",
  });
  const componentSplitModule = {
    fileName: "conditional-component-split.js",
    source: `import { createSignal } from "tachyon-dom";
import { hydrate } from "tachyon-dom/runtime/mount";
${componentSplitGenerated}
const hydrationDynamicRegionErrors = hydrationDynamicRegions.errors ?? [];
const clientModule = { templateHtml, hydrationBoundaries, hydrationDynamicAttributes, hydrationDynamicRegions, hydrationDynamicRegionErrors, bind };
export const runComponentSplitCase = () => {
  const root = document.createElement("div");
  root.innerHTML = ${JSON.stringify(componentSplitMarkup)};
  const before = root.innerHTML;
  const serverRow = root.querySelector("p");
  const serverButton = root.querySelector("button");
  const serverFooter = root.querySelector("footer");
  const result = hydrate(root, clientModule, {
    rows: createSignal([{ id: "a", label: "R1" }, { id: "b", label: "R2" }]),
    active: createSignal(true),
    label: createSignal("A"),
    tail: createSignal("F"),
  });
  if (result.ok) result.value.dispose();
  return {
    ok: result.ok,
    unchanged: root.innerHTML === before,
    identityPreserved: root.querySelector("p") === serverRow && root.querySelector("button") === serverButton && root.querySelector("footer") === serverFooter,
    message: result.ok ? "" : result.error.message,
  };
};
`,
  };
  const listFooterSource = `<main><for each={rows} key={row.id}><p>{row.label}</p></for><footer>{tail}</footer></main>`;
  const listFooterCompiled = compileTemplate(listFooterSource);
  if (!listFooterCompiled.ok) throw new Error(listFooterCompiled.error.message);
  const listFooterGenerated = generateClientModule(listFooterCompiled.value, {
    reactive: true,
    instrumentBindings: false,
  });
  const listFooterRows = [
    { id: "a", label: "A" },
    { id: "b", label: "B" },
  ];
  const listFooterModule = {
    fileName: "generated-list-footer.js",
    source: `import { createSignal } from "tachyon-dom";
import { hydrate, mount } from "tachyon-dom/runtime/mount";
${listFooterGenerated}
const hydrationDynamicRegionErrors = hydrationDynamicRegions.errors ?? [];
const clientModule = { templateHtml, hydrationBoundaries, hydrationDynamicAttributes, hydrationDynamicRegions, hydrationDynamicRegionErrors, bind };
const rowsFor = () => [{ id: "a", label: "A" }, { id: "b", label: "B" }];
export const runListFooterCase = () => {
  const root = document.createElement("div");
  const rows = createSignal(rowsFor());
  const tail = createSignal("F");
  const mounted = mount(root, clientModule, { rows, tail });
  const footer = root.querySelector("footer");
  const firstRow = root.querySelector("p");
  tail.set("F2");
  rows.set([{ id: "b", label: "B" }, { id: "c", label: "C" }, { id: "a", label: "A" }]);
  const mountCorrect = root.textContent === "BCAF2" && root.querySelector("footer") === footer && root.querySelectorAll("p")[2] === firstRow;
  mounted.dispose();

  const hydratedRoot = document.createElement("div");
  hydratedRoot.innerHTML = ${JSON.stringify(renderServerTemplate(listFooterCompiled.value, { rows: listFooterRows, tail: "SSR footer" }))};
  const serverFooter = hydratedRoot.querySelector("footer");
  const hydratedRows = createSignal(rowsFor());
  const hydratedTail = createSignal("Hydrated footer");
  const hydrated = hydrate(hydratedRoot, clientModule, { rows: hydratedRows, tail: hydratedTail });
  if (!hydrated.ok) return { mountCorrect, hydrateCorrect: false };
  hydratedTail.set("Hydrated footer 2");
  hydratedRows.set([{ id: "b", label: "B" }, { id: "c", label: "C" }, { id: "a", label: "A" }]);
  const hydrateCorrect = hydratedRoot.textContent === "BCAHydrated footer 2" && hydratedRoot.querySelector("footer") === serverFooter;
  hydrated.value.dispose();
  return { mountCorrect, hydrateCorrect };
};
`,
  };
  const listHeaderSource = `<main>intro<header>{head}</header><for each={rows} key={row.id}><p>{row.label}</p></for><footer>{tail}</footer></main>`;
  const listHeaderCompiled = compileTemplate(listHeaderSource);
  if (!listHeaderCompiled.ok) throw new Error(listHeaderCompiled.error.message);
  const listHeaderGenerated = generateClientModule(listHeaderCompiled.value, {
    reactive: true,
    instrumentBindings: false,
  });
  const listHeaderModule = {
    fileName: "generated-list-header.js",
    source: `import { createSignal } from "tachyon-dom";
import { hydrate, mount } from "tachyon-dom/runtime/mount";
${listHeaderGenerated}
const hydrationDynamicRegionErrors = hydrationDynamicRegions.errors ?? [];
const clientModule = { templateHtml, hydrationBoundaries, hydrationDynamicAttributes, hydrationDynamicRegions, hydrationDynamicRegionErrors, bind };
export const runListHeaderCase = () => {
  const first = { id: "a", label: "A" };
  const second = { id: "b", label: "B" };
  const third = { id: "c", label: "C" };
  const root = document.createElement("div");
  const rows = createSignal([first, second]);
  const head = createSignal("H");
  const tail = createSignal("F");
  const mounted = mount(root, clientModule, { rows, head, tail });
  const header = root.querySelector("header");
  const footer = root.querySelector("footer");
  head.set("H2");
  tail.set("F2");
  rows.set([second, third, first]);
  const mountCorrect = root.querySelector("header") === header && root.querySelector("footer") === footer && root.textContent === "introH2BCAF2";
  mounted.dispose();

  const hydratedRoot = document.createElement("div");
  hydratedRoot.innerHTML = ${JSON.stringify(
    renderServerTemplate(listHeaderCompiled.value, {
      head: "SSR head",
      rows: [
        { id: "a", label: "A" },
        { id: "b", label: "B" },
      ],
      tail: "SSR footer",
    }),
  )};
  const serverHeader = hydratedRoot.querySelector("header");
  const serverFooter = hydratedRoot.querySelector("footer");
  const hydratedHead = createSignal("H");
  const hydratedTail = createSignal("F");
  const hydratedRows = createSignal([first, second]);
  const hydrated = hydrate(hydratedRoot, clientModule, { rows: hydratedRows, head: hydratedHead, tail: hydratedTail });
  if (!hydrated.ok) return { mountCorrect, hydrateCorrect: false };
  hydratedHead.set("H2");
  hydratedTail.set("F2");
  hydratedRows.set([second, third, first]);
  const hydrateCorrect = hydratedRoot.querySelector("header") === serverHeader && hydratedRoot.querySelector("footer") === serverFooter && hydratedRoot.textContent === "introH2BCAF2";
  hydrated.value.dispose();
  return { mountCorrect, hydrateCorrect };
};
`,
  };
  const listTextOnlySource = `<main>{head}<for each={rows} key={row.id}><p>{row.label}</p></for>{tail}</main>`;
  const listTextOnlyCompiled = compileTemplate(listTextOnlySource);
  if (!listTextOnlyCompiled.ok) throw new Error(listTextOnlyCompiled.error.message);
  const listTextOnlyGenerated = generateClientModule(listTextOnlyCompiled.value, {
    reactive: true,
    instrumentBindings: false,
  });
  const listTextOnlyModule = {
    fileName: "generated-list-text-only-siblings.js",
    source: `import { createSignal } from "tachyon-dom";
import { hydrate, mount } from "tachyon-dom/runtime/mount";
${listTextOnlyGenerated}
const hydrationDynamicRegionErrors = hydrationDynamicRegions.errors ?? [];
const clientModule = { templateHtml, hydrationBoundaries, hydrationDynamicAttributes, hydrationDynamicRegions, hydrationDynamicRegionErrors, bind };
const rowsFor = () => [{ id: "a", label: "A" }, { id: "b", label: "B" }];
export const runListTextOnlyCase = () => {
  const first = { id: "a", label: "A" };
  const second = { id: "b", label: "B" };
  const third = { id: "c", label: "C" };
  const runMount = () => {
    const root = document.createElement("div");
    const rows = createSignal([first, second]);
    const head = createSignal("H");
    const tail = createSignal("F");
    const mounted = mount(root, clientModule, { rows, head, tail });
    const main = root.querySelector("main");
    const initialRows = Array.from(root.querySelectorAll("p"));
    head.set("H2");
    tail.set("F2");
    rows.set([second, third, first]);
    const currentRows = Array.from(root.querySelectorAll("p"));
    const correct =
      main?.textContent === "H2BCAF2" &&
      currentRows[0] === initialRows[1] &&
      currentRows[2] === initialRows[0];
    mounted.dispose();
    return correct;
  };
  const runHydrate = () => {
    const root = document.createElement("div");
    root.innerHTML = ${JSON.stringify(
      renderServerTemplate(listTextOnlyCompiled.value, {
        head: "SSR head",
        tail: "SSR tail",
        rows: [
          { id: "a", label: "A" },
          { id: "b", label: "B" },
        ],
      }),
    )};
    const serverRows = Array.from(root.querySelectorAll("p"));
    const rows = createSignal(rowsFor());
    const head = createSignal("H");
    const tail = createSignal("F");
    const hydrated = hydrate(root, clientModule, { rows, head, tail });
    if (!hydrated.ok) return false;
    head.set("H2");
    tail.set("F2");
    rows.set([second, third, first]);
    const currentRows = Array.from(root.querySelectorAll("p"));
    const correct = root.textContent === "H2BCAF2" && currentRows[0] === serverRows[1] && currentRows[2] === serverRows[0];
    hydrated.value.dispose();
    return correct;
  };
  return { mountCorrect: runMount(), hydrateCorrect: runHydrate() };
};
`,
  };
  const listConditionalSource = `<main><section><for each={rows} key={row.id}><p>{row.label}</p></for><footer>{tail}</footer></section><aside><if test={visible}><b>{head}</b></if></aside></main>`;
  const listConditionalCompiled = compileTemplate(listConditionalSource);
  if (!listConditionalCompiled.ok) throw new Error(listConditionalCompiled.error.message);
  const listConditionalGenerated = generateClientModule(listConditionalCompiled.value, {
    reactive: true,
    instrumentBindings: false,
  });
  const listConditionalModule = {
    fileName: "generated-list-separate-parent.js",
    source: `import { createSignal } from "tachyon-dom";
import { hydrate, mount } from "tachyon-dom/runtime/mount";
${listConditionalGenerated}
const hydrationDynamicRegionErrors = hydrationDynamicRegions.errors ?? [];
const clientModule = { templateHtml, hydrationBoundaries, hydrationDynamicAttributes, hydrationDynamicRegions, hydrationDynamicRegionErrors, bind };
const rowsFor = () => [{ id: "a", label: "A" }, { id: "b", label: "B" }];
export const runListSeparateParentCase = () => {
  const run = (mode) => {
    const root = document.createElement("div");
    const rows = createSignal(rowsFor());
    const tail = createSignal("F");
    const head = createSignal("H");
    const visible = createSignal(true);
    let handle;
    if (mode === "hydrate") {
      root.innerHTML = ${JSON.stringify(
        renderServerTemplate(listConditionalCompiled.value, {
          rows: [
            { id: "a", label: "A" },
            { id: "b", label: "B" },
          ],
          tail: "SSR footer",
          head: "SSR heading",
          visible: true,
        }),
      )};
      const result = hydrate(root, clientModule, { rows, tail, head, visible });
      if (!result.ok) return false;
      handle = result.value;
    } else {
      handle = mount(root, clientModule, { rows, tail, head, visible });
    }
    const footer = root.querySelector("footer");
    tail.set("F2");
    rows.set([{ id: "b", label: "B" }, { id: "c", label: "C" }, { id: "a", label: "A" }]);
    const correct = root.textContent === "BCAF2H" && root.querySelector("footer") === footer;
    handle.dispose();
    return correct;
  };
  return { mountCorrect: run("mount"), hydrateCorrect: run("hydrate") };
};
`,
  };
  // A conditional whose branch owns many nodes, so hiding it has to release the whole region while the static
  // sibling keeps its identity and its updates.
  const largeBranchRows = 200;
  const largeBranchSource = `<main><if test={visible}><ul>${Array.from(
    { length: largeBranchRows },
    (_, index) => `<li>row ${index}</li>`,
  ).join("")}<li>{last}</li></ul></if><footer>{tail}</footer></main>`;
  const largeBranchCompiled = compileTemplate(largeBranchSource);
  if (!largeBranchCompiled.ok) throw new Error(largeBranchCompiled.error.message);
  const largeBranchGenerated = generateClientModule(largeBranchCompiled.value, {
    reactive: true,
    instrumentBindings: false,
  });
  const largeBranchMarkup = renderServerTemplate(largeBranchCompiled.value, {
    visible: true,
    last: "Server last",
    tail: "Server tail",
  });
  const largeBranchModule = {
    fileName: "conditional-large-branch.js",
    source: `import { createSignal } from "tachyon-dom";
import { hydrate } from "tachyon-dom/runtime/mount";
${largeBranchGenerated}
const hydrationDynamicRegionErrors = hydrationDynamicRegions.errors ?? [];
const clientModule = { templateHtml, hydrationBoundaries, hydrationDynamicAttributes, hydrationDynamicRegions, hydrationDynamicRegionErrors, bind };
export const runLargeBranchCase = () => {
  const root = document.createElement("div");
  document.body.append(root);
  root.innerHTML = ${JSON.stringify(largeBranchMarkup)};
  const serverList = root.querySelector("ul");
  const serverFooter = root.querySelector("footer");
  const visible = createSignal(true);
  const last = createSignal("Client last");
  const tail = createSignal("Client tail");
  const started = performance.now();
  const result = hydrate(root, clientModule, { visible, last, tail });
  const hydrateMs = performance.now() - started;
  if (!result.ok) {
    root.remove();
    return { ok: false, message: result.error.message };
  }
  const adoptedServerList = root.querySelector("ul") === serverList;
  const adoptedRows = root.querySelectorAll("li").length;
  const lastUpdated = root.querySelector("ul").lastElementChild.textContent === "Client last";
  const hideStarted = performance.now();
  visible.set(false);
  const hideMs = performance.now() - hideStarted;
  const hiddenRows = root.querySelectorAll("li").length;
  tail.set("Tail while hidden");
  const footerStable = root.querySelector("footer") === serverFooter;
  const footerUpdated = serverFooter.textContent === "Tail while hidden";
  const showStarted = performance.now();
  visible.set(true);
  const showMs = performance.now() - showStarted;
  const shownRows = root.querySelectorAll("li").length;
  const recreatedList = root.querySelector("ul") !== serverList;
  last.set("Second last");
  const secondLastUpdated = root.querySelector("ul").lastElementChild.textContent === "Second last";
  const footerAfterShow = root.querySelector("footer") === serverFooter;
  visible.set(false);
  const finalRows = root.querySelectorAll("li").length;
  result.value.dispose();
  root.remove();
  return {
    ok: true,
    message: "",
    rows: ${largeBranchRows} + 1,
    adoptedServerList,
    adoptedRows,
    lastUpdated,
    hiddenRows,
    footerStable,
    footerUpdated,
    shownRows,
    recreatedList,
    secondLastUpdated,
    footerAfterShow,
    finalRows,
    hydrateMs,
    hideMs,
    showMs,
  };
};
`,
  };

  await Promise.all(
    [
      ...sharedParentModules,
      ...conditionalShapeModules,
      ...dynamicShapeModules,
      dynamicAttributeModule,
      componentSplitModule,
      listFooterModule,
      listHeaderModule,
      listTextOnlyModule,
      listConditionalModule,
      largeBranchModule,
    ].map(({ fileName, source: generatedSource }) => writeFile(resolve(outDir, fileName), generatedSource)),
  );
  const sharedImports = sharedParentModules
    .map(
      ({ fileName }, index) =>
        `import { runSharedParentGuard as runSharedParent${index === 0 ? "Before" : "After"} } from "./${fileName}";`,
    )
    .join("\n");
  const followupImports = [
    ...conditionalShapeModules.map(
      ({ fileName }, index) =>
        `import { runConditionalShapeCase as runConditionalShape${index} } from "./${fileName}";`,
    ),
    ...dynamicShapeModules.map(
      ({ fileName }, index) => `import { runDynamicShapeCase as runDynamicShape${index} } from "./${fileName}";`,
    ),
    `import { runDynamicAttributeCase } from "./${dynamicAttributeModule.fileName}";`,
    `import { runComponentSplitCase } from "./${componentSplitModule.fileName}";`,
    `import { runListFooterCase } from "./${listFooterModule.fileName}";`,
    `import { runListHeaderCase } from "./${listHeaderModule.fileName}";`,
    `import { runListTextOnlyCase } from "./${listTextOnlyModule.fileName}";`,
    `import { runListSeparateParentCase } from "./${listConditionalModule.fileName}";`,
    `import { runLargeBranchCase } from "./${largeBranchModule.fileName}";`,
  ].join("\n");
  await writeFile(
    entrySource,
    `import { createSignal } from "tachyon-dom";
import { hydrate, mount } from "tachyon-dom/runtime/mount";
${sharedImports}
${followupImports}
${generated}
const hydrationDynamicRegionErrors = hydrationDynamicRegions.errors ?? [];
const clientModule = { templateHtml, hydrationBoundaries, hydrationDynamicAttributes, hydrationDynamicRegions, hydrationDynamicRegionErrors, bind };
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
  return {
    mount: mountResult,
    hydrate: hydrateResult,
    sharedParent: { before: runSharedParentBefore(), after: runSharedParentAfter() },
    conditionalShapes: [runConditionalShape0(), runConditionalShape1()],
    dynamicShapes: [${dynamicShapeModules.map((_, index) => `runDynamicShape${index}()`).join(", ")}],
    dynamicAttributes: runDynamicAttributeCase(),
    componentSplit: runComponentSplitCase(),
    listFooter: runListFooterCase(),
    listHeader: runListHeaderCase(),
    listTextOnly: runListTextOnlyCase(),
    listSeparateParent: runListSeparateParentCase(),
    largeBranch: runLargeBranchCase(),
  };
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
