import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { createBenchmarkTableApp } from "../benchmark/js-framework-benchmark/src/main";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

describe("js-framework-benchmark app", () => {
  it("creates rows from the checked-in benchmark HTML template", () => {
    const html = readFileSync(path.join(__dirname, "../benchmark/js-framework-benchmark/index.html"), "utf8");
    document.open();
    document.write(html);
    document.close();

    createBenchmarkTableApp(document);
    document.querySelector<HTMLButtonElement>("#run")?.click();

    const tbody = document.querySelector("#tbody");
    expect(tbody).toBeInstanceOf(HTMLTableSectionElement);
    expect((tbody as HTMLTableSectionElement).rows.length).toBe(1000);
    expect((tbody as HTMLTableSectionElement).rows[0]?.cells[0]?.textContent).toBe("1");
  });
});
