import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { mountFullAppExample } from "../examples/full-app/main";

const rootForTest = (): HTMLElement => {
  document.body.innerHTML = `<main id="app"></main>`;
  history.replaceState({}, "", "/examples/full-app/");
  const app = document.querySelector("#app");
  if (!(app instanceof HTMLElement)) {
    throw new Error("Missing app root.");
  }
  return app;
};

const settled = async (): Promise<void> => {
  await Promise.resolve();
  await Promise.resolve();
};

describe("full app example", () => {
  it("provides direct Vite entrypoints for every example page", () => {
    const pages = ["counter", "lists", "forms", "compiler", "settings"];

    for (const page of pages) {
      const entry = join(process.cwd(), "examples", "full-app", page, "index.html");
      expect(existsSync(entry)).toBe(true);
      expect(readFileSync(entry, "utf8")).toContain('src="../main.ts"');
    }
  });

  it("mounts a persistent layout and navigates between pages", async () => {
    const app = rootForTest();
    const instance = await mountFullAppExample(app);

    expect(app.querySelector("[data-testid='app-shell']")).toBeInstanceOf(HTMLElement);
    expect(app.querySelector("[data-testid='route-title']")?.textContent).toBe("Overview");

    await instance.router.navigate("/examples/full-app/counter");
    expect(app.querySelector("[data-testid='route-title']")?.textContent).toBe("Counter");

    await instance.router.navigate("/examples/full-app/lists");
    expect(app.querySelector("[data-testid='route-title']")?.textContent).toBe("Lists");

    instance.dispose();
  });

  it("updates counter signals, memos, and derived layout metrics", async () => {
    const app = rootForTest();
    const instance = await mountFullAppExample(app);

    await instance.router.navigate("/examples/full-app/counter");
    app.querySelector<HTMLButtonElement>("[data-testid='increment']")?.click();
    app.querySelector<HTMLButtonElement>("[data-testid='increment']")?.click();
    app.querySelector<HTMLButtonElement>("[data-testid='double-step']")?.click();
    await settled();

    expect(app.querySelector("[data-testid='count-value']")?.textContent).toBe("2");
    expect(app.querySelector("[data-testid='projected-value']")?.textContent).toBe("6");
    expect(app.querySelector("[data-testid='summary-count']")?.textContent).toBe("2");

    instance.dispose();
  });

  it("manages keyed list rows across add, rotate, and filter actions", async () => {
    const app = rootForTest();
    const instance = await mountFullAppExample(app);

    await instance.router.navigate("/examples/full-app/lists");
    const firstBefore = app.querySelector("[data-testid='row-label']");
    app.querySelector<HTMLButtonElement>("[data-testid='rotate-rows']")?.click();
    app.querySelector<HTMLButtonElement>("[data-testid='add-row']")?.click();
    app.querySelector<HTMLButtonElement>("[data-testid='toggle-open-only']")?.click();
    await settled();

    expect(app.querySelectorAll("[data-testid='row']").length).toBeGreaterThan(0);
    expect(app.textContent).toContain("Inserted row");
    expect(app.querySelector("[data-testid='row-label']")).not.toBe(firstBefore);

    instance.dispose();
  });

  it("validates and stores form submissions", async () => {
    const app = rootForTest();
    const instance = await mountFullAppExample(app);

    await instance.router.navigate("/examples/full-app/forms");
    app.querySelector<HTMLButtonElement>("[data-testid='save-profile']")?.click();
    expect(app.querySelector("[data-testid='form-status']")?.textContent).toContain("Enter a display name");

    app.querySelector<HTMLInputElement>("#display-name")!.value = "Ada Lovelace";
    app.querySelector<HTMLInputElement>("#email")!.value = "ada@example.com";
    app.querySelector<HTMLSelectElement>("#role")!.value = "Design systems";
    app.querySelector<HTMLButtonElement>("[data-testid='save-profile']")?.click();

    expect(app.querySelector("[data-testid='form-status']")?.textContent).toContain("Saved Ada Lovelace");
    expect(app.querySelector("[data-testid='profile-name']")?.textContent).toBe("Ada Lovelace");
    expect(app.querySelector("[data-testid='profile-email']")?.textContent).toBe("ada@example.com");
    expect(app.querySelector("[data-testid='profile-role']")?.textContent).toBe("Design systems");

    instance.dispose();
  });

  it("shows compiler and stream output on the diagnostics page", async () => {
    const app = rootForTest();
    const instance = await mountFullAppExample(app);

    await instance.router.navigate("/examples/full-app/compiler");

    expect(app.querySelector("[data-testid='compiled-template']")?.textContent).toContain("<for each={rows}");
    expect(app.querySelector("[data-testid='stream-output']")?.textContent).toContain("<section");
    expect(app.querySelector("[data-testid='generated-client']")?.textContent).toContain("mountKeyedList");

    instance.dispose();
  });
});
