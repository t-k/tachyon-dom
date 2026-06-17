import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { createBenchmarkTableApp } from "../benchmark/js-framework-benchmark/src/main";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

describe("js-framework-benchmark app", () => {
  const loadBenchmarkDocument = () => {
    const html = readFileSync(path.join(__dirname, "../benchmark/js-framework-benchmark/index.html"), "utf8");
    document.open();
    document.write(html);
    document.close();
  };

  it("creates rows from the checked-in benchmark HTML template", () => {
    loadBenchmarkDocument();

    createBenchmarkTableApp(document);
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

    const app = createBenchmarkTableApp(document);
    app.replace(1000);
    app.selectIndex(1);
    const tbody = document.querySelector<HTMLTableSectionElement>("#tbody");
    const firstId = tbody?.rows[1]?.cells[0]?.textContent;
    const thirdId = tbody?.rows[2]?.cells[0]?.textContent;
    const lastSwapId = tbody?.rows[998]?.cells[0]?.textContent;

    expect(app.length()).toBe(1000);
    expect(app.selectedIndex()).toBe(1);

    app.swap(1, 998);

    expect(tbody?.rows[1]?.cells[0]?.textContent).toBe(lastSwapId);
    expect(tbody?.rows[998]?.cells[0]?.textContent).toBe(firstId);
    expect(app.selectedIndex()).toBe(998);

    app.removeIndex(1);

    expect(app.length()).toBe(999);
    expect(tbody?.rows[1]?.cells[0]?.textContent).toBe(thirdId);
    expect(app.selectedIndex()).toBe(997);

    app.updateEvery(10);
    expect(tbody?.rows[0]?.cells[1]?.textContent).toContain(" !!!");
    expect(tbody?.rows[10]?.cells[1]?.textContent).toContain(" !!!");

    app.clear();

    expect(app.length()).toBe(0);
    expect(app.selectedIndex()).toBe(-1);
    expect(tbody?.rows.length).toBe(0);
  });
});
