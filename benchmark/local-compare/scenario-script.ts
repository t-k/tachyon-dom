export const browserScenarioScript = String.raw`
window.__runLocalBenchmarkScenario = async (id) => {
  const frame = () => new Promise((resolve) => requestAnimationFrame(() => resolve()));
  const settle = async () => {
    await frame();
    await frame();
  };
  const click = (selector) => {
    const element = document.querySelector(selector);
    if (!element) {
      throw new Error("Missing selector: " + selector);
    }
    if (element instanceof HTMLElement) {
      element.click();
    } else {
      element.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, view: window }));
    }
  };
  const assertForeground = () => {
    const entries = performance.getEntriesByType("visibility-state");
    const firstEntry = entries[0];
    if (document.visibilityState === "hidden" || firstEntry?.name === "hidden") {
      throw new Error("The benchmark page is hidden; foreground the browser or run headless.");
    }
  };
  const actionFor = (action) => {
    const selectors = {
      run: "#run",
      runlots: "#runlots",
      add: "#add",
      update: "#update",
      clear: "#clear",
      swaprows: "#swaprows",
      select: "#tbody tr:nth-child(2) td:nth-child(2) a",
      remove: "#tbody tr:nth-child(2) td:nth-child(3) span",
    };
    const selector = selectors[action];
    if (!selector) {
      throw new Error("Unknown action: " + action);
    }
    return selector;
  };
  const plans = {
    createRows: { setup: ["clear"], measure: "run" },
    replaceAllRows: { setup: ["run"], measure: "run" },
    partialUpdate: { setup: ["run"], measure: "update" },
    selectRow: { setup: ["run"], measure: "select" },
    swapRows: { setup: ["run"], measure: "swaprows" },
    removeRow: { setup: ["run"], measure: "remove" },
    createManyRows: { setup: ["clear"], measure: "runlots" },
    appendRows: { setup: ["run"], measure: "add" },
    clearRows: { setup: ["run"], measure: "clear" },
  };
  const plan = plans[id];
  if (!plan) {
    throw new Error("Unknown scenario: " + id);
  }

  assertForeground();
  for (const action of plan.setup) {
    click(actionFor(action));
    await settle();
  }

  const start = performance.now();
  click(actionFor(plan.measure));
  const syncUpdateMs = performance.now() - start;
  await settle();
  return { syncUpdateMs, settledUpdateMs: performance.now() - start };
};
`;
