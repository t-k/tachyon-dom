import "./styles.css";
import * as compilerTemplate from "./compiler/page.td";
import compilerPageSource from "./compiler/page.td?raw";
import * as counterTemplate from "./counter/page.td";
import counterPageSource from "./counter/page.td?raw";
import * as formsTemplate from "./forms/page.td";
import formsPageSource from "./forms/page.td?raw";
import * as listsTemplate from "./lists/page.td";
import listsPageSource from "./lists/page.td?raw";
import * as overviewTemplate from "./overview/page.td";
import overviewPageSource from "./overview/page.td?raw";
import * as settingsTemplate from "./settings/page.td";
import settingsPageSource from "./settings/page.td?raw";
import {
  compileTemplate,
  generateClientModule,
  generateServerStreamModule,
  renderServerTemplate,
} from "../../src/compiler";
import { err, ok, type Result } from "../../src/result";
import { createClientRouter, type ClientRouter, type ClientRouteDefinition } from "../../src/runtime/router";
import { batch, createMemo, createSignal, effect } from "../../src/runtime/signal";
import { createStore } from "../../src/runtime/store";
import { readTextStreamChunks } from "../../src/runtime/stream-client";
import { renderToReadableStream } from "../../src/server/stream";

type MessageKey =
  | "appName"
  | "overview"
  | "counter"
  | "lists"
  | "forms"
  | "compiler"
  | "settings"
  | "overviewTitle"
  | "counterTitle"
  | "listsTitle"
  | "formsTitle"
  | "compilerTitle"
  | "settingsTitle"
  | "increment"
  | "decrement"
  | "doubleStep"
  | "reset"
  | "addRow"
  | "rotateRows"
  | "openOnly"
  | "allRows"
  | "saveProfile"
  | "displayName"
  | "email"
  | "role"
  | "nameRequired"
  | "emailRequired"
  | "savedProfile"
  | "compactMode"
  | "comfortableMode"
  | "theme"
  | "summary"
  | "activity"
  | "activityCounter"
  | "activityRouteState"
  | "activityRows"
  | "generatedClient"
  | "keyedRows"
  | "memo"
  | "overviewDescription"
  | "overviewHeadline"
  | "projectedHelp"
  | "roleMetric"
  | "roleDesignSystems"
  | "roleRouter"
  | "roleRuntime"
  | "selection"
  | "signalCount"
  | "step"
  | "streamOutput"
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

type FullAppInstance = {
  router: ClientRouter;
  dispose: () => void;
};

type StreamModule = {
  stream: (scope: { rows: DemoRow[]; title: string }) => AsyncIterable<string>;
};

type TachyonTemplateModule = {
  templateHtml: string;
  bind: (root: Element, scope: Record<string, unknown>) => void | (() => void);
};

type PageTemplate = {
  source: string;
  template: TachyonTemplateModule;
};

const basePath = "";

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
    emailRequired: "Enter a valid email address.",
    forms: "Forms",
    formsTitle: "Forms",
    generatedClient: "Generated client",
    increment: "Increment",
    keyedRows: "keyed rows",
    lists: "Lists",
    listsTitle: "Lists",
    memo: "Memo",
    nameRequired: "Enter a display name.",
    openOnly: "Open only",
    overview: "Overview",
    overviewDescription: "The shell stays mounted while the outlet swaps pages through the client router.",
    overviewHeadline: "Persistent layout with route-level tools",
    overviewTitle: "Overview",
    projectedHelp: "Projected value is count plus two steps.",
    reset: "Reset",
    role: "Role",
    roleDesignSystems: "Design systems",
    roleRouter: "Router",
    roleRuntime: "Runtime",
    roleMetric: "role",
    rotateRows: "Rotate rows",
    saveProfile: "Save profile",
    savedProfile: "Saved {name}.",
    selection: "Selection",
    settings: "Settings",
    settingsTitle: "Settings",
    signalCount: "signal count",
    step: "step",
    streamOutput: "Stream output",
    summary: "Summary",
    template: "Template",
    theme: "Theme",
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

const htmlElement = (html: string): HTMLElement => {
  const template = document.createElement("template");
  template.innerHTML = html.trim();
  const element = template.content.firstElementChild;
  if (!(element instanceof HTMLElement)) {
    throw new Error("Expected an HTMLElement.");
  }
  return element;
};

const fullPath = (path = ""): string => `${basePath}${path}`;

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

const normalizedPath = (path: string): string => {
  if (path === "" || path === "/") {
    return "/";
  }
  return path.endsWith("/") ? path : `${path}/`;
};

const pageTemplates = {
  "/": { source: overviewPageSource, template: overviewTemplate },
  "/compiler/": { source: compilerPageSource, template: compilerTemplate },
  "/counter/": { source: counterPageSource, template: counterTemplate },
  "/forms/": { source: formsPageSource, template: formsTemplate },
  "/lists/": { source: listsPageSource, template: listsTemplate },
  "/settings/": { source: settingsPageSource, template: settingsTemplate },
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

const mountTemplate = (
  entry: PageTemplate,
  scope: Record<string, unknown>,
): { element: HTMLElement; cleanup: () => void } => {
  const element = htmlElement(entry.template.templateHtml);
  const cleanup = entry.template.bind(element, scope);
  return { element, cleanup: typeof cleanup === "function" ? cleanup : () => undefined };
};

const pageTitleForPath = (path: string): MessageKey => {
  switch (normalizedPath(path)) {
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
  switch (normalizedPath(path)) {
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
  const activePath = normalizedPath(path);
  return `
    <section class="app-shell" data-testid="app-shell" data-ssr-route="${escapeHtml(activePath)}">
      <aside class="sidebar" aria-label="Primary">
        <a class="brand" href="${fullPath("/")}">${t("appName")}</a>
        <nav class="nav-list" aria-label="Pages">
          <a href="${fullPath("/")}" data-nav${activePath === "/" ? ' aria-current="true"' : ""}>${t("overview")}</a>
          <a href="${fullPath("/counter/")}" data-nav${activePath === "/counter/" ? ' aria-current="true"' : ""}>${t("counter")}</a>
          <a href="${fullPath("/lists/")}" data-nav${activePath === "/lists/" ? ' aria-current="true"' : ""}>${t("lists")}</a>
          <a href="${fullPath("/forms/")}" data-nav${activePath === "/forms/" ? ' aria-current="true"' : ""}>${t("forms")}</a>
          <a href="${fullPath("/compiler/")}" data-nav${activePath === "/compiler/" ? ' aria-current="true"' : ""}>${t("compiler")}</a>
          <a href="${fullPath("/settings/")}" data-nav${activePath === "/settings/" ? ' aria-current="true"' : ""}>${t("settings")}</a>
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

export const renderFullAppDocument = (path = "/", assetPrefix = "."): string => `<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>Tachyon DOM Full App Example</title>
    <link rel="stylesheet" href="${assetPrefix}/styles.css" />
    <script type="module" src="${assetPrefix}/main.ts"></script>
  </head>
  <body>
    <main id="app">${renderFullAppShellHtml(path)}</main>
  </body>
</html>
`;

const templateSource = `<section><h2>{title}</h2><ul><for each={rows} key={row.id}><li class:done={row.status === "done"}>{row.label}</li></for></ul></section>`;
const compiledResult = compileTemplate(templateSource);
if (!compiledResult.ok) {
  throw new Error(compiledResult.error.message);
}
const compiled = compiledResult.value;
const generatedClient = generateClientModule(compiled, { reactive: true });
const generatedStreamModule = generateServerStreamModule(compiled);

const encodeBase64 = (value: string): string => btoa(value);

const importStreamModule = async (): Promise<StreamModule> =>
  (await import(
    /* @vite-ignore */ `data:text/javascript;base64,${encodeBase64(generatedStreamModule)}`
  )) as StreamModule;

const readGeneratedStream = async (rows: DemoRow[]): Promise<string> => {
  const module = await importStreamModule();
  const chunks: string[] = [];
  for await (const chunk of module.stream({ rows, title: "Compiled stream" })) {
    chunks.push(chunk);
  }
  const stream = renderToReadableStream(chunks);
  return (await readTextStreamChunks(stream)).join("");
};

const profileResult = (form: HTMLFormElement): Result<ProfileState, string> => {
  const data = new FormData(form);
  const displayName = String(data.get("displayName") ?? "").trim();
  const email = String(data.get("email") ?? "")
    .trim()
    .toLowerCase();
  const role = String(data.get("role") ?? "");
  if (!displayName) {
    return err(t("nameRequired"));
  }
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return err(t("emailRequired"));
  }
  return ok({
    density: "comfortable",
    displayName,
    email,
    role,
    status: t("savedProfile", { name: displayName }),
    theme: "system",
  });
};

export const mountFullAppExample = async (root: HTMLElement): Promise<FullAppInstance> => {
  const count = createSignal(0);
  const step = createSignal(1);
  const projected = createMemo(() => count() + step() * 2);
  const rows = createSignal<DemoRow[]>(initialRows());
  const rowCount = createMemo(() => rows().length);
  const openOnly = createSignal(false);
  const visibleRows = createMemo(() => rows().filter((row) => !openOnly() || row.status === "open"));
  const rowMode = createMemo(() => (openOnly() ? t("openOnly") : t("allRows")));
  const toggleLabel = createMemo(() => (openOnly() ? t("allRows") : t("openOnly")));
  const profile = createStore<ProfileState>(defaultProfile());
  const cleanups: Array<() => void> = [];
  let routeCleanups: Array<() => void> = [];

  const register = (cleanup: () => void): void => {
    cleanups.push(cleanup);
  };
  const clearRoute = (): void => {
    for (const cleanup of routeCleanups) {
      cleanup();
    }
    routeCleanups = [];
  };
  const registerRoute = (cleanup: () => void): void => {
    routeCleanups.push(cleanup);
  };

  if (!(root.querySelector("[data-testid='app-shell']") instanceof HTMLElement)) {
    root.innerHTML = renderFullAppShellHtml();
  }

  const title = root.querySelector("[data-testid='route-title']");
  const summaryCount = root.querySelector("[data-testid='summary-count']");
  const summaryRows = root.querySelector("[data-testid='summary-rows']");
  const summaryProfile = root.querySelector("[data-testid='summary-profile']");

  register(
    effect(() => {
      if (summaryCount) summaryCount.textContent = String(count());
    }),
  );
  register(
    effect(() => {
      if (summaryRows) summaryRows.textContent = String(rows().length);
    }),
  );
  register(
    effect(() => {
      if (summaryProfile) summaryProfile.textContent = profile.displayName;
    }),
  );

  const setPageTitle = (key: MessageKey): void => {
    if (title) {
      title.textContent = t(key);
    }
  };

  const setActiveNav = (pathname: string): void => {
    root.querySelectorAll<HTMLAnchorElement>("[data-nav]").forEach((link) => {
      link.toggleAttribute("aria-current", link.pathname === pathname);
    });
  };

  const routePage = (key: MessageKey, pathname: string, element: HTMLElement): HTMLElement => {
    clearRoute();
    setPageTitle(key);
    setActiveNav(pathname);
    return element;
  };

  const mountRouteTemplate = (
    key: MessageKey,
    pathname: string,
    entry: PageTemplate,
    scope: Record<string, unknown>,
  ): HTMLElement => {
    const mounted = mountTemplate(entry, scope);
    const page = routePage(key, pathname, mounted.element);
    registerRoute(mounted.cleanup);
    return page;
  };

  const renderOverview = ({ url }: { url: URL }): HTMLElement =>
    mountRouteTemplate(
      "overviewTitle",
      url.pathname,
      pageTemplates["/"],
      overviewScope({ count, role: profile.role, rowCount }),
    );

  const renderCounter = ({ url }: { url: URL }): HTMLElement =>
    mountRouteTemplate("counterTitle", url.pathname, pageTemplates["/counter/"], {
      copy: copy(),
      count,
      decrement: () => count.update((value) => value - step()),
      doubleStep: () =>
        batch(() => {
          step.update((value) => value * 2);
          count.update((value) => value + 0);
        }),
      increment: () => count.update((value) => value + step()),
      projected,
      resetCounter: () =>
        batch(() => {
          count.set(0);
          step.set(1);
        }),
      step,
    });

  const renderLists = ({ url }: { url: URL }): HTMLElement =>
    mountRouteTemplate("listsTitle", url.pathname, pageTemplates["/lists/"], {
      addRow: () => {
        const id = Math.max(...rows().map((row) => row.id)) + 1;
        rows.set([{ id, label: `Inserted row ${id}`, owner: "User", status: "open" }, ...rows()]);
      },
      copy: copy(),
      rotateRows: () => {
        const [first, ...rest] = rows();
        rows.set(first ? [...rest, first] : []);
      },
      rowMode,
      toggleLabel,
      toggleOpenOnly: () => openOnly.update((value) => !value),
      visibleRows,
    });

  const renderForms = ({ url }: { url: URL }): HTMLElement => {
    const saveProfile = (event: Event): void => {
      event.preventDefault();
      const form = event.currentTarget instanceof HTMLFormElement ? event.currentTarget : undefined;
      if (!form) {
        profile.status = t("nameRequired");
        return;
      }
      const result = profileResult(form);
      if (!result.ok) {
        profile.status = result.error;
        return;
      }
      profile.displayName = result.value.displayName;
      profile.email = result.value.email;
      profile.role = result.value.role;
      profile.status = result.value.status;
    };
    return mountRouteTemplate("formsTitle", url.pathname, pageTemplates["/forms/"], {
      copy: copy(),
      profile,
      saveProfile,
    });
  };

  const renderCompiler = async ({ url }: { url: URL }): Promise<HTMLElement> => {
    const streamOutput = await readGeneratedStream(rows());
    return mountRouteTemplate(
      "compilerTitle",
      url.pathname,
      pageTemplates["/compiler/"],
      compilerScope({ rows: rows(), streamOutput }),
    );
  };

  const renderSettings = ({ url }: { url: URL }): HTMLElement =>
    mountRouteTemplate("settingsTitle", url.pathname, pageTemplates["/settings/"], {
      copy: copy(),
      setComfortable: () => {
        profile.density = "comfortable";
        root.dataset.density = "comfortable";
      },
      setCompact: () => {
        profile.density = "compact";
        root.dataset.density = "compact";
      },
      toggleTheme: (event: Event) => {
        const input = event.currentTarget;
        if (!(input instanceof HTMLInputElement)) {
          return;
        }
        profile.theme = input.checked ? "light" : "system";
        root.dataset.theme = profile.theme;
      },
    });

  const target = "#route-outlet";
  const routes: ClientRouteDefinition[] = [
    { id: "overview", path: fullPath("/"), target, render: renderOverview },
    { id: "counter", path: fullPath("/counter"), target, render: renderCounter },
    { id: "lists", path: fullPath("/lists"), target, render: renderLists },
    { id: "forms", path: fullPath("/forms"), target, render: renderForms },
    { id: "compiler", path: fullPath("/compiler"), target, render: renderCompiler },
    { id: "settings", path: fullPath("/settings"), target, render: renderSettings },
  ];

  const liveRegion = root.querySelector("#route-live");
  const routerOptions = {
    root,
    routes,
    error: ({ error }: { url: URL; error: unknown }) =>
      htmlElement(
        `<section class="panel" data-testid="route-error"><h2>Navigation error</h2><pre>${escapeHtml(error instanceof Error ? error.message : String(error))}</pre></section>`,
      ),
    notFound: ({ url }: { url: URL }) =>
      routePage("overviewTitle", url.pathname, htmlElement(`<section class="panel"><h2>Not found</h2></section>`)),
    scrollTo: () => undefined,
    title: ({ url }: { url: URL; data: unknown }) => `${t("appName")} ${url.pathname}`,
    ...(liveRegion instanceof Element ? { liveRegion } : {}),
  };
  const router = createClientRouter({
    ...routerOptions,
  });
  await router.start();

  return {
    router,
    dispose: () => {
      clearRoute();
      for (const cleanup of cleanups) cleanup();
      router.dispose();
    },
  };
};

if (typeof document !== "undefined") {
  const app = document.querySelector("#app");
  if (app instanceof HTMLElement) {
    void mountFullAppExample(app);
  }
}
