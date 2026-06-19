import {
  defaultProfile,
  escapeHtml,
  fullAppPages,
  initialRows,
  normalizedFullAppPath,
  pageTitleForPath,
  t,
} from "./app";

export const renderFullAppShellFrame = (path = "/", routeHtml = ""): string => {
  const activePath = normalizedFullAppPath(path);
  const rows = initialRows();
  const profile = defaultProfile();
  return `
    <section class="app-shell" data-testid="app-shell" data-ssr-route="${escapeHtml(activePath)}">
      <aside class="sidebar" aria-label="Primary">
        <a class="brand" href="/">${t("appName")}</a>
        <nav class="nav-list" aria-label="Pages">
          ${fullAppPages
            .map(
              (page) =>
                `<a href="${page.path}" data-nav${activePath === page.path ? ' aria-current="true"' : ""}>${t(page.label)}</a>`,
            )
            .join("")}
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
        <div id="route-outlet" class="route-outlet">${routeHtml}</div>
        <div id="route-live" class="visually-hidden" aria-live="polite"></div>
      </section>
    </section>
  `;
};
