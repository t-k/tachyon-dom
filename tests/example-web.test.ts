import { existsSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { mountWebExample } from "../examples/web/main";

describe("browser web example", () => {
  it("uses route-local template files without a hand-written index file", () => {
    const root = join(process.cwd(), "examples", "web");

    expect(existsSync(join(root, "demo.td"))).toBe(true);
    expect(existsSync(join(root, "shell.td"))).toBe(true);
    expect(existsSync(join(root, "index.html"))).toBe(false);
  });

  it("mounts the full feature demo and updates store/list state", async () => {
    document.body.innerHTML = `<div id="app"></div>`;
    const app = document.querySelector("#app");
    if (!(app instanceof HTMLElement)) {
      throw new Error("Missing app root.");
    }

    await mountWebExample(app);

    expect(app.textContent).toContain("Tachyon DOM browser example");
    expect(app.innerHTML).toContain("<!--tachyon-hydrate:counter-panel:start-->");
    expect(app.querySelector("#metric-count")?.textContent).toBe("7");
    expect(app.querySelector("#metric-rows")?.textContent).toBe("3");
    expect(app.querySelector("#metric-hydrate")?.textContent).toBe("1");

    app.querySelector<HTMLButtonElement>("#increment")?.click();
    app.querySelector<HTMLButtonElement>("#prepend")?.click();

    expect(app.querySelector("#metric-count")?.textContent).toBe("8");
    expect(app.querySelector("#metric-rows")?.textContent).toBe("4");
    expect(app.querySelector(".preview li")?.textContent).toContain("Inserted row 4");
  });
});
