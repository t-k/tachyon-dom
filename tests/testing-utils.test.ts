import { describe, expect, it } from "vitest";
import { assertRouteParity, renderRouteForTest } from "../src/testing";

describe("testing utilities", () => {
  it("renders routes for tests and checks server/client parity", async () => {
    const route = { path: "/", render: () => "<h1>Home</h1>" };

    expect((await renderRouteForTest([route], "/")).html).toBe("<h1>Home</h1>");
    await expect(assertRouteParity([route], [{ path: "/", clientHtml: "<h1>Home</h1>" }])).resolves.toBeUndefined();
    await expect(assertRouteParity([route], [{ path: "/", clientHtml: "<h1>Other</h1>" }])).rejects.toThrow(
      "Route parity mismatch",
    );
  });
});
