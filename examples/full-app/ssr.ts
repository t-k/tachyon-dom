import { dirname, resolve } from "node:path";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { compileTemplate, generateClientModule, renderServerTemplate } from "../../src/compiler";

type MessageKey =
  | "activity"
  | "activityCounter"
  | "activityRouteState"
  | "activityRows"
  | "addRow"
  | "allRows"
  | "appName"
  | "comfortableMode"
  | "compactMode"
  | "compiler"
  | "compilerTitle"
  | "counter"
  | "counterTitle"
  | "decrement"
  | "displayName"
  | "doubleStep"
  | "email"
  | "forms"
  | "formsTitle"
  | "generatedClient"
  | "increment"
  | "keyedRows"
  | "lists"
  | "listsTitle"
  | "memo"
  | "openOnly"
  | "overview"
  | "overviewDescription"
  | "overviewHeadline"
  | "overviewTitle"
  | "projectedHelp"
  | "reset"
  | "role"
  | "roleDesignSystems"
  | "roleMetric"
  | "roleRouter"
  | "roleRuntime"
  | "rotateRows"
  | "saveProfile"
  | "selection"
  | "settings"
  | "settingsTitle"
  | "signalCount"
  | "step"
  | "streamOutput"
  | "summary"
  | "template"
  | "themeLight";

type DemoRow = {
  id: number;
  label: string;
  owner: string;
  status: "open" | "done";
};

type ProfileState = {
  displayName: string;
  email: string;
  role: string;
  density: "compact" | "comfortable";
  theme: "system" | "light";
  status: string;
};

type PageTemplate = {
  source: string;
};

export type FullAppDocumentAssets = {
  scripts?: readonly string[];
  styles?: readonly string[];
};

const root = dirname(fileURLToPath(import.meta.url));

const messages: Record<"en", Record<MessageKey, string>> = {
  en: {
    activity: "Activity",
    activityCounter: "Counters use createSignal, createMemo, and batch.",
    activityRouteState: "Route state is handled by runtime/router.",
    activityRows: "Rows use mountKeyedList with compiled readers.",
    addRow: "Add row",
    allRows: "All rows",
    appName: "Tachyon Full App",
    comfortableMode: "Comfortable",
    compactMode: "Compact",
    compiler: "Compiler",
    compilerTitle: "Compiler",
    counter: "Counter",
    counterTitle: "Counter",
    decrement: "Decrement",
    displayName: "Display name",
    doubleStep: "Double step",
    email: "Email",
    forms: "Forms",
    formsTitle: "Forms",
    generatedClient: "Generated client",
    increment: "Increment",
    keyedRows: "keyed rows",
    lists: "Lists",
    listsTitle: "Lists",
    memo: "Memo",
    openOnly: "Open only",
    overview: "Overview",
    overviewDescription: "The shell stays mounted while the outlet swaps pages through the client router.",
    overviewHeadline: "Persistent layout with route-level tools",
    overviewTitle: "Overview",
    projectedHelp: "Projected value is count plus two steps.",
    reset: "Reset",
    role: "Role",
    roleDesignSystems: "Design systems",
    roleMetric: "role",
    roleRouter: "Router",
    roleRuntime: "Runtime",
    rotateRows: "Rotate rows",
    saveProfile: "Save profile",
    selection: "Selection",
    settings: "Settings",
    settingsTitle: "Settings",
    signalCount: "signal count",
    step: "step",
    streamOutput: "Stream output",
    summary: "Summary",
    template: "Template",
    themeLight: "Theme: light",
  },
};

const t = (key: MessageKey, values: Record<string, string | number> = {}): string =>
  Object.entries(values).reduce((text, [name, value]) => text.replaceAll(`{${name}}`, String(value)), messages.en[key]);

const copy = (): Record<string, string> => ({
  activity: t("activity"),
  activityCounter: t("activityCounter"),
  activityRouteState: t("activityRouteState"),
  activityRows: t("activityRows"),
  addRow: t("addRow"),
  comfortableMode: t("comfortableMode"),
  compactMode: t("compactMode"),
  decrement: t("decrement"),
  displayName: t("displayName"),
  doubleStep: t("doubleStep"),
  email: t("email"),
  formsTitle: t("formsTitle"),
  generatedClient: t("generatedClient"),
  increment: t("increment"),
  keyedRows: t("keyedRows"),
  memo: t("memo"),
  overviewDescription: t("overviewDescription"),
  overviewHeadline: t("overviewHeadline"),
  projectedHelp: t("projectedHelp"),
  reset: t("reset"),
  role: t("role"),
  roleDesignSystems: t("roleDesignSystems"),
  roleMetric: t("roleMetric"),
  roleRouter: t("roleRouter"),
  roleRuntime: t("roleRuntime"),
  rotateRows: t("rotateRows"),
  saveProfile: t("saveProfile"),
  selection: t("selection"),
  settingsTitle: t("settingsTitle"),
  signalCount: t("signalCount"),
  step: t("step"),
  streamOutput: t("streamOutput"),
  summary: t("summary"),
  template: t("template"),
  themeLight: t("themeLight"),
});

const escapeHtml = (value: string): string =>
  value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");

const initialRows = (): DemoRow[] => [
  { id: 1, label: "Compiler bindings", owner: "Runtime", status: "open" },
  { id: 2, label: "Client router", owner: "Router", status: "open" },
  { id: 3, label: "Stream chunks", owner: "Server", status: "done" },
];

const defaultProfile = (): ProfileState => ({
  density: "comfortable",
  displayName: "Guest operator",
  email: "guest@example.com",
  role: "Runtime",
  status: "",
  theme: "system",
});

export const normalizedFullAppPath = (path: string): string => {
  if (path === "" || path === "/" || path === "/index.html") {
    return "/";
  }
  const withoutIndex = path.endsWith("/index.html") ? path.slice(0, -"index.html".length) : path;
  return withoutIndex.endsWith("/") ? withoutIndex : `${withoutIndex}/`;
};

const pageTitleForPath = (path: string): MessageKey => {
  switch (normalizedFullAppPath(path)) {
    case "/counter/":
      return "counterTitle";
    case "/lists/":
      return "listsTitle";
    case "/forms/":
      return "formsTitle";
    case "/compiler/":
      return "compilerTitle";
    case "/settings/":
      return "settingsTitle";
    default:
      return "overviewTitle";
  }
};

const pageSource = (relativePath: string): PageTemplate => ({
  source: readFileSync(resolve(root, relativePath), "utf8"),
});

const pageTemplates = {
  "/": pageSource("overview/page.td"),
  "/compiler/": pageSource("compiler/page.td"),
  "/counter/": pageSource("counter/page.td"),
  "/forms/": pageSource("forms/page.td"),
  "/lists/": pageSource("lists/page.td"),
  "/settings/": pageSource("settings/page.td"),
} satisfies Record<string, PageTemplate>;

const compiledPageCache = new Map<string, ReturnType<typeof compileTemplate>>();

const renderTemplateHtml = (entry: PageTemplate, scope: Record<string, unknown>): string => {
  const cached = compiledPageCache.get(entry.source);
  const compiledPage = cached ?? compileTemplate(entry.source);
  compiledPageCache.set(entry.source, compiledPage);
  if (!compiledPage.ok) {
    throw new Error(compiledPage.error.message);
  }
  return renderServerTemplate(compiledPage.value, scope);
};

const templateSource = `<section><h2>{title}</h2><ul><for each={rows} key={row.id}><li class:done={row.status === "done"}>{row.label}</li></for></ul></section>`;
const compiledResult = compileTemplate(templateSource);
if (!compiledResult.ok) {
  throw new Error(compiledResult.error.message);
}
const compiled = compiledResult.value;
const generatedClient = generateClientModule(compiled, { reactive: true });

const overviewScope = (state: { count: unknown; rowCount: unknown; role: unknown }): Record<string, unknown> => ({
  count: state.count,
  copy: copy(),
  role: state.role,
  rowCount: state.rowCount,
});

const compilerScope = (state: { rows: DemoRow[]; streamOutput?: string }): Record<string, unknown> => ({
  copy: copy(),
  generatedClient,
  streamOutput: state.streamOutput ?? renderServerTemplate(compiled, { rows: state.rows, title: "Compiled stream" }),
  templateSource,
});

const renderRouteHtml = (
  path: string,
  state: { count: number; step: number; rows: DemoRow[]; openOnly: boolean; profile: ProfileState },
): string => {
  switch (normalizedFullAppPath(path)) {
    case "/counter/":
      return renderTemplateHtml(pageTemplates["/counter/"], {
        copy: copy(),
        count: state.count,
        decrement: () => undefined,
        doubleStep: () => undefined,
        increment: () => undefined,
        projected: state.count + state.step * 2,
        resetCounter: () => undefined,
        step: state.step,
      });
    case "/lists/":
      return renderTemplateHtml(pageTemplates["/lists/"], {
        addRow: () => undefined,
        copy: copy(),
        rotateRows: () => undefined,
        rowMode: state.openOnly ? t("openOnly") : t("allRows"),
        toggleLabel: state.openOnly ? t("allRows") : t("openOnly"),
        toggleOpenOnly: () => undefined,
        visibleRows: state.rows,
      });
    case "/forms/":
      return renderTemplateHtml(pageTemplates["/forms/"], {
        copy: copy(),
        profile: state.profile,
        saveProfile: () => undefined,
      });
    case "/compiler/":
      return renderTemplateHtml(pageTemplates["/compiler/"], compilerScope({ rows: state.rows }));
    case "/settings/":
      return renderTemplateHtml(pageTemplates["/settings/"], {
        copy: copy(),
        setComfortable: () => undefined,
        setCompact: () => undefined,
        toggleTheme: () => undefined,
      });
    default:
      return renderTemplateHtml(
        pageTemplates["/"],
        overviewScope({ count: state.count, role: state.profile.role, rowCount: state.rows.length }),
      );
  }
};

export const renderFullAppShellHtml = (path = "/"): string => {
  const rows = initialRows();
  const profile = defaultProfile();
  const activePath = normalizedFullAppPath(path);
  return `
    <section class="app-shell" data-testid="app-shell" data-ssr-route="${escapeHtml(activePath)}">
      <aside class="sidebar" aria-label="Primary">
        <a class="brand" href="/">${t("appName")}</a>
        <nav class="nav-list" aria-label="Pages">
          <a href="/" data-nav${activePath === "/" ? ' aria-current="true"' : ""}>${t("overview")}</a>
          <a href="/counter/" data-nav${activePath === "/counter/" ? ' aria-current="true"' : ""}>${t("counter")}</a>
          <a href="/lists/" data-nav${activePath === "/lists/" ? ' aria-current="true"' : ""}>${t("lists")}</a>
          <a href="/forms/" data-nav${activePath === "/forms/" ? ' aria-current="true"' : ""}>${t("forms")}</a>
          <a href="/compiler/" data-nav${activePath === "/compiler/" ? ' aria-current="true"' : ""}>${t("compiler")}</a>
          <a href="/settings/" data-nav${activePath === "/settings/" ? ' aria-current="true"' : ""}>${t("settings")}</a>
        </nav>
      </aside>
      <section class="workspace">
        <header class="topbar">
          <div>
            <p class="eyebrow">${t("appName")}</p>
            <h1 data-testid="route-title">${t(pageTitleForPath(activePath))}</h1>
          </div>
          <div class="summary-strip" aria-label="${t("summary")}">
            <span><b data-testid="summary-count">0</b> count</span>
            <span><b data-testid="summary-rows">${rows.length}</b> rows</span>
            <span><b data-testid="summary-profile">${escapeHtml(profile.displayName)}</b></span>
          </div>
        </header>
        <div id="route-outlet" class="route-outlet">${renderRouteHtml(activePath, { count: 0, step: 1, rows, openOnly: false, profile })}</div>
        <div id="route-live" class="visually-hidden" aria-live="polite"></div>
      </section>
    </section>
  `;
};

const defaultAssets = (assetPrefix: string): Required<FullAppDocumentAssets> => ({
  scripts: [`${assetPrefix}/main.ts`],
  styles: [`${assetPrefix}/styles.css`],
});

export const renderFullAppDocument = (
  path = "/",
  assetPrefix = ".",
  assets: FullAppDocumentAssets = defaultAssets(assetPrefix),
): string => {
  const resolvedAssets = { ...defaultAssets(assetPrefix), ...assets };
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>Tachyon DOM Full App Example</title>
    ${resolvedAssets.styles.map((href) => `<link rel="stylesheet" href="${href}" />`).join("\n    ")}
    ${resolvedAssets.scripts.map((src) => `<script type="module" src="${src}"></script>`).join("\n    ")}
  </head>
  <body>
    <main id="app">${renderFullAppShellHtml(path)}</main>
  </body>
</html>
`;
};
