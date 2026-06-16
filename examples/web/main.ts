import "./styles.css";
import {
  compileTemplate,
  generateClientModule,
  generateServerStreamModule,
  type ListBinding,
} from "../../src/compiler";
import { mountKeyedList } from "../../src/runtime/list";
import { effect } from "../../src/runtime/signal";
import { createStore } from "../../src/runtime/store";
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
};

type GeneratedServerModule = {
  stream: (scope: DemoScope) => AsyncIterable<string>;
};

const templateSource = `<main><store count={initialCount}/><h1>{title}</h1><section hydrate:id={islandId} class:active={active}><button>{count}</button><ul><for each={rows} key={row.id}><li class:active={row.active}>{row.label}</li></for></ul></section></main>`;

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
const rowBindings = listBinding.bindings.filter((binding) => binding.kind !== "list");

const generatedServerStreamModule = generateServerStreamModule(compiled);
const generatedClientModule = generateClientModule(compiled, { reactive: true });

const encodeBase64 = (value: string): string => btoa(value);

const importGeneratedServerModule = async (): Promise<GeneratedServerModule> =>
  (await import(
    /* @vite-ignore */ `data:text/javascript;base64,${encodeBase64(generatedServerStreamModule)}`
  )) as GeneratedServerModule;

const readStreamChunks = async (stream: ReadableStream<Uint8Array>): Promise<string[]> => {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  const chunks: string[] = [];
  while (true) {
    const result = await reader.read();
    if (result.done) {
      return chunks;
    }
    chunks.push(decoder.decode(result.value, { stream: true }));
  }
};

const escapeText = (value: string): string =>
  value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");

const renderChunkList = (chunks: readonly string[]): string =>
  chunks.map((chunk, index) => `<div class="chunk"><strong>${index + 1}</strong> ${escapeText(chunk)}</div>`).join("");

const renderShell = (): string => `
  <div class="shell">
    <header class="topbar">
      <div>
        <h1>Tachyon DOM</h1>
        <p>HTML-first compiler, store state, hydrate boundary markers, keyed list updates, and chunk streaming.</p>
      </div>
      <button id="rerender" class="secondary">Re-stream SSR</button>
    </header>
    <section class="grid">
      <article class="panel">
        <h2>Browser Preview</h2>
        <div id="preview" class="preview"></div>
        <div class="controls">
          <button id="increment">Increment store</button>
          <button id="prepend" class="secondary">Prepend row</button>
          <button id="rotate" class="secondary">Rotate rows</button>
          <button id="toggle" class="secondary">Toggle active</button>
        </div>
      </article>
      <aside class="panel">
        <h2>Runtime State</h2>
        <div class="metrics">
          <div class="metric"><span>Count</span><strong id="metric-count">0</strong></div>
          <div class="metric"><span>Rows</span><strong id="metric-rows">0</strong></div>
          <div class="metric"><span>Hydrate</span><strong id="metric-hydrate">0</strong></div>
        </div>
        <h2>Stream Chunks</h2>
        <div id="chunks" class="chunk-list"></div>
      </aside>
    </section>
    <section class="grid">
      <article class="panel">
        <h2>Template</h2>
        <pre class="code">${escapeText(templateSource)}</pre>
      </article>
      <article class="panel">
        <h2>Generated Client Shape</h2>
        <pre class="code">${escapeText(generatedClientModule)}</pre>
      </article>
    </section>
  </div>
`;

const bindPreview = (preview: HTMLElement, scope: DemoScope): void => {
  const root = preview.querySelector("main");
  if (!(root instanceof HTMLElement)) {
    throw new Error("Missing streamed root.");
  }

  const state = createStore({ ...scope, rows: [...scope.rows] });
  const section = root.querySelector("section");
  const button = section?.querySelector("button");
  const countMetric = document.querySelector("#metric-count");
  const rowsMetric = document.querySelector("#metric-rows");
  const hydrateMetric = document.querySelector("#metric-hydrate");

  effect(() => {
    if (button) {
      button.textContent = String(state.count);
    }
    if (countMetric) {
      countMetric.textContent = String(state.count);
    }
  });

  effect(() => {
    section?.classList.toggle("active", state.active);
  });

  effect(() => {
    if (!section) {
      return;
    }
    mountKeyedList(section, [1], state.rows, {
      key: listBinding.key,
      itemName: listBinding.itemName,
      templateHtml: listBinding.templateHtml,
      bindings: rowBindings,
    });
    if (rowsMetric) {
      rowsMetric.textContent = String(state.rows.length);
    }
  });

  if (hydrateMetric) {
    hydrateMetric.textContent = String(compiled.client.hydrationBoundaries.length);
  }

  const increment = document.querySelector<HTMLButtonElement>("#increment");
  const prepend = document.querySelector<HTMLButtonElement>("#prepend");
  const rotate = document.querySelector<HTMLButtonElement>("#rotate");
  const toggle = document.querySelector<HTMLButtonElement>("#toggle");

  if (increment) {
    increment.onclick = () => {
      state.count += 1;
    };
  }
  if (prepend) {
    prepend.onclick = () => {
      const nextId = Math.max(...state.rows.map((row) => row.id)) + 1;
      state.rows = [{ id: nextId, label: `Inserted row ${nextId}`, active: false }, ...state.rows];
    };
  }
  if (rotate) {
    rotate.onclick = () => {
      const [first, ...rest] = state.rows;
      state.rows = first ? [...rest, first] : state.rows;
    };
  }
  if (toggle) {
    toggle.onclick = () => {
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
    const { stream } = await importGeneratedServerModule();
    const chunks = await readStreamChunks(renderToReadableStream(stream(initialScope())));
    preview.innerHTML = chunks.join("");
    chunksTarget.innerHTML = renderChunkList(chunks);
    bindPreview(preview, initialScope());
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
