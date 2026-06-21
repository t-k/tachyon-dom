import "./styles.css";
import * as compilerTemplate from "./compiler/page.td";
import * as counterTemplate from "./counter/page.td";
import * as formsTemplate from "./forms/page.td";
import * as listsTemplate from "./lists/page.td";
import * as overviewTemplate from "./overview/page.td";
import * as settingsTemplate from "./settings/page.td";
import {
  compiledDiagnosticTemplate,
  copy,
  defaultProfile,
  escapeHtml,
  generatedClient,
  generatedStreamModule,
  initialRows,
  t,
  templateSource,
  type DemoRow,
  type MessageKey,
  type ProfileState,
} from "./app";
import { renderFullAppShellFrame } from "./dom-shell";
import { renderServerTemplate } from "../../src/compiler";
import { err, ok, type Result } from "../../src/result";
import { createClientRouter, type ClientRouter, type ClientRouteDefinition } from "../../src/runtime/router";
import { createMemo, createSignal, effect } from "../../src/runtime/signal";
import { createStore } from "../../src/runtime/store";
import { readTextStreamChunks } from "../../src/runtime/stream-client";
import { renderToReadableStream } from "../../src/server/stream";

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
  template: TachyonTemplateModule;
};

const basePath = "";

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

const pageTemplates = {
  "/": { template: overviewTemplate },
  "/compiler/": { template: compilerTemplate },
  "/counter/": { template: counterTemplate },
  "/forms/": { template: formsTemplate },
  "/lists/": { template: listsTemplate },
  "/settings/": { template: settingsTemplate },
} satisfies Record<string, PageTemplate>;

const mountTemplate = (
  entry: PageTemplate,
  scope: Record<string, unknown>,
): { element: HTMLElement; cleanup: () => void } => {
  const element = htmlElement(entry.template.templateHtml);
  const cleanup = entry.template.bind(element, scope);
  return { element, cleanup: typeof cleanup === "function" ? cleanup : () => undefined };
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
  streamOutput:
    state.streamOutput ??
    renderServerTemplate(compiledDiagnosticTemplate, { rows: state.rows, title: "Compiled stream" }),
  templateSource,
});

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
      projected,
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
