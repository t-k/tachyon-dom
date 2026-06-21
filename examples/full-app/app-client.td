<script lang="ts">
import "./styles.css";
import * as compilerTemplate from "./compiler/page.td";
import * as counterTemplate from "./counter/page.td";
import * as formsTemplate from "./forms/page.td";
import * as listsTemplate from "./lists/page.td";
import * as overviewTemplate from "./overview/page.td";
import * as settingsTemplate from "./settings/page.td";
import { defaultProfile, escapeHtml, generatedStreamModule, initialRows, t } from "./app";
import { renderFullAppShellFrame } from "./dom-shell";

const basePath = "";

const htmlElement = (html) => {
  const template = document.createElement("template");
  template.innerHTML = html.trim();
  const element = template.content.firstElementChild;
  if (!(element instanceof HTMLElement)) {
    throw new Error("Expected an HTMLElement.");
  }
  return element;
};

const fullPath = (path = "") => `${basePath}${path}`;

const pageTemplates = {
  "/": { template: overviewTemplate },
  "/compiler/": { template: compilerTemplate },
  "/counter/": { template: counterTemplate },
  "/forms/": { template: formsTemplate },
  "/lists/": { template: listsTemplate },
  "/settings/": { template: settingsTemplate },
};

const mountTemplate = (entry, scope) => {
  const element = htmlElement(entry.template.templateHtml);
  const cleanup = entry.template.bind(element, scope);
  return { element, cleanup: typeof cleanup === "function" ? cleanup : () => undefined };
};

const encodeBase64 = (value) => btoa(value);

const importStreamModule = async () =>
  await import(/* @vite-ignore */ `data:text/javascript;base64,${encodeBase64(generatedStreamModule)}`);

const readGeneratedStream = async (rows) => {
  const module = await importStreamModule();
  const chunks = [];
  for await (const chunk of module.stream({ rows, title: "Compiled stream" })) {
    chunks.push(chunk);
  }
  const stream = renderToReadableStream(chunks);
  return (await readTextStreamChunks(stream)).join("");
};

export const mountFullAppExample = async (root) => {
  const count = createSignal(0);
  const step = createSignal(1);
  const projected = createMemo(() => count() + step() * 2);
  const rows = createSignal(initialRows());
  const rowCount = createMemo(() => rows().length);
  const openOnly = createSignal(false);
  const profile = createStore(defaultProfile());
  const cleanups = [];
  let routeCleanups = [];

  const register = (cleanup) => {
    cleanups.push(cleanup);
  };
  const clearRoute = () => {
    for (const cleanup of routeCleanups) {
      cleanup();
    }
    routeCleanups = [];
  };
  const registerRoute = (cleanup) => {
    routeCleanups.push(cleanup);
  };

  if (!(root.querySelector("[data-testid='app-shell']") instanceof HTMLElement)) {
    root.innerHTML = renderFullAppShellFrame();
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

  const setPageTitle = (key) => {
    if (title) {
      title.textContent = t(key);
    }
  };

  const setActiveNav = (pathname) => {
    root.querySelectorAll("[data-nav]").forEach((link) => {
      link.toggleAttribute("aria-current", link.pathname === pathname);
    });
  };

  const routePage = (key, pathname, element) => {
    clearRoute();
    setPageTitle(key);
    setActiveNav(pathname);
    return element;
  };

  const mountRouteTemplate = (key, pathname, entry, scope) => {
    const mounted = mountTemplate(entry, scope);
    const page = routePage(key, pathname, mounted.element);
    registerRoute(mounted.cleanup);
    return page;
  };

  const renderOverview = ({ url }) =>
    mountRouteTemplate("overviewTitle", url.pathname, pageTemplates["/"], {
      count,
      role: profile.role,
      rowCount,
    });

  const renderCounter = ({ url }) =>
    mountRouteTemplate("counterTitle", url.pathname, pageTemplates["/counter/"], {
      count,
      projected,
      step,
    });

  const renderLists = ({ url }) =>
    mountRouteTemplate("listsTitle", url.pathname, pageTemplates["/lists/"], {
      openOnly,
      rows,
    });

  const renderForms = ({ url }) => mountRouteTemplate("formsTitle", url.pathname, pageTemplates["/forms/"], { profile });

  const renderCompiler = async ({ url }) => {
    const streamOutput = await readGeneratedStream(rows());
    return mountRouteTemplate("compilerTitle", url.pathname, pageTemplates["/compiler/"], {
      rows: rows(),
      streamOutput,
    });
  };

  const renderSettings = ({ url }) =>
    mountRouteTemplate("settingsTitle", url.pathname, pageTemplates["/settings/"], {
      profile,
      root,
    });

  const target = "#route-outlet";
  const routes = [
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
    error: ({ error }) =>
      htmlElement(
        `<section class="panel" data-testid="route-error"><h2>Navigation error</h2><pre>${escapeHtml(error instanceof Error ? error.message : String(error))}</pre></section>`,
      ),
    notFound: ({ url }) =>
      routePage("overviewTitle", url.pathname, htmlElement(`<section class="panel"><h2>Not found</h2></section>`)),
    scrollTo: () => undefined,
    title: ({ url }) => `${t("appName")} ${url.pathname}`,
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
</script>
