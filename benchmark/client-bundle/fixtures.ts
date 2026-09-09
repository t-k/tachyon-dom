import { mkdir, symlink, writeFile } from "node:fs/promises";
import path from "node:path";

/**
 * An interactive page built as an ordinary Tachyon DOM route app and measured as a browser would fetch it.
 *
 * Every fixture is a `src/routes` tree plus a `src/client/main.ts` entry that hydrates the server-rendered
 * page through the public runtime. The project is built with the published package entry points through the
 * starter's Vite configuration, so the numbers describe the production build path rather than an esbuild
 * snippet.
 */
export type ClientBundleFixture = {
  name: string;
  description: string;
  /** Route path measured as the initial page load. */
  initialPath: string;
  /** Route directory (relative to `src/routes`) to `page.td` source. */
  routes: Readonly<Record<string, string>>;
  /** Source of `src/client/main.ts`. */
  clientEntry: string;
  /** Interaction that must work after hydration before the measurement is recorded. */
  validate: {
    click: string;
    expect: { selector: string; text: string };
  };
};

const counterPage = `<script lang="ts">
export const scope = () => ({ count: 0 });
</script>
<section>
  <h1>Counter</h1>
  <button id="increment" on:click={increment}>Increment</button>
  <output id="count">{count}</output>
</section>
`;

const counterEntry = `import * as Page from "../routes/index/page.td?client&hydrate-only";
import { hydrate } from "tachyon-dom/runtime/mount";
import { createSignal } from "tachyon-dom/runtime/signal";

const root = document.querySelector("#app");
if (!(root instanceof HTMLElement)) throw new Error("Missing app root.");
const count = createSignal(0);
const result = hydrate(root, Page, { count, increment: () => count.update((value) => value + 1) });
if (!result.ok) throw new Error(result.error.message);
`;

const keyedListPage = `<script lang="ts">
export const scope = () => ({
  rows: [
    { id: 1, label: "Row 1" },
    { id: 2, label: "Row 2" },
    { id: 3, label: "Row 3" },
  ],
  selectedId: 0,
});
</script>
<section>
  <h1>Rows</h1>
  <button id="add" on:click={add}>Add row</button>
  <button id="clear" on:click={clear}>Clear rows</button>
  <ul id="rows">
    <for each={rows} key={row.id}>
      <li class:active={row.id === selectedId} on:click={select(row)}>{row.label}</li>
    </for>
  </ul>
</section>
`;

const keyedListEntry = `import * as Page from "../routes/index/page.td?client&hydrate-only";
import { hydrate } from "tachyon-dom/runtime/mount";
import { createSignal } from "tachyon-dom/runtime/signal";

type Row = { id: number; label: string };

const root = document.querySelector("#app");
if (!(root instanceof HTMLElement)) throw new Error("Missing app root.");
const rows = createSignal<Row[]>([
  { id: 1, label: "Row 1" },
  { id: 2, label: "Row 2" },
  { id: 3, label: "Row 3" },
]);
const selectedId = createSignal(0);
let nextId = 4;
const result = hydrate(root, Page, {
  rows,
  selectedId,
  add: () => {
    const id = nextId++;
    rows.update((value) => [...value, { id, label: \`Row \${id}\` }]);
  },
  clear: () => rows.set([]),
  select: (row: Row) => () => selectedId.set(row.id),
});
if (!result.ok) throw new Error(result.error.message);
`;

const formPage = `<script lang="ts">
export const scope = () => ({ name: "", email: "" });
</script>
<section>
  <h1>Contact</h1>
  <form on:submit={submit}>
    <label>Name <input id="name" name="name" bind:value={name}></label>
    <label>Email <input id="email" name="email" type="email" bind:value={email}></label>
    <button id="save" type="submit">Save</button>
  </form>
  <output id="status">{status}</output>
</section>
`;

const formEntry = `import * as Page from "../routes/index/page.td?client&hydrate-only";
import { hydrate } from "tachyon-dom/runtime/mount";
import { createMemo, createSignal } from "tachyon-dom/runtime/signal";

const root = document.querySelector("#app");
if (!(root instanceof HTMLElement)) throw new Error("Missing app root.");
const name = createSignal("");
const email = createSignal("");
const saved = createSignal(false);
const status = createMemo(() => {
  if (saved()) return \`Saved \${name() || "anonymous"}\`;
  return email().includes("@") ? "Ready" : "";
});
const result = hydrate(root, Page, {
  name,
  email,
  status,
  submit: (event: Event) => {
    event.preventDefault();
    saved.set(true);
  },
});
if (!result.ok) throw new Error(result.error.message);
`;

// The conditional region is written without surrounding whitespace text nodes on purpose: the initial
// branch is empty on the server, and whitespace siblings around an empty region are not hydrated yet.
const conditionalPage = `<script lang="ts">
export const scope = () => ({ open: false });
</script>
<section>
  <h1>Details</h1>
  <button id="toggle" on:click={toggle}>Toggle details</button><if test={open}><p id="details">Details are open.</p></if>
</section>
`;

const conditionalEntry = `import * as Page from "../routes/index/page.td?client&hydrate-only";
import { hydrate } from "tachyon-dom/runtime/mount";
import { createSignal } from "tachyon-dom/runtime/signal";

const root = document.querySelector("#app");
if (!(root instanceof HTMLElement)) throw new Error("Missing app root.");
const open = createSignal(false);
const result = hydrate(root, Page, { open, toggle: () => open.update((value) => !value) });
if (!result.ok) throw new Error(result.error.message);
`;

const multiRouteHomePage = `<script lang="ts">
export const scope = () => ({ count: 0 });
</script>
<section>
  <h1>Home</h1>
  <nav><a href="/about/">About</a></nav>
  <button id="increment" on:click={increment}>Increment</button>
  <output id="count">{count}</output>
</section>
`;

const multiRouteAboutPage = `<script lang="ts">
export const scope = () => ({ title: "About" });
</script>
<section>
  <h1>{title}</h1>
  <nav><a href="/">Home</a></nav>
</section>
`;

const multiRouteEntry = `import * as HomePage from "../routes/index/page.td?client";
import * as AboutPage from "../routes/about/page.td?client";
import { hydrate, mount } from "tachyon-dom/runtime/mount";
import { createClientRouter } from "tachyon-dom/runtime/router";
import { createSignal } from "tachyon-dom/runtime/signal";

// The server-rendered page is hydrated first; the router adopts it and mounts the other pages on navigation.
const root = document.querySelector("#app");
if (!(root instanceof HTMLElement)) throw new Error("Missing app root.");
const count = createSignal(0);
const title = createSignal("About");
const pages = {
  "/": { module: HomePage, scope: () => ({ count, increment: () => count.update((value) => value + 1) }) },
  "/about/": { module: AboutPage, scope: () => ({ title }) },
};
const current = pages[location.pathname as keyof typeof pages];
const hydrated = current ? hydrate(root, current.module, current.scope()) : undefined;
if (hydrated && !hydrated.ok) throw new Error(hydrated.error.message);
const view = (page: (typeof pages)[keyof typeof pages]) => {
  const container = document.createElement("div");
  const handle = mount(container, page.module, page.scope());
  return { value: container, dispose: () => handle.dispose() };
};
const router = createClientRouter({
  root: document.body,
  routes: [
    { path: "/", target: "#app", render: () => view(pages["/"]) },
    { path: "/about/", target: "#app", render: () => view(pages["/about/"]) },
  ],
  adopt: () => hydrated?.ok && hydrated.value.dispose(),
  focusSelector: "h1",
});
await router.start();
`;

export const clientBundleFixtures: readonly ClientBundleFixture[] = [
  {
    name: "counter",
    description: "A server-rendered counter hydrated with one signal and one click handler.",
    initialPath: "/",
    routes: { index: counterPage },
    clientEntry: counterEntry,
    validate: { click: "#increment", expect: { selector: "#count", text: "1" } },
  },
  {
    name: "keyed-list",
    description: "A keyed row list with add, clear, and selection class toggling.",
    initialPath: "/",
    routes: { index: keyedListPage },
    clientEntry: keyedListEntry,
    validate: { click: "#add", expect: { selector: "#rows li:nth-child(4)", text: "Row 4" } },
  },
  {
    name: "form",
    description: "A contact form with two-way input bindings and a submit handler.",
    initialPath: "/",
    routes: { index: formPage },
    clientEntry: formEntry,
    validate: { click: "#save", expect: { selector: "#status", text: "Saved anonymous" } },
  },
  {
    name: "conditional",
    description: "A details panel toggled through a conditional region.",
    initialPath: "/",
    routes: { index: conditionalPage },
    clientEntry: conditionalEntry,
    validate: { click: "#toggle", expect: { selector: "#details", text: "Details are open." } },
  },
  {
    name: "multi-route",
    description: "A hydrated page adopted by a client router that mounts the other page on navigation.",
    initialPath: "/",
    routes: { index: multiRouteHomePage, about: multiRouteAboutPage },
    clientEntry: multiRouteEntry,
    validate: { click: "a[href='/about/']", expect: { selector: "h1", text: "About" } },
  },
];

const viteConfigSource = `import { defineConfig } from "vite";
import { loadRouteApp, tachyonApp, tachyonDom } from "tachyon-dom/vite";

const templateWhitespace = "condense" as const;
const app = await loadRouteApp({
  lang: "en",
  routesDir: "src/routes",
  title: "Tachyon App",
  templateWhitespace,
});

export default defineConfig({
  build: {
    rollupOptions: {
      input: "src/client/main.ts",
    },
  },
  plugins: [tachyonDom({ reactive: true, templateWhitespace }), tachyonApp(app, { appScript: "/src/client/main.ts" })],
});
`;

export type MaterializeOptions = {
  /** Directory that receives one project directory per fixture. */
  workDir: string;
  /** Checkout whose built package is linked as `node_modules/tachyon-dom`. */
  packageRoot: string;
};

/**
 * Write the fixture as a starter-shaped project and link the checkout's package and Vite into it.
 *
 * `tachyon-dom` resolves through the checkout's `package.json` exports, so the measured code is the same
 * `dist/` output that gets published.
 */
export const materializeClientBundleFixture = async (
  fixture: ClientBundleFixture,
  options: MaterializeOptions,
): Promise<string> => {
  const projectDir = path.join(options.workDir, fixture.name);
  const nodeModules = path.join(projectDir, "node_modules");
  await mkdir(nodeModules, { recursive: true });
  await mkdir(path.join(projectDir, "src", "client"), { recursive: true });
  for (const [route, source] of Object.entries(fixture.routes)) {
    const routeDir = path.join(projectDir, "src", "routes", route);
    await mkdir(routeDir, { recursive: true });
    await writeFile(path.join(routeDir, "page.td"), source);
  }
  await writeFile(path.join(projectDir, "src", "client", "main.ts"), fixture.clientEntry);
  await writeFile(path.join(projectDir, "vite.config.ts"), viteConfigSource);
  await writeFile(path.join(projectDir, "package.json"), '{"private":true,"type":"module"}\n');
  await symlink(path.resolve(options.packageRoot), path.join(nodeModules, "tachyon-dom"), "dir");
  await symlink(
    path.join(path.resolve(options.packageRoot), "node_modules", "vite"),
    path.join(nodeModules, "vite"),
    "dir",
  );
  return projectDir;
};
