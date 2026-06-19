import { compileTemplate, generateClientModule, generateServerStreamModule } from "../../src/compiler";

export type MessageKey =
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

export type DemoRow = {
  id: number;
  label: string;
  owner: string;
  status: "open" | "done";
};

export type ProfileState = {
  displayName: string;
  email: string;
  role: string;
  density: "compact" | "comfortable";
  theme: "system" | "light";
  status: string;
};

export type FullAppRoutePage = {
  path: string;
  fileName: string;
  label: MessageKey;
  prefix: string;
  title: MessageKey;
};

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
    roleMetric: "role",
    roleRouter: "Router",
    roleRuntime: "Runtime",
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

export const fullAppPages = [
  { path: "/", fileName: "index.html", label: "overview", prefix: ".", title: "overviewTitle" },
  { path: "/counter/", fileName: "counter/index.html", label: "counter", prefix: "..", title: "counterTitle" },
  { path: "/lists/", fileName: "lists/index.html", label: "lists", prefix: "..", title: "listsTitle" },
  { path: "/forms/", fileName: "forms/index.html", label: "forms", prefix: "..", title: "formsTitle" },
  { path: "/compiler/", fileName: "compiler/index.html", label: "compiler", prefix: "..", title: "compilerTitle" },
  { path: "/settings/", fileName: "settings/index.html", label: "settings", prefix: "..", title: "settingsTitle" },
] as const satisfies readonly FullAppRoutePage[];

export const t = (key: MessageKey, values: Record<string, string | number> = {}): string =>
  Object.entries(values).reduce((text, [name, value]) => text.replaceAll(`{${name}}`, String(value)), messages.en[key]);

export const copy = (): Record<string, string> => ({
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

export const escapeHtml = (value: string): string =>
  value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");

export const initialRows = (): DemoRow[] => [
  { id: 1, label: "Compiler bindings", owner: "Runtime", status: "open" },
  { id: 2, label: "Client router", owner: "Router", status: "open" },
  { id: 3, label: "Stream chunks", owner: "Server", status: "done" },
];

export const defaultProfile = (): ProfileState => ({
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

export const pageTitleForPath = (path: string): MessageKey =>
  fullAppPages.find((page) => page.path === normalizedFullAppPath(path))?.title ?? "overviewTitle";

export const templateSource = `<section><h2>{title}</h2><ul><for each={rows} key={row.id}><li class:done={row.status === "done"}>{row.label}</li></for></ul></section>`;
const compiledResult = compileTemplate(templateSource);
if (!compiledResult.ok) {
  throw new Error(compiledResult.error.message);
}
export const compiledDiagnosticTemplate = compiledResult.value;
export const generatedClient = generateClientModule(compiledDiagnosticTemplate, { reactive: true });
export const generatedStreamModule = generateServerStreamModule(compiledDiagnosticTemplate);
