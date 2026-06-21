import "./styles.css";
import * as demoModule from "./demo.td";
import templateSource from "./demo.td?raw";
import * as shellModule from "./shell.td";
import shellSource from "./shell.td?raw";
import {
  generateClientModule,
  generateServerStreamModule,
  renderServerTemplate,
  type ListBinding,
  type CompiledTemplate,
} from "../../src/compiler";
import { compileTachyonSfc } from "../../src/compiler/sfc";
import { serializeHydrationState } from "../../src/runtime/hydrate";
import { readTextStreamChunks } from "../../src/runtime/stream-client";
import { renderToReadableStream } from "../../src/server/stream";

type DemoRow = {
  id: number;
  label: string;
  active: boolean;
};

type DemoScope = {
  title: string;
  initialCount: number;
  count: number;
  active: boolean;
  islandId: string;
  rows: DemoRow[];
  increment: () => void;
};

type GeneratedServerModule = {
  stream: (scope: DemoScope) => AsyncIterable<string>;
};

type DemoModule = {
  bindPreview: (
    preview: HTMLElement,
    scope: DemoScope,
    options: {
      compiled: CompiledTemplate;
      listBinding: ListBinding;
      rowBindings: ListBinding["bindings"];
    },
  ) => void;
  initialScope: () => DemoScope;
};

type ShellModule = {
  bindShellControls: (app: HTMLElement, render: () => Promise<void>) => () => void;
};

const demo = demoModule as unknown as DemoModule;
const shell = shellModule as unknown as ShellModule;

const compiledResult = compileTachyonSfc(templateSource);
if (!compiledResult.ok) {
  throw new Error(compiledResult.error.message);
}

const compiled = compiledResult.value.template;
const listBinding = compiled.client.bindings.find((binding): binding is ListBinding => binding.kind === "list");
if (!listBinding) {
  throw new Error("Example template must include a keyed list.");
}
const rowBindings = listBinding.bindings.filter(
  (binding) => binding.kind === "text" || binding.kind === "class" || binding.kind === "event",
);

const generatedServerStreamModule = generateServerStreamModule(compiled);
const generatedClientModule = generateClientModule(compiled, { reactive: true });
const shellResult = compileTachyonSfc(shellSource);
if (!shellResult.ok) {
  throw new Error(shellResult.error.message);
}
const shellTemplate = shellResult.value.template;

const encodeBase64 = (value: string): string => btoa(value);

const importGeneratedServerModule = async (): Promise<GeneratedServerModule> =>
  (await import(
    /* @vite-ignore */ `data:text/javascript;base64,${encodeBase64(generatedServerStreamModule)}`
  )) as GeneratedServerModule;

const renderChunkList = (chunks: readonly string[]): string =>
  chunks
    .map((chunk, index) => {
      const element = document.createElement("div");
      const indexElement = document.createElement("strong");
      element.className = "chunk";
      indexElement.textContent = String(index + 1);
      element.append(indexElement, " ", chunk);
      return element.outerHTML;
    })
    .join("");

const renderShell = (): string =>
  renderServerTemplate(shellTemplate, {
    compilerIr: JSON.stringify(compiled.ir.directives, null, 2),
    generatedClientModule,
    templateSource,
  });

export const mountWebExample = async (app: HTMLElement): Promise<void> => {
  app.innerHTML = renderShell();
  const preview = app.querySelector("#preview");
  const chunksTarget = app.querySelector("#chunks");
  if (!(preview instanceof HTMLElement) || !(chunksTarget instanceof HTMLElement)) {
    throw new Error("Example shell failed to mount.");
  }

  const render = async (): Promise<void> => {
    const scope = demo.initialScope();
    const { stream } = await importGeneratedServerModule();
    const chunks = await readTextStreamChunks(renderToReadableStream(stream(scope)));
    preview.innerHTML =
      chunks.join("") + serializeHydrationState(scope.islandId, { count: scope.count, rows: scope.rows });
    chunksTarget.innerHTML = renderChunkList(chunks);
    demo.bindPreview(preview, scope, { compiled, listBinding, rowBindings });
  };

  shell.bindShellControls(app, render);

  await render();
};

const app = document.querySelector("#app");
if (app instanceof HTMLElement) {
  void mountWebExample(app);
}
