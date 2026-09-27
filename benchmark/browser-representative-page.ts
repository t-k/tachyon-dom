import type { GeneratedClientModule } from "./generated-template-driver.js";
import type { BrowserRepresentativeSample } from "./browser-representative.js";

type BrowserSampleArgs = {
  pathName: "keyed-rows" | "text-template" | "mixed-template";
  itemCount: number;
  childCount: number;
  bundles: { driverCode: string; textCode: string; mixedCode: string };
};

export const runSample = async ({
  pathName,
  itemCount,
  childCount,
  bundles,
}: BrowserSampleArgs): Promise<BrowserRepresentativeSample> => {
  const importBundle = async (code: string) => {
    const url = URL.createObjectURL(new Blob([code], { type: "text/javascript" }));
    try {
      const nativeImport = new Function("url", "return import(url)") as (url: string) => Promise<unknown>;
      return await nativeImport(url);
    } finally {
      URL.revokeObjectURL(url);
    }
  };
  const importStarted = performance.now();
  const drivers = (await importBundle(bundles.driverCode)) as typeof import("./representative-drivers.js") &
    typeof import("./generated-representative-driver.js");
  const module =
    pathName === "keyed-rows"
      ? undefined
      : ((await importBundle(
          pathName === "text-template" ? bundles.textCode : bundles.mixedCode,
        )) as GeneratedClientModule);
  const coldImportMs = performance.now() - importStarted;
  const tbody = document.querySelector("tbody");
  if (!(tbody instanceof HTMLTableSectionElement)) throw new Error("Missing benchmark table body.");
  const driver =
    pathName === "keyed-rows"
      ? drivers.createKeyedRowsDriver(tbody)
      : drivers.createGeneratedTemplateDriver(tbody, module as GeneratedClientModule);
  let clickCount = 0;
  const itemsFor = (count: number, start = 0) =>
    Array.from({ length: count }, (_, index) => ({
      id: start + index,
      label: `Row ${start + index}`,
      selected: false,
      tags: Array.from({ length: childCount }, (_, tagIndex) => ({
        id: (start + index) * 100 + tagIndex,
        name: `tag ${start + index}.${tagIndex}`,
      })),
      onClick: () => {
        clickCount++;
      },
    }));
  const initial = itemsFor(itemCount);
  const appended = itemsFor(Math.max(1, Math.floor(itemCount / 4)), itemCount);
  const snapshot = () => {
    const rows = new Map<number, Element>();
    const children = new Map<number, Element>();
    driver.rows().forEach((row: Element, rowIndex: number) => {
      const item = driver.current()[rowIndex];
      if (!item) return;
      rows.set(item.id, row);
      driver.childRows(rowIndex).forEach((child: Element, childIndex: number) => {
        const tag = item.tags[childIndex];
        if (tag) children.set(tag.id, child);
      });
    });
    return { rows, children };
  };
  const frame = () => new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
  const measure = async (run: () => void) => {
    const before = snapshot();
    const started = performance.now();
    run();
    const syncUpdateMs = performance.now() - started;
    await frame();
    await frame();
    const settledUpdateMs = performance.now() - started;
    const after = snapshot();
    const rows = driver.rows();
    if (rows.length !== driver.current().length) throw new Error("Rendered row count differs from the model.");
    rows.forEach((row, rowIndex) => {
      const item = driver.current()[rowIndex];
      const label = row.cells[1]?.querySelector("span")?.textContent;
      if (!item || row.cells[0]?.textContent !== String(item.id) || label !== item.label) {
        throw new Error(`Rendered row ${rowIndex} differs from the model.`);
      }
      const children = driver.childRows(rowIndex);
      if (
        children.length !== item.tags.length ||
        children.some((child, index) => child.textContent !== item.tags[index]?.name)
      ) {
        throw new Error(`Rendered child list ${rowIndex} differs from the model.`);
      }
      if (pathName !== "text-template" && driver.inputValue(rowIndex) !== item.label) {
        throw new Error(`Live input ${rowIndex} differs from the model.`);
      }
    });
    return {
      syncUpdateMs,
      settledUpdateMs,
      rowCount: rows.length,
      preservedRowIdentities: [...after.rows].filter(([key, row]) => before.rows.get(key) === row).length,
      preservedChildIdentities: [...after.children].filter(([key, child]) => before.children.get(key) === child).length,
    };
  };
  const create = await measure(() => driver.replace(initial));
  const append = await measure(() => driver.append(appended));
  const partialUpdate = await measure(() => driver.partialUpdate([...initial, ...appended]));
  const swap = await measure(() => driver.swap());
  const remove = await measure(() => driver.remove());
  const childReorder = await measure(() => driver.reorderChildren());
  const childEmpty = await measure(() => driver.emptyChildren());
  let interaction;
  if (pathName !== "text-template") {
    driver.typeInto(1, "typed");
    driver.click(1);
    driver.setSelected(2, true);
    if (!driver.rows()[2]?.classList.contains("selected")) throw new Error("Selection class did not update.");
    interaction = {
      inputValue: driver.inputValue(1),
      modelLabel: driver.current()[1]?.label ?? "",
      clickCount,
      handlerRunsAfterDispose: 0,
    };
  }
  const detachedRow = driver.rows()[1];
  const clicksBeforeDispose = clickCount;
  const dispose = await measure(() => driver.dispose());
  detachedRow?.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
  if (interaction) interaction.handlerRunsAfterDispose = clickCount - clicksBeforeDispose;
  return {
    coldImportMs,
    create,
    append,
    partialUpdate,
    swap,
    remove,
    childReorder,
    childEmpty,
    dispose,
    ...(interaction ? { interaction } : {}),
  };
};
