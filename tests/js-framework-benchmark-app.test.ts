import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { mount } from "../benchmark/js-framework-benchmark/src/main";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

describe("js-framework-benchmark app", () => {
  afterEach(() => {
    document.body.innerHTML = "";
  });

  const loadBenchmarkDocument = () => {
    const html = readFileSync(path.join(__dirname, "../benchmark/js-framework-benchmark/index.html"), "utf8");
    document.open();
    document.write(html);
    document.close();
  };

  it("creates rows from the checked-in benchmark HTML template", () => {
    loadBenchmarkDocument();

    mount(document);
    document.querySelector<HTMLButtonElement>("#run")?.click();
    document.querySelector<HTMLButtonElement>("#add")?.click();
    document.querySelector<HTMLButtonElement>("#update")?.click();

    const tbody = document.querySelector("#tbody");
    expect(tbody).toBeInstanceOf(HTMLTableSectionElement);
    expect((tbody as HTMLTableSectionElement).rows.length).toBe(2000);
    expect((tbody as HTMLTableSectionElement).rows[0]?.cells[0]?.textContent).toBe("1");
    expect((tbody as HTMLTableSectionElement).rows[0]?.cells[1]?.textContent).toContain(" !!!");
    expect((tbody as HTMLTableSectionElement).rows[1000]?.cells[0]?.textContent).toBe("1001");
  });

  it("keeps row order, selection, and length consistent across keyed operations", () => {
    loadBenchmarkDocument();

    const list = mount(document);
    document.querySelector<HTMLButtonElement>("#run")?.click();
    list.selectAt(1);
    const tbody = document.querySelector<HTMLTableSectionElement>("#tbody");
    const firstId = tbody?.rows[1]?.cells[0]?.textContent;
    const thirdId = tbody?.rows[2]?.cells[0]?.textContent;
    const lastSwapId = tbody?.rows[998]?.cells[0]?.textContent;

    expect(list.length()).toBe(1000);
    expect(list.selectedIndex()).toBe(1);

    list.swap(1, 998);

    expect(tbody?.rows[1]?.cells[0]?.textContent).toBe(lastSwapId);
    expect(tbody?.rows[998]?.cells[0]?.textContent).toBe(firstId);
    expect(list.selectedIndex()).toBe(998);

    list.removeAt(1);

    expect(list.length()).toBe(999);
    expect(tbody?.rows[1]?.cells[0]?.textContent).toBe(thirdId);
    expect(list.selectedIndex()).toBe(997);

    document.querySelector<HTMLButtonElement>("#update")?.click();
    expect(tbody?.rows[0]?.cells[1]?.textContent).toContain(" !!!");
    expect(tbody?.rows[10]?.cells[1]?.textContent).toContain(" !!!");

    list.clear();

    expect(list.length()).toBe(0);
    expect(list.selectedIndex()).toBe(-1);
    expect(tbody?.rows.length).toBe(0);
  });

  it("includes mreact in the local js-framework-benchmark comparison", () => {
    const runner = readFileSync(path.join(__dirname, "../benchmark/local-compare/run-local-compare.ts"), "utf8");
    const html = readFileSync(path.join(__dirname, "../benchmark/local-compare/mreact/index.html"), "utf8");
    const source = readFileSync(path.join(__dirname, "../benchmark/local-compare/mreact/src/main.ts"), "utf8");

    expect(runner).toContain('name: "mreact-keyed"');
    expect(runner).toContain("/benchmark/local-compare/mreact/");
    expect(html).toContain("<title>Mreact keyed</title>");
    expect(html).toContain('id="runlots"');
    expect(html).toContain('id="tbody"');
    expect(source).toContain("@reckona/mreact-reactive-core");
    expect(source).toContain("@reckona/mreact-reactive-dom");
    expect(source).toContain("bindStaticKeyedSingleNodeList(");
    expect(source).toContain("deferEventPromotion: false");
  });

  it("runs mreact keyed table actions through the local comparison fixture", async () => {
    const html = readFileSync(path.join(__dirname, "../benchmark/local-compare/mreact/index.html"), "utf8");
    document.open();
    document.write(html);
    document.close();

    await import("../benchmark/local-compare/mreact/src/main");

    const click = async (selector: string): Promise<void> => {
      const element = document.querySelector<HTMLElement>(selector);
      if (!element) {
        throw new Error(`Missing ${selector}`);
      }
      element.click();
      await Promise.resolve();
    };
    const rows = (): HTMLTableRowElement[] => Array.from(document.querySelectorAll<HTMLTableRowElement>("#tbody tr"));
    const rowId = (row: HTMLTableRowElement): string => row.cells[0]?.textContent ?? "";
    const rowLabel = (row: HTMLTableRowElement): string => row.cells[1]?.textContent ?? "";

    await click("#run");
    expect(rows()).toHaveLength(1000);
    expect(rowId(rows()[0] as HTMLTableRowElement)).toBe("1");

    const firstLabel = rowLabel(rows()[0] as HTMLTableRowElement);
    await click("#update");
    expect(rowLabel(rows()[0] as HTMLTableRowElement)).toBe(`${firstLabel} !!!`);

    await click("#tbody tr:nth-child(2) td:nth-child(2) a");
    expect(rows()[1]?.className).toBe("danger");

    await click("#swaprows");
    expect(rowId(rows()[998] as HTMLTableRowElement)).toBe("2");
    expect(rows()[998]?.className).toBe("danger");

    await click("#tbody tr:nth-child(999) td:nth-child(3) a");
    expect(rows()).toHaveLength(999);
    expect(rows().some((row) => rowId(row) === "2")).toBe(false);

    await click("#clear");
    expect(rows()).toHaveLength(0);
  });
});
