import { describe, expect, it } from "vitest";
import { createMemorySessionStorage, parseCookies, serializeCookie } from "../src/cookies";
import { createCsrfToken, csrfInput, sanitizeHtml, verifyCsrfRequest } from "../src/security";
import { html, renderRoute, type RouteDefinition } from "../src/router";

describe("router security helpers", () => {
  it("sanitizes route HTML before creating trusted HTML responses", async () => {
    const safe = sanitizeHtml(
      `<article onclick="steal()"><h1>Post</h1><a href="javascript:alert(1)">bad</a><script>alert(1)</script></article>`,
    );
    const result = await renderRoute(
      [{ path: "/", loader: () => html(safe), render: () => "never" }],
      "https://x.test/",
    );

    expect(result.ok && result.value.html).toBe(`<article><h1>Post</h1><a>bad</a></article>`);
  });

  it("verifies CSRF tokens from headers or progressive form bodies", async () => {
    const token = createCsrfToken("fixed");
    expect(csrfInput(token).value).toBe(`<input type="hidden" name="_csrf" value="fixed">`);

    const headerRequest = new Request("https://x.test/action", {
      method: "POST",
      headers: { "x-csrf-token": token },
    });
    await expect(verifyCsrfRequest(headerRequest, { token })).resolves.toBe(true);

    const formRequest = new Request("https://x.test/action", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ _csrf: token }),
    });
    await expect(verifyCsrfRequest(formRequest, { token })).resolves.toBe(true);
  });

  it("blocks route actions when CSRF verification fails", async () => {
    const routes: RouteDefinition[] = [{ path: "/action", action: () => ({ ok: true }), render: () => "ok" }];
    const result = await renderRoute(routes, new Request("https://x.test/action", { method: "POST" }), {
      csrf: { token: "expected" },
    });

    expect(result.ok && result.value).toMatchObject({ status: 403, html: "<h1>Forbidden</h1>" });
  });

  it("parses cookies and commits in-memory sessions", async () => {
    expect(parseCookies("theme=dark; sid=abc")).toEqual({ theme: "dark", sid: "abc" });
    expect(serializeCookie("sid", "abc", { httpOnly: true, sameSite: "Lax", path: "/" })).toBe(
      "sid=abc; Path=/; HttpOnly; SameSite=Lax",
    );

    const storage = createMemorySessionStorage({ cookieName: "sid" });
    const session = await storage.createSession({ userId: "u1" });
    const cookie = await storage.commitSession(session);
    const restored = await storage.getSession(cookie);

    expect(restored.data).toEqual({ userId: "u1" });
  });
});
