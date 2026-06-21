<script>
import * as hydrateRuntime from "../../src/runtime/hydrate";
import * as listRuntime from "../../src/runtime/list";
import * as signalRuntime from "../../src/runtime/signal";
import * as storeRuntime from "../../src/runtime/store";

export const initialRows = () => [
  { id: 1, label: "Compiled template", active: true },
  { id: 2, label: "Chunk stream", active: false },
  { id: 3, label: "Keyed list runtime", active: false },
];

export const initialScope = () => ({
  title: "Tachyon DOM browser example",
  initialCount: 7,
  count: 7,
  active: true,
  islandId: "counter-panel",
  rows: initialRows(),
  increment: () => undefined,
});

export const bindPreview = (preview, scope, options) => {
  const root = preview.querySelector("main");
  if (!(root instanceof HTMLElement)) {
    throw new Error("Missing streamed root.");
  }

  const hydrationState = hydrateRuntime.readHydrationState(preview, scope.islandId);
  const initialState = hydrationState.ok ? hydrationState.value : { count: scope.count, rows: scope.rows };
  const state = storeRuntime.createStore({ ...scope, count: initialState.count, rows: [...initialState.rows] });
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
    hydrateMetric.textContent = String(options.compiled.client.hydrationBoundaries.length);
  }
  if (hydratedMetric) {
    hydratedMetric.textContent = "no";
  }

  const hydrate = document.querySelector("#hydrate");
  const increment = document.querySelector("#increment");
  const prepend = document.querySelector("#prepend");
  const rotate = document.querySelector("#rotate");
  const toggle = document.querySelector("#toggle");
  const hydrateResult = hydrateRuntime.createHydrationBoundary(root, scope.islandId, (element) => {
    const button = element.querySelector("#boundary-button");
    const cleanups = [];
    const onBoundaryClick = () => {
      state.count += 1;
    };
    button?.addEventListener("click", onBoundaryClick);
    cleanups.push(() => button?.removeEventListener("click", onBoundaryClick));

    cleanups.push(
      signalRuntime.effect(() => {
        if (button) {
          button.textContent = String(state.count);
        }
        if (countMetric) {
          countMetric.textContent = String(state.count);
        }
      }),
    );
    cleanups.push(
      signalRuntime.effect(() => {
        element.classList.toggle("active", state.active);
      }),
    );
    cleanups.push(
      signalRuntime.effect(() => {
        listRuntime.mountKeyedList(element, [1], state.rows, {
          key: options.listBinding.key,
          itemName: options.listBinding.itemName,
          templateHtml: options.listBinding.templateHtml,
          bindings: options.rowBindings,
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

  if (hydrateResult.ok && hydrate instanceof HTMLButtonElement) {
    hydrate.onclick = () => hydrateResult.value.hydrate();
  }

  if (increment instanceof HTMLButtonElement) {
    increment.onclick = () => {
      if (hydrateResult.ok) {
        hydrateResult.value.hydrate();
      }
      state.count += 1;
    };
  }
  if (prepend instanceof HTMLButtonElement) {
    prepend.onclick = () => {
      if (hydrateResult.ok) {
        hydrateResult.value.hydrate();
      }
      const nextId = Math.max(...state.rows.map((row) => row.id)) + 1;
      state.rows = [{ id: nextId, label: `Inserted row ${nextId}`, active: false }, ...state.rows];
    };
  }
  if (rotate instanceof HTMLButtonElement) {
    rotate.onclick = () => {
      if (hydrateResult.ok) {
        hydrateResult.value.hydrate();
      }
      const [first, ...rest] = state.rows;
      state.rows = first ? [...rest, first] : state.rows;
    };
  }
  if (toggle instanceof HTMLButtonElement) {
    toggle.onclick = () => {
      if (hydrateResult.ok) {
        hydrateResult.value.hydrate();
      }
      state.active = !state.active;
      state.rows = state.rows.map((row, index) => ({ ...row, active: index === 0 ? !row.active : row.active }));
    };
  }
};
</script>
<main>
  <store count={initialCount} />
  <h1>{title}</h1>
  <component name="CounterPanel"><section hydrate:id={islandId} class:active={active}><if test={active}><button id="boundary-button" data-testid="boundary-button" on:click={increment}>{count}</button></if><ul><for each={rows} key={row.id}><li class:active={row.active}>{row.label}</li></for></ul></section></component>
</main>
