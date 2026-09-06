import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import { createRequire } from "node:module";
import { performance } from "node:perf_hooks";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { compileTemplate, generateClientModule } from "../src/compiler/index.js";
import type { Signal } from "../src/runtime/signal.js";

export type GeneratedTemplateTag = {
  id: number;
  name: string;
};

export type GeneratedTemplateItem = {
  id: number;
  label: string;
  selected: boolean;
  tags: GeneratedTemplateTag[];
  onClick: () => void;
};

/**
 * Operations shared by every benchmark path. `rows()` and `childRows()` expose
 * live DOM identity so the runner can assert that reorders move nodes instead
 * of recreating them.
 */
export type GeneratedTemplateDriver = {
  replace: (items: readonly GeneratedTemplateItem[]) => void;
  append: (items: readonly GeneratedTemplateItem[]) => void;
  partialUpdate: (items: readonly GeneratedTemplateItem[]) => void;
  swap: () => void;
  remove: () => void;
  reorderChildren: () => void;
  emptyChildren: () => void;
  dispose: () => void;
  rows: () => HTMLTableRowElement[];
  childRows: (rowIndex: number) => Element[];
  /** Interactive operations: real DOM events against real handlers. */
  typeInto: (rowIndex: number, value: string) => void;
  click: (rowIndex: number) => void;
  setSelected: (rowIndex: number, selected: boolean) => void;
  inputValue: (rowIndex: number) => string;
  current: () => readonly GeneratedTemplateItem[];
};

export type GeneratedClientModule = {
  bind: (root: Element, scope: Record<string, unknown>) => void | (() => void);
  createSignal: <T>(initial: T) => Signal<T>;
};

export type GeneratedModuleLoadTiming = {
  compileMs: number;
  bundleMs: number;
  importMs: number;
};

export type LoadedGeneratedModule = {
  module: GeneratedClientModule;
  timing: GeneratedModuleLoadTiming;
};

const nestedTags = `<td><ul><for each={row.tags} key={tag.id}><li>{tag.name}</li></for></ul></td>`;

export const REPRESENTATIVE_TEMPLATE_SOURCES = {
  "text-template": `<table><tbody><for each={rows} key={row.id}><tr class="row"><td>{row.id}</td><td><input value=""><span>{row.label}</span></td><td>{row.selected ? "selected" : ""}</td>${nestedTags}</tr></for></tbody></table>`,
  "mixed-template": `<table><tbody><for each={rows} key={row.id}><tr class="row" class:selected={row.selected} on:click={row.onClick}><td>{row.id}</td><td><input value="" bind:value={row.label}><span>{row.label}</span></td><td>{row.selected ? "selected" : ""}</td>${nestedTags}</tr></for></tbody></table>`,
} as const;

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const execFileAsync = promisify(execFile);
const requireFromProject = createRequire(path.join(projectRoot, "package.json"));
const esbuildCli = requireFromProject.resolve("esbuild/bin/esbuild");

export const loadGeneratedClientModule = async (source: string): Promise<LoadedGeneratedModule> => {
  const compileStarted = performance.now();
  const compiled = compileTemplate(source);
  if (!compiled.ok) throw new Error(compiled.error.message);
  const code = (
    `import { createSignal as __tachyonBenchmarkCreateSignal } from "tachyon-dom/runtime/signal";\n` +
    `export { __tachyonBenchmarkCreateSignal as createSignal };\n` +
    generateClientModule(compiled.value, { reactive: true })
  ).replaceAll(/"tachyon-dom\/([^"]+)"/g, (_match, specifier: string) =>
    JSON.stringify(path.resolve(projectRoot, "src", `${specifier}.ts`)),
  );
  const compileMs = performance.now() - compileStarted;
  const directory = await mkdtemp(path.join(tmpdir(), "tachyon-generated-template-"));
  const input = path.join(directory, "entry.js");
  const output = path.join(directory, "entry.out.js");
  try {
    const bundleStarted = performance.now();
    await writeFile(input, code);
    await execFileAsync(
      process.execPath,
      [esbuildCli, input, "--bundle", "--format=esm", "--platform=node", "--target=es2022", `--outfile=${output}`],
      {
        cwd: projectRoot,
        maxBuffer: 16 * 1024 * 1024,
      },
    );
    const bundled = await readFile(output, "utf8");
    const bundleMs = performance.now() - bundleStarted;
    const importStarted = performance.now();
    const encoded = Buffer.from(bundled).toString("base64");
    const module = (await import(`data:text/javascript;base64,${encoded}`)) as GeneratedClientModule;
    const importMs = performance.now() - importStarted;
    return { module, timing: { compileMs, bundleMs, importMs } };
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
};

export type LoadedRepresentativeModules = {
  "text-template": LoadedGeneratedModule;
  "mixed-template": LoadedGeneratedModule;
};

export const loadRepresentativeGeneratedModules = async (): Promise<LoadedRepresentativeModules> => ({
  "text-template": await loadGeneratedClientModule(REPRESENTATIVE_TEMPLATE_SOURCES["text-template"]),
  "mixed-template": await loadGeneratedClientModule(REPRESENTATIVE_TEMPLATE_SOURCES["mixed-template"]),
});

export const createGeneratedTemplateDriver = (
  pathName: keyof typeof REPRESENTATIVE_TEMPLATE_SOURCES,
  tbody: HTMLTableSectionElement,
  modules: LoadedRepresentativeModules,
): GeneratedTemplateDriver => {
  const table = tbody.closest("table");
  if (!(table instanceof HTMLTableElement)) throw new Error("Generated benchmark table is missing.");
  const module = modules[pathName].module;
  const rows = module.createSignal<readonly GeneratedTemplateItem[]>([]);
  const scope: Record<string, unknown> = { rows, noop: () => undefined };
  let cleanup: (() => void) | undefined;
  let active = false;
  let current: readonly GeneratedTemplateItem[] = [];
  const ensureBound = (): void => {
    if (active) return;
    cleanup = module.bind(table, scope) ?? undefined;
    active = true;
  };
  const replace = (items: readonly GeneratedTemplateItem[]): void => {
    ensureBound();
    current = [...items];
    rows.set(current);
  };
  const rowElements = (): HTMLTableRowElement[] =>
    Array.from(tbody.children).filter((row): row is HTMLTableRowElement => row instanceof HTMLTableRowElement);
  const inputAt = (rowIndex: number): HTMLInputElement => {
    const input = rowElements()[rowIndex]?.querySelector("input");
    if (!(input instanceof HTMLInputElement)) throw new Error(`Missing input for row ${rowIndex}.`);
    return input;
  };
  return {
    replace,
    append: (items) => replace([...current, ...items]),
    partialUpdate: (items) =>
      replace(items.map((item, index) => (index % 5 === 0 ? { ...item, label: `${item.label} !` } : item))),
    swap: () => {
      const next = [...current];
      const last = next.length - 2;
      if (last < 2) return;
      [next[1], next[last]] = [next[last] as GeneratedTemplateItem, next[1] as GeneratedTemplateItem];
      replace(next);
    },
    remove: () => replace(current.filter((_, index) => index !== 2)),
    reorderChildren: () =>
      replace(current.map((item, index) => (index % 3 === 0 ? { ...item, tags: [...item.tags].reverse() } : item))),
    emptyChildren: () => replace(current.map((item, index) => (index % 4 === 1 ? { ...item, tags: [] } : item))),
    dispose: () => {
      if (!active) return;
      cleanup?.();
      cleanup = undefined;
      active = false;
      current = [];
      rows.set([]);
    },
    rows: rowElements,
    childRows: (rowIndex) => Array.from(rowElements()[rowIndex]?.querySelectorAll("li") ?? []),
    typeInto: (rowIndex, value) => {
      const input = inputAt(rowIndex);
      input.value = value;
      input.dispatchEvent(new Event("input", { bubbles: true }));
    },
    click: (rowIndex) => {
      const row = rowElements()[rowIndex];
      if (!row) throw new Error(`Missing row ${rowIndex}.`);
      row.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
    },
    setSelected: (rowIndex, selected) =>
      replace(current.map((item, index) => (index === rowIndex ? { ...item, selected } : item))),
    inputValue: (rowIndex) => inputAt(rowIndex).value,
    current: () => current,
  };
};
