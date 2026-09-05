import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { compileTemplate, generateClientModule } from "../src/compiler/index.js";
import type { Signal } from "../src/runtime/signal.js";

export type GeneratedTemplateItem = {
  id: number;
  label: string;
  selected: boolean;
  onClick: () => void;
};

export type GeneratedTemplateDriver = {
  replace: (items: readonly GeneratedTemplateItem[]) => void;
  append: (items: readonly GeneratedTemplateItem[]) => void;
  partialUpdate: (items: readonly GeneratedTemplateItem[]) => void;
  swap: () => void;
  remove: () => void;
  dispose: () => void;
};

type GeneratedClientModule = {
  bind: (root: Element, scope: Record<string, unknown>) => void | (() => void);
  createSignal: <T>(initial: T) => Signal<T>;
};

export const REPRESENTATIVE_TEMPLATE_SOURCES = {
  "text-template":
    `<table><tbody><for each={rows} key={row.id}><tr class="row"><td>{row.id}</td><td><input value=""><span>{row.label}</span></td><td>{row.selected ? "selected" : ""}</td></tr></for></tbody></table>`,
  "mixed-template":
    `<table><tbody><for each={rows} key={row.id}><tr class="row" class:selected={row.selected} on:click={row.onClick}><td>{row.id}</td><td><input value="" bind:value={row.label}><span>{row.label}</span></td><td>{row.selected ? "selected" : ""}</td></tr></for></tbody></table>`,
} as const;

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const execFileAsync = promisify(execFile);
const requireFromProject = createRequire(path.join(projectRoot, "package.json"));
const esbuildCli = requireFromProject.resolve("esbuild/bin/esbuild");

const bundleGeneratedModule = async (source: string): Promise<GeneratedClientModule> => {
  const compiled = compileTemplate(source);
  if (!compiled.ok) throw new Error(compiled.error.message);
  const code = (
    `import { createSignal as __tachyonBenchmarkCreateSignal } from "tachyon-dom/runtime/signal";\n` +
    `export { __tachyonBenchmarkCreateSignal as createSignal };\n` +
    generateClientModule(compiled.value, { reactive: true })
  ).replaceAll(
      /"tachyon-dom\/([^"]+)"/g,
      (_match, specifier: string) => JSON.stringify(path.resolve(projectRoot, "src", `${specifier}.ts`)),
    );
  const directory = await mkdtemp(path.join(tmpdir(), "tachyon-generated-template-"));
  const input = path.join(directory, "entry.js");
  const output = path.join(directory, "entry.out.js");
  try {
    await writeFile(input, code);
    await execFileAsync(process.execPath, [esbuildCli, input, "--bundle", "--format=esm", "--platform=node", "--target=es2022", `--outfile=${output}`], {
      cwd: projectRoot,
      maxBuffer: 16 * 1024 * 1024,
    });
    const bundled = await readFile(output, "utf8");
    const encoded = Buffer.from(bundled).toString("base64");
    return (await import(`data:text/javascript;base64,${encoded}`)) as GeneratedClientModule;
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
};

export const loadRepresentativeGeneratedModules = async (): Promise<{
  "text-template": GeneratedClientModule;
  "mixed-template": GeneratedClientModule;
}> => ({
  "text-template": await bundleGeneratedModule(REPRESENTATIVE_TEMPLATE_SOURCES["text-template"]),
  "mixed-template": await bundleGeneratedModule(REPRESENTATIVE_TEMPLATE_SOURCES["mixed-template"]),
});

export const createGeneratedTemplateDriver = (
  pathName: keyof typeof REPRESENTATIVE_TEMPLATE_SOURCES,
  tbody: HTMLTableSectionElement,
  modules: Awaited<ReturnType<typeof loadRepresentativeGeneratedModules>>,
): GeneratedTemplateDriver => {
  const table = tbody.closest("table");
  if (!(table instanceof HTMLTableElement)) throw new Error("Generated benchmark table is missing.");
  const module = modules[pathName];
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
    dispose: () => {
      if (!active) return;
      cleanup?.();
      cleanup = undefined;
      active = false;
      current = [];
      rows.set([]);
    },
  };
};
