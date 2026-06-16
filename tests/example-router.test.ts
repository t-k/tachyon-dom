import { describe, expect, it } from "vitest";
import { renderRouterExample } from "../examples/router";

describe("router example", () => {
  it("renders nested route HTML, head tags, and route hydration state", async () => {
    const html = await renderRouterExample();

    expect(html).toContain(`<main><h1>User 42</h1></main>`);
    expect(html).toContain(`<title>User 42</title>`);
    expect(html).toContain(`data-tachyon-state="route:user"`);
  });
});
