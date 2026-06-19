import "./styles.css";
import { compileTemplate, generateClientModule, generateServerStreamModule } from "../../src/compiler";
import { err, ok, type Result } from "../../src/result";
import { createClientRouter, type ClientRouter, type ClientRouteDefinition } from "../../src/runtime/router";
import { batch, createMemo, createSignal, effect } from "../../src/runtime/signal";
import { createStore } from "../../src/runtime/store";
import { mountKeyedList } from "../../src/runtime/list";
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
  | "activity";

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

const basePath = "";

const messages: Record<"en", Record<MessageKey, string>> = {
  en: {
    activity: "Activity",
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
    increment: "Increment",
    lists: "Lists",
    listsTitle: "Lists",
    nameRequired: "Enter a display name.",
    openOnly: "Open only",
    overview: "Overview",
    overviewTitle: "Overview",
    reset: "Reset",
    role: "Role",
    rotateRows: "Rotate rows",
    saveProfile: "Save profile",
    savedProfile: "Saved {name}.",
    settings: "Settings",
    settingsTitle: "Settings",
    summary: "Summary",
    theme: "Theme",
  },
};

const t = (key: MessageKey, values: Record<string, string | number> = {}): string =>
  Object.entries(values).reduce((text, [name, value]) => text.replaceAll(`{${name}}`, String(value)), messages.en[key]);

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

const renderOverviewHtml = (state: { count: number; rows: DemoRow[]; role: string }): string => `
  <section class="page-grid overview-grid" data-testid="overview-page">
    <article class="panel hero-panel">
      <p class="eyebrow">${t("summary")}</p>
      <h2>Persistent layout with route-level tools</h2>
      <p>The shell stays mounted while the outlet swaps pages through the client router.</p>
      <div class="stat-grid">
        <span><b>${state.count}</b> signal count</span>
        <span><b>${state.rows.length}</b> keyed rows</span>
        <span><b>${escapeHtml(state.role)}</b> role</span>
      </div>
    </article>
    <article class="panel">
      <h2>${t("activity")}</h2>
      <ol class="activity-list">
        <li>Route state is handled by <code>runtime/router</code>.</li>
        <li>Counters use <code>createSignal</code>, <code>createMemo</code>, and <code>batch</code>.</li>
        <li>Rows use <code>mountKeyedList</code> with compiled readers.</li>
      </ol>
    </article>
  </section>
`;

export const renderFullAppShellHtml = (): string => {
  const rows = initialRows();
  return `
    <section class="app-shell" data-testid="app-shell" data-ssr-route="/">
      <aside class="sidebar" aria-label="Primary">
        <a class="brand" href="${fullPath("/")}">${t("appName")}</a>
        <nav class="nav-list" aria-label="Pages">
          <a href="${fullPath("/")}" data-nav aria-current="true">${t("overview")}</a>
          <a href="${fullPath("/counter/")}" data-nav>${t("counter")}</a>
          <a href="${fullPath("/lists/")}" data-nav>${t("lists")}</a>
          <a href="${fullPath("/forms/")}" data-nav>${t("forms")}</a>
          <a href="${fullPath("/compiler/")}" data-nav>${t("compiler")}</a>
          <a href="${fullPath("/settings/")}" data-nav>${t("settings")}</a>
        </nav>
      </aside>
      <section class="workspace">
        <header class="topbar">
          <div>
            <p class="eyebrow">${t("appName")}</p>
            <h1 data-testid="route-title">${t("overviewTitle")}</h1>
          </div>
          <div class="summary-strip" aria-label="${t("summary")}">
            <span><b data-testid="summary-count">0</b> count</span>
            <span><b data-testid="summary-rows">${rows.length}</b> rows</span>
            <span><b data-testid="summary-profile">Guest operator</b></span>
          </div>
        </header>
        <div id="route-outlet" class="route-outlet">${renderOverviewHtml({ count: 0, rows, role: "Runtime" })}</div>
        <div id="route-live" class="visually-hidden" aria-live="polite"></div>
      </section>
    </section>
  `;
};

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

const rowListOptions = {
  signature: "full-app-row-list",
  key: "row.id",
  keyRead: (scope: Record<string, unknown>) => (scope.row as DemoRow).id,
  itemName: "row",
  templateHtml: `<li class="row-card" data-testid="row"><span class="row-status"> </span><strong data-testid="row-label"> </strong><small> </small></li>`,
  bindings: [
    {
      kind: "text" as const,
      path: [0, 0],
      expression: "row.status",
      read: (scope: Record<string, unknown>) => (scope.row as DemoRow).status,
    },
    {
      kind: "text" as const,
      path: [1, 0],
      expression: "row.label",
      read: (scope: Record<string, unknown>) => (scope.row as DemoRow).label,
    },
    {
      kind: "text" as const,
      path: [2, 0],
      expression: "`Owner: ${row.owner}`",
      read: (scope: Record<string, unknown>) => `Owner: ${(scope.row as DemoRow).owner}`,
    },
    {
      kind: "class" as const,
      path: [],
      className: "is-done",
      expression: "row.status === 'done'",
      read: (scope: Record<string, unknown>) => (scope.row as DemoRow).status === "done",
    },
  ],
};

export const mountFullAppExample = async (root: HTMLElement): Promise<FullAppInstance> => {
  const count = createSignal(0);
  const step = createSignal(1);
  const projected = createMemo(() => count() + step() * 2);
  const rows = createSignal<DemoRow[]>(initialRows());
  const openOnly = createSignal(false);
  const visibleRows = createMemo(() => rows().filter((row) => !openOnly() || row.status === "open"));
  const profile = createStore<ProfileState>({
    density: "comfortable",
    displayName: "Guest operator",
    email: "guest@example.com",
    role: "Runtime",
    status: "",
    theme: "system",
  });
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

  const renderOverview = ({ url }: { url: URL }): HTMLElement =>
    routePage(
      "overviewTitle",
      url.pathname,
      htmlElement(renderOverviewHtml({ count: count(), rows: rows(), role: profile.role })),
    );

  const renderCounter = ({ url }: { url: URL }): HTMLElement => {
    const page = routePage(
      "counterTitle",
      url.pathname,
      htmlElement(`
        <section class="page-grid">
          <article class="panel counter-panel">
            <div class="counter-readout">
              <span data-testid="count-value">0</span>
              <small>step <b data-testid="step-value">1</b></small>
            </div>
            <div class="toolbar">
              <button type="button" data-testid="decrement">${t("decrement")}</button>
              <button type="button" data-testid="increment">${t("increment")}</button>
              <button type="button" data-testid="double-step">${t("doubleStep")}</button>
              <button type="button" class="secondary" data-testid="reset-counter">${t("reset")}</button>
            </div>
          </article>
          <article class="panel">
            <h2>Memo</h2>
            <p class="metric-large" data-testid="projected-value">0</p>
            <p>Projected value is count plus two steps.</p>
          </article>
        </section>
      `),
    );
    const countValue = page.querySelector("[data-testid='count-value']");
    const stepValue = page.querySelector("[data-testid='step-value']");
    const projectedValue = page.querySelector("[data-testid='projected-value']");
    registerRoute(
      effect(() => {
        if (countValue) countValue.textContent = String(count());
        if (stepValue) stepValue.textContent = String(step());
        if (projectedValue) projectedValue.textContent = String(projected());
      }),
    );
    page.querySelector<HTMLButtonElement>("[data-testid='decrement']")?.addEventListener("click", () => {
      count.update((value) => value - step());
    });
    page.querySelector<HTMLButtonElement>("[data-testid='increment']")?.addEventListener("click", () => {
      count.update((value) => value + step());
    });
    page.querySelector<HTMLButtonElement>("[data-testid='double-step']")?.addEventListener("click", () => {
      batch(() => {
        step.update((value) => value * 2);
        count.update((value) => value + 0);
      });
    });
    page.querySelector<HTMLButtonElement>("[data-testid='reset-counter']")?.addEventListener("click", () => {
      batch(() => {
        count.set(0);
        step.set(1);
      });
    });
    return page;
  };

  const renderLists = ({ url }: { url: URL }): HTMLElement => {
    const page = routePage(
      "listsTitle",
      url.pathname,
      htmlElement(`
        <section class="page-grid">
          <article class="panel">
            <div class="toolbar">
              <button type="button" data-testid="add-row">${t("addRow")}</button>
              <button type="button" data-testid="rotate-rows">${t("rotateRows")}</button>
              <button type="button" class="secondary" data-testid="toggle-open-only">${t("openOnly")}</button>
            </div>
            <ul class="row-list" data-testid="row-list"></ul>
          </article>
          <article class="panel">
            <h2>Selection</h2>
            <p data-testid="row-mode">${t("allRows")}</p>
          </article>
        </section>
      `),
    );
    const list = page.querySelector(".row-list");
    const mode = page.querySelector("[data-testid='row-mode']");
    const toggle = page.querySelector<HTMLButtonElement>("[data-testid='toggle-open-only']");
    if (list instanceof HTMLElement) {
      registerRoute(
        effect(() => {
          mountKeyedList(list, [], visibleRows(), rowListOptions);
          if (mode) mode.textContent = openOnly() ? t("openOnly") : t("allRows");
          if (toggle) toggle.textContent = openOnly() ? t("allRows") : t("openOnly");
        }),
      );
    }
    page.querySelector<HTMLButtonElement>("[data-testid='add-row']")?.addEventListener("click", () => {
      const id = Math.max(...rows().map((row) => row.id)) + 1;
      rows.set([{ id, label: `Inserted row ${id}`, owner: "User", status: "open" }, ...rows()]);
    });
    page.querySelector<HTMLButtonElement>("[data-testid='rotate-rows']")?.addEventListener("click", () => {
      const [first, ...rest] = rows();
      rows.set(first ? [...rest, first] : []);
    });
    toggle?.addEventListener("click", () => openOnly.update((value) => !value));
    return page;
  };

  const renderForms = ({ url }: { url: URL }): HTMLElement => {
    const page = routePage(
      "formsTitle",
      url.pathname,
      htmlElement(`
        <section class="page-grid">
          <form class="panel form-panel" action="/profile" method="post" novalidate>
            <fieldset>
              <legend>${t("formsTitle")}</legend>
              <div class="field">
                <label for="display-name">${t("displayName")}</label>
                <input id="display-name" name="displayName" autocomplete="name" required />
              </div>
              <div class="field">
                <label for="email">${t("email")}</label>
                <input id="email" name="email" type="email" autocomplete="email" required />
              </div>
              <div class="field">
                <label for="role">${t("role")}</label>
                <select id="role" name="role">
                  <option>Runtime</option>
                  <option>Router</option>
                  <option>Design systems</option>
                </select>
              </div>
            </fieldset>
            <button type="submit" data-testid="save-profile">${t("saveProfile")}</button>
            <p class="status" data-testid="form-status" aria-live="polite">${escapeHtml(profile.status)}</p>
          </form>
          <article class="panel">
            <h2>${t("summary")}</h2>
            <dl class="profile-summary">
              <div><dt>${t("displayName")}</dt><dd data-testid="profile-name">${escapeHtml(profile.displayName)}</dd></div>
              <div><dt>${t("email")}</dt><dd data-testid="profile-email">${escapeHtml(profile.email)}</dd></div>
              <div><dt>${t("role")}</dt><dd data-testid="profile-role">${escapeHtml(profile.role)}</dd></div>
            </dl>
          </article>
        </section>
      `),
    );
    const form = page.querySelector("form");
    const status = page.querySelector("[data-testid='form-status']");
    const profileName = page.querySelector("[data-testid='profile-name']");
    const profileEmail = page.querySelector("[data-testid='profile-email']");
    const profileRole = page.querySelector("[data-testid='profile-role']");
    if (form instanceof HTMLFormElement) {
      form.addEventListener("submit", (event) => {
        event.preventDefault();
        const result = profileResult(form);
        if (!result.ok) {
          profile.status = result.error;
        } else {
          profile.displayName = result.value.displayName;
          profile.email = result.value.email;
          profile.role = result.value.role;
          profile.status = result.value.status;
        }
        if (status) status.textContent = profile.status;
        if (profileName) profileName.textContent = profile.displayName;
        if (profileEmail) profileEmail.textContent = profile.email;
        if (profileRole) profileRole.textContent = profile.role;
      });
    }
    return page;
  };

  const renderCompiler = async ({ url }: { url: URL }): Promise<HTMLElement> => {
    const streamOutput = await readGeneratedStream(rows());
    return routePage(
      "compilerTitle",
      url.pathname,
      htmlElement(`
        <section class="page-grid diagnostics-grid">
          <article class="panel">
            <h2>Template</h2>
            <pre class="code" data-testid="compiled-template">${escapeHtml(templateSource)}</pre>
          </article>
          <article class="panel">
            <h2>Stream output</h2>
            <pre class="code" data-testid="stream-output">${escapeHtml(streamOutput)}</pre>
          </article>
          <article class="panel wide-panel">
            <h2>Generated client</h2>
            <pre class="code" data-testid="generated-client">${escapeHtml(generatedClient)}</pre>
          </article>
        </section>
      `),
    );
  };

  const renderSettings = ({ url }: { url: URL }): HTMLElement => {
    const page = routePage(
      "settingsTitle",
      url.pathname,
      htmlElement(`
        <section class="page-grid">
          <article class="panel">
            <h2>${t("settingsTitle")}</h2>
            <div class="segmented" role="group" aria-label="${t("compactMode")}">
              <button type="button" data-density="compact">${t("compactMode")}</button>
              <button type="button" data-density="comfortable">${t("comfortableMode")}</button>
            </div>
            <label class="switch-row">
              <input type="checkbox" data-testid="theme-toggle" />
              <span>${t("theme")}: light</span>
            </label>
          </article>
        </section>
      `),
    );
    page.querySelectorAll<HTMLButtonElement>("[data-density]").forEach((button) => {
      button.addEventListener("click", () => {
        const density = button.dataset.density === "compact" ? "compact" : "comfortable";
        profile.density = density;
        root.dataset.density = density;
      });
    });
    page.querySelector<HTMLInputElement>("[data-testid='theme-toggle']")?.addEventListener("change", (event) => {
      const input = event.currentTarget;
      if (!(input instanceof HTMLInputElement)) {
        return;
      }
      profile.theme = input.checked ? "light" : "system";
      root.dataset.theme = profile.theme;
    });
    return page;
  };

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

const app = document.querySelector("#app");
if (app instanceof HTMLElement) {
  void mountFullAppExample(app);
}
