import "./styles.css";
import templateSource from "./demo.td?raw";
import shellSource from "./shell.td?raw";
import {
  compileTemplate,
  generateClientModule,
  generateServerStreamModule,
  renderServerTemplate,
  type ListBinding,
} from "../../src/compiler";
import { createHydrationBoundary, readHydrationState, serializeHydrationState } from "../../src/runtime/hydrate";
import { mountKeyedList } from "../../src/runtime/list";
import { effect } from "../../src/runtime/signal";
import { createStore } from "../../src/runtime/store";
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

type HydratedDemoState = {
  count: number;
  rows: DemoRow[];
};

const initialRows = (): DemoRow[] => [
  { id: 1, label: "Compiled template", active: true },
  { id: 2, label: "Chunk stream", active: false },
  { id: 3, label: "Keyed list runtime", active: false },
];

const initialScope = (): DemoScope => ({
  title: "Tachyon DOM browser example",
  initialCount: 7,
  count: 7,
  active: true,
  islandId: "counter-panel",
  rows: initialRows(),
  increment: () => undefined,
});

const compiledResult = compileTemplate(templateSource);
if (!compiledResult.ok) {
  throw new Error(compiledResult.error.message);
}

const compiled = compiledResult.value;
const listBinding = compiled.client.bindings.find((binding): binding is ListBinding => binding.kind === "list");
if (!listBinding) {
  throw new Error("Example template must include a keyed list.");
}
const rowBindings = listBinding.bindings.filter(
  (binding) => binding.kind === "text" || binding.kind === "class" || binding.kind === "event",
);

const generatedServerStreamModule = generateServerStreamModule(compiled);
const generatedClientModule = generateClientModule(compiled, { reactive: true });
const shellResult = compileTemplate(shellSource);
if (!shellResult.ok) {
  throw new Error(shellResult.error.message);
}
const shellTemplate = shellResult.value;

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

const bindPreview = (preview: HTMLElement, scope: DemoScope): void => {
  const root = preview.querySelector("main");
  if (!(root instanceof HTMLElement)) {
    throw new Error("Missing streamed root.");
  }

  const hydrationState = readHydrationState<HydratedDemoState>(preview, scope.islandId);
  const initialState = hydrationState.ok ? hydrationState.value : { count: scope.count, rows: scope.rows };
  const state = createStore({ ...scope, count: initialState.count, rows: [...initialState.rows] });
  const countMetric = document.querySelector("#metric-count");
  const rowsMetric = document.querySelector("#metric-rows");
  const hydrateMetric = document.querySelector("#metric-hydrate");
  const hydratedMetric = document.querySelector("#metric-hydrated");

  if (countMetric) {
    countMetric.textContent = String(state.count);
  }
  if (rowsMetric) {
    rowsMetric.textContent = String(state.rows.length);
  }

  if (hydrateMetric) {
    hydrateMetric.textContent = String(compiled.client.hydrationBoundaries.length);
  }
  if (hydratedMetric) {
    hydratedMetric.textContent = "no";
  }

  const hydrate = document.querySelector<HTMLButtonElement>("#hydrate");
  const increment = document.querySelector<HTMLButtonElement>("#increment");
  const prepend = document.querySelector<HTMLButtonElement>("#prepend");
  const rotate = document.querySelector<HTMLButtonElement>("#rotate");
  const toggle = document.querySelector<HTMLButtonElement>("#toggle");
  const hydrateResult = createHydrationBoundary(root, scope.islandId, (element) => {
    const button = element.querySelector("#boundary-button");
    const cleanups: Array<() => void> = [];
    const onBoundaryClick = () => {
      state.count += 1;
    };
    button?.addEventListener("click", onBoundaryClick);
    cleanups.push(() => button?.removeEventListener("click", onBoundaryClick));

    cleanups.push(
      effect(() => {
        if (button) {
          button.textContent = String(state.count);
        }
        if (countMetric) {
          countMetric.textContent = String(state.count);
        }
      }),
    );
    cleanups.push(
      effect(() => {
        element.classList.toggle("active", state.active);
      }),
    );
    cleanups.push(
      effect(() => {
        mountKeyedList(element, [1], state.rows, {
          key: listBinding.key,
          itemName: listBinding.itemName,
          templateHtml: listBinding.templateHtml,
          bindings: rowBindings,
        });
        if (rowsMetric) {
          rowsMetric.textContent = String(state.rows.length);
        }
      }),
    );
    if (hydratedMetric) {
      hydratedMetric.textContent = "yes";
    }
    return () => {
      for (const cleanup of cleanups) {
        cleanup();
      }
      if (hydratedMetric) {
        hydratedMetric.textContent = "no";
      }
    };
  });

  if (hydrateResult.ok && hydrate) {
    hydrate.onclick = () => hydrateResult.value.hydrate();
  }

  if (increment) {
    increment.onclick = () => {
      if (hydrateResult.ok) {
        hydrateResult.value.hydrate();
      }
      state.count += 1;
    };
  }
  if (prepend) {
    prepend.onclick = () => {
      if (hydrateResult.ok) {
        hydrateResult.value.hydrate();
      }
      const nextId = Math.max(...state.rows.map((row) => row.id)) + 1;
      state.rows = [{ id: nextId, label: `Inserted row ${nextId}`, active: false }, ...state.rows];
    };
  }
  if (rotate) {
    rotate.onclick = () => {
      if (hydrateResult.ok) {
        hydrateResult.value.hydrate();
      }
      const [first, ...rest] = state.rows;
      state.rows = first ? [...rest, first] : state.rows;
    };
  }
  if (toggle) {
    toggle.onclick = () => {
      if (hydrateResult.ok) {
        hydrateResult.value.hydrate();
      }
      state.active = !state.active;
      state.rows = state.rows.map((row, index) => ({ ...row, active: index === 0 ? !row.active : row.active }));
    };
  }
};

export const mountWebExample = async (app: HTMLElement): Promise<void> => {
  app.innerHTML = renderShell();
  const preview = app.querySelector("#preview");
  const chunksTarget = app.querySelector("#chunks");
  if (!(preview instanceof HTMLElement) || !(chunksTarget instanceof HTMLElement)) {
    throw new Error("Example shell failed to mount.");
  }

  const render = async (): Promise<void> => {
    const scope = initialScope();
    const { stream } = await importGeneratedServerModule();
    const chunks = await readTextStreamChunks(renderToReadableStream(stream(scope)));
    preview.innerHTML =
      chunks.join("") + serializeHydrationState(scope.islandId, { count: scope.count, rows: scope.rows });
    chunksTarget.innerHTML = renderChunkList(chunks);
    bindPreview(preview, scope);
  };

  app.querySelector("#rerender")?.addEventListener("click", () => {
    void render();
  });

  await render();
};

const app = document.querySelector("#app");
if (app instanceof HTMLElement) {
  void mountWebExample(app);
}
