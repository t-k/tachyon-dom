import { dirname, resolve } from "node:path";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { renderServerTemplate } from "../../src/compiler";
import { compileTachyonSfc } from "../../src/compiler/sfc";
import {
  compiledDiagnosticTemplate,
  copy,
  defaultProfile,
  generatedClient,
  initialRows,
  normalizedFullAppPath,
  t,
  templateSource,
  type DemoRow,
  type ProfileState,
} from "./app";
import { renderFullAppShellFrame } from "./dom-shell";

type PageTemplate = {
  source: string;
};

export type FullAppDocumentAssets = {
  scripts?: readonly string[];
  styles?: readonly string[];
};

const root = dirname(fileURLToPath(import.meta.url));

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

const compiledPageCache = new Map<string, ReturnType<typeof compileTachyonSfc>>();

const renderTemplateHtml = (entry: PageTemplate, scope: Record<string, unknown>): string => {
  const cached = compiledPageCache.get(entry.source);
  const compiledPage = cached ?? compileTachyonSfc(entry.source);
  compiledPageCache.set(entry.source, compiledPage);
  if (!compiledPage.ok) {
    throw new Error(compiledPage.error.message);
  }
  return renderServerTemplate(compiledPage.value.template, scope);
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
        rowMode: () => (state.openOnly ? t("openOnly") : t("allRows")),
        toggleLabel: () => (state.openOnly ? t("allRows") : t("openOnly")),
        toggleOpenOnly: () => undefined,
        visibleRows: () => state.rows,
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
  return renderFullAppShellFrame(
    activePath,
    renderRouteHtml(activePath, { count: 0, step: 1, rows, openOnly: false, profile }),
  );
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
