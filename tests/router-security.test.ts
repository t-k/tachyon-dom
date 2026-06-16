import { describe, expect, it } from "vitest";
import {
  createCookieSessionStorage,
  createMemorySessionStorage,
  parseCookies,
  serializeCookie,
  signCookieValue,
  verifySignedCookieValue,
} from "../src/cookies";
import { createCsrfToken, createHtmlSanitizer, csrfInput, sanitizeHtml, verifyCsrfRequest } from "../src/security";
import { html, renderRoute, unsafeHtml, type RouteDefinition } from "../src/router";

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

  it("allows sanitizer adapters for production sanitizer backends", () => {
    const sanitizer = createHtmlSanitizer({
      sanitize: (markup) => markup.replaceAll("<danger>", "<safe>").replaceAll("</danger>", "</safe>"),
    });

    expect(sanitizer("<danger>ok</danger>").value).toBe("<safe>ok</safe>");
    expect(sanitizeHtml("<danger>ok</danger>", { adapter: sanitizer }).value).toBe("<safe>ok</safe>");
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

  it("signs cookie values and rejects tampered session cookies", async () => {
    const signed = signCookieValue("session", "secret");
    expect(verifySignedCookieValue(signed, "secret")).toBe("session");
    expect(verifySignedCookieValue(`${signed}x`, "secret")).toBeUndefined();

    const storage = createCookieSessionStorage<{ userId: string }>({
      secret: "secret",
      cookieName: "__Host-session",
      id: () => "s1",
    });
    const cookie = await storage.commitSession({ id: "s1", data: { userId: "u1" } });
    expect(cookie).toContain("Secure");
    expect(cookie).toContain("HttpOnly");
    expect(cookie).toContain("SameSite=Lax");

    const restored = await storage.getSession(cookie);
    expect(restored.data).toEqual({ userId: "u1" });

    const tampered = cookie.replace(/=([^;]+)/, "=tampered");
    await expect(storage.getSession(tampered)).resolves.toEqual({ id: "", data: {} });
  });

  it("creates auth guard middleware for protected routes", async () => {
    const routes: RouteDefinition[] = [{ path: "/admin", render: () => "<h1>Admin</h1>" }];
    const { requireUser } = await import("../src/router");

    const denied = await renderRoute(routes, "https://x.test/admin", {
      middleware: [requireUser(() => undefined, { redirectTo: "/login" })],
    });
    expect(denied.ok && denied.value.status).toBe(302);
    expect(denied.ok && denied.value.headers.get("location")).toBe("/login");

    const allowed = await renderRoute(routes, "https://x.test/admin", {
      middleware: [requireUser(() => ({ id: "u1" }), { forbidden: () => html(unsafeHtml("no")) })],
    });
    expect(allowed.ok && allowed.value.html).toBe("<h1>Admin</h1>");
  });
});
