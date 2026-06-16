import { Readable } from "node:stream";
import { describe, expect, it, vi } from "vitest";
import { createNodeHandler, createWorkersHandler } from "../src/adapters";
import { createSecurityHeaders, type RouteDefinition } from "../src/router";

describe("server adapters", () => {
  it("creates a Workers fetch handler with security headers", async () => {
    const routes: RouteDefinition[] = [{ path: "/", render: () => "<h1>Home</h1>" }];
    const handler = createWorkersHandler({
      routes,
      securityHeaders: createSecurityHeaders({ csp: true, nonce: "abc" }),
    });

    const response = await handler.fetch(new Request("https://example.com/"));

    expect(response.status).toBe(200);
    expect(response.headers.get("content-security-policy")).toContain("'nonce-abc'");
    expect(await response.text()).toBe("<h1>Home</h1>");
  });

  it("creates a Node handler that writes status, headers, and body", async () => {
    const routes: RouteDefinition[] = [{ path: "/", render: () => "<h1>Home</h1>" }];
    const req = Readable.from([]) as unknown as NodeJS.ReadableStream & {
      method: string;
      url: string;
      headers: Record<string, string>;
    };
    req.method = "GET";
    req.url = "/";
    req.headers = { host: "example.com" };
    const chunks: string[] = [];
    const res = {
      statusCode: 200,
      setHeader: vi.fn(),
      end: vi.fn((chunk?: string) => {
        if (chunk) {
          chunks.push(chunk);
        }
      }),
    };

    await createNodeHandler({ routes })(req as never, res as never);

    expect(res.statusCode).toBe(200);
    expect(res.setHeader).toHaveBeenCalledWith("content-type", "text/html; charset=utf-8");
    expect(chunks.join("")).toBe("<h1>Home</h1>");
  });
});
