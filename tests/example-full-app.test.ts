import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { build } from "vite";
import { mountFullAppExample } from "../examples/full-app/main";
import { renderFullAppDocument, renderFullAppShellHtml } from "../examples/full-app/ssr";

const rootForTest = (): HTMLElement => {
  document.body.innerHTML = `<main id="app"></main>`;
  history.replaceState({}, "", "/");
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
  it("ships server-rendered initial HTML for every example page", () => {
    const pages = [
      {
        path: "/",
        file: "index.html",
        prefix: ".",
        title: "Overview",
        marker: "Persistent layout with route-level tools",
      },
      {
        path: "/counter/",
        prefix: "..",
        title: "Counter",
        marker: "Projected value is count plus two steps.",
      },
      { path: "/lists/", prefix: "..", title: "Lists", marker: "Compiler bindings" },
      { path: "/forms/", prefix: "..", title: "Forms", marker: "guest@example.com" },
      { path: "/compiler/", prefix: "..", title: "Compiler", marker: "mountKeyedList" },
      { path: "/settings/", prefix: "..", title: "Settings", marker: "Comfortable" },
    ];

    for (const page of pages) {
      const html = renderFullAppDocument(page.path, page.prefix);
      expect(html).toContain(`data-ssr-route="${page.path}"`);
      expect(html).toContain('data-testid="app-shell"');
      expect(html).toContain(`<h1 data-testid="route-title">${page.title}</h1>`);
      expect(html).toContain(page.marker);
      expect(renderFullAppShellHtml(page.path)).toContain(`data-ssr-route="${page.path}"`);
    }
  });

  it("does not keep generated HTML entry files in source", () => {
    const pages = ["counter", "lists", "forms", "compiler", "settings"];

    expect(existsSync(join(process.cwd(), "examples", "full-app", "index.html"))).toBe(false);
    for (const page of pages) {
      const entry = join(process.cwd(), "examples", "full-app", page, "index.html");
      expect(existsSync(entry)).toBe(false);
    }
  });

  it("keeps page markup in short route-local template files", () => {
    const templates = ["overview", "counter", "lists", "forms", "compiler", "settings"];

    for (const page of templates) {
      const template = join(process.cwd(), "examples", "full-app", page, "page.td");
      expect(existsSync(template)).toBe(true);
      const source = readFileSync(template, "utf8");
      expect(source).toContain("<script>");
      expect(source).toContain("<section");
    }
  });

  it("builds every SSR page entry and minifies production HTML", async () => {
    const outDir = mkdtempSync(join(tmpdir(), "tachyon-full-app-build-"));
    try {
      await build({
        build: {
          emptyOutDir: true,
          outDir,
        },
        configFile: join(process.cwd(), "examples", "full-app", "vite.config.ts"),
        logLevel: "silent",
      });

      const pages = [
        "index.html",
        "counter/index.html",
        "lists/index.html",
        "forms/index.html",
        "compiler/index.html",
        "settings/index.html",
      ];
      for (const page of pages) {
        expect(existsSync(join(outDir, page))).toBe(true);
      }
      const html = readFileSync(join(outDir, "counter", "index.html"), "utf8");
      expect(html).toContain('data-ssr-route="/counter/"');
      expect(html).toContain("Projected value is count plus two steps.");
      expect(html).not.toContain("\n  <");
    } finally {
      rmSync(outDir, { force: true, recursive: true });
    }
  }, 30000);

  it("mounts a persistent layout and navigates between pages", async () => {
    const app = rootForTest();
    const instance = await mountFullAppExample(app);

    expect(app.querySelector("[data-testid='app-shell']")).toBeInstanceOf(HTMLElement);
    expect(app.querySelector("[data-testid='route-title']")?.textContent).toBe("Overview");

    await instance.router.navigate("/counter/");
    expect(app.querySelector("[data-testid='route-title']")?.textContent).toBe("Counter");

    await instance.router.navigate("/lists/");
    expect(app.querySelector("[data-testid='route-title']")?.textContent).toBe("Lists");

    instance.dispose();
  });

  it("updates counter signals, memos, and derived layout metrics", async () => {
    const app = rootForTest();
    const instance = await mountFullAppExample(app);

    await instance.router.navigate("/counter/");
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

    await instance.router.navigate("/lists/");
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

    await instance.router.navigate("/forms/");
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

    await instance.router.navigate("/compiler/");

    expect(app.querySelector("[data-testid='compiled-template']")?.textContent).toContain("<for each={rows}");
    expect(app.querySelector("[data-testid='stream-output']")?.textContent).toContain("<section");
    expect(app.querySelector("[data-testid='generated-client']")?.textContent).toContain("mountKeyedList");

    instance.dispose();
  });
});
