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
import {
  createSecurityHeaders,
  html,
  redirect,
  renderHead,
  renderRoute,
  unsafeHtml,
  type RouteDefinition,
} from "../src/router";

const sessionSecret = "s".repeat(32);

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

  it("requires factory-created TrustedHtml values at runtime", () => {
    expect(html(unsafeHtml("<strong>Safe</strong>")).body).toBe("<strong>Safe</strong>");
    expect(() => html({ __tachyonTrustedHtml: true, value: "<img src=x onerror=alert(1)>" } as never)).toThrow(
      "TrustedHtml values must be created by tachyon-dom helpers",
    );
  });

  it("rejects protocol-relative and unapproved absolute sanitizer URLs", () => {
    expect(
      sanitizeHtml(
        `<a href="//evil.test/path">protocol</a><a href="https://evil.test/path">external</a><a href="/safe">safe</a>`,
      ).value,
    ).toBe(`<a>protocol</a><a>external</a><a href="/safe">safe</a>`);
    expect(sanitizeHtml(`<a href="/%5C%5Cevil.test/path">backslash</a>`).value).toBe(`<a>backslash</a>`);

    expect(
      sanitizeHtml(`<a href="https://assets.example/path">approved</a>`, {
        allowedUrlOrigins: ["https://assets.example"],
      }).value,
    ).toBe(`<a href="https://assets.example/path">approved</a>`);
  });

  it("escapes malformed or unclosed tags that the sanitizer cannot parse safely", () => {
    expect(sanitizeHtml(`<img src=x onerror="alert(1)"`).value).toBe(`&lt;img src=x onerror=&quot;alert(1)&quot;`);
    expect(sanitizeHtml(`<svg onload="alert(1)"`).value).toBe(`&lt;svg onload=&quot;alert(1)&quot;`);
    expect(sanitizeHtml(`ok <img src=x onerror=alert(1) > done`).value).toBe(`ok <img> done`);
  });

  it("rejects unsafe redirect targets and restricts approved external origins", () => {
    expect(() => redirect("//evil.test/path")).toThrow("Unsafe redirect target");
    expect(() => redirect("/%5C%5Cevil.test/path")).toThrow("Unsafe redirect target");
    expect(() => redirect("/\t/evil.test/path")).toThrow("Unsafe redirect target");
    expect(() => redirect("/\n/evil.test/path")).toThrow("Unsafe redirect target");
    expect(() => redirect("/%09/evil.test/path")).toThrow("Unsafe redirect target");
    expect(() => redirect("https://evil.test/path", { allowExternal: true })).toThrow("Unsafe redirect target");
    expect(() =>
      redirect("https://evil.test/path", { allowExternal: true, allowedOrigins: ["https://accounts.example"] }),
    ).toThrow("Unsafe redirect target");
    expect(() =>
      redirect("javascript:alert(1)", { allowExternal: true, allowedOrigins: ["https://accounts.example"] }),
    ).toThrow("Unsafe redirect target");

    expect(
      redirect("https://accounts.example/callback", {
        allowExternal: true,
        allowedOrigins: ["https://accounts.example"],
      }).headers.get("location"),
    ).toBe("https://accounts.example/callback");
  });

  it("rejects sanitizer URL attributes that contain control characters", () => {
    expect(sanitizeHtml(`<a href="/\t/evil.test/path">tab</a><a href="/safe">safe</a>`).value).toBe(
      `<a>tab</a><a href="/safe">safe</a>`,
    );
    expect(sanitizeHtml(`<a href="/%09/evil.test/path">encoded</a>`).value).toBe(`<a>encoded</a>`);
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

  it.each([
    {
      label: "text/plain",
      request: () =>
        new Request("https://x.test/action", {
          method: "POST",
          headers: { "content-type": "text/plain" },
          body: "_csrf=fixed",
        }),
    },
    {
      label: "multipart without a boundary",
      request: () =>
        new Request("https://x.test/action", {
          method: "POST",
          headers: { "content-type": "multipart/form-data" },
          body: "_csrf=fixed",
        }),
    },
  ])("fails closed for unsupported or malformed CSRF body: $label", async ({ request }) => {
    await expect(verifyCsrfRequest(request(), { token: "fixed" })).resolves.toBe(false);
  });

  it("returns 403 instead of 500 when a CSRF form body is malformed", async () => {
    let actionCalled = false;
    const result = await renderRoute(
      [
        {
          path: "/action",
          action: () => {
            actionCalled = true;
            return { ok: true };
          },
          render: () => "ok",
        },
      ],
      new Request("https://x.test/action", {
        method: "POST",
        headers: { "content-type": "multipart/form-data" },
        body: "_csrf=fixed",
      }),
      {
        csrf: {
          verify: ({ request }) => verifyCsrfRequest(request, { token: "fixed" }),
        },
      },
    );

    expect(result.ok && result.value.status).toBe(403);
    expect(actionCalled).toBe(false);
  });

  it("blocks route actions when CSRF verification fails", async () => {
    const routes: RouteDefinition[] = [{ path: "/action", action: () => ({ ok: true }), render: () => "ok" }];
    const result = await renderRoute(routes, new Request("https://x.test/action", { method: "POST" }), {
      csrf: { verify: () => false },
    });

    expect(result.ok && result.value).toMatchObject({ status: 403, html: "<h1>Forbidden</h1>" });
  });

  it("rejects a CSRF token resolved for a different session", async () => {
    const routes: RouteDefinition[] = [{ path: "/action", action: () => ({ ok: true }), render: () => "ok" }];
    const options = {
      csrf: {
        verify: async ({ request }: { request: Request }) => {
          const session = parseCookies(request.headers.get("cookie")).sid;
          return request.headers.get("x-csrf-token") === `token-for-${session}`;
        },
      },
    };
    const sessionA = new Request("https://x.test/action", {
      method: "POST",
      headers: { cookie: "sid=a", "x-csrf-token": "token-for-a" },
    });
    const replayAgainstB = new Request("https://x.test/action", {
      method: "POST",
      headers: { cookie: "sid=b", "x-csrf-token": "token-for-a" },
    });

    const [accepted, rejected] = await Promise.all([
      renderRoute(routes, sessionA, options),
      renderRoute(routes, replayAgainstB, options),
    ]);

    expect(accepted.ok && accepted.value.status).toBe(200);
    expect(rejected.ok && rejected.value.status).toBe(403);
  });

  it("applies the configured body byte cap before POST loaders consume the stream", async () => {
    const routes: RouteDefinition[] = [
      {
        path: "/upload",
        loader: async ({ request }) => ({ body: await request.text() }),
        render: ({ data }) => `<p>${(data as { body: string }).body}</p>`,
      },
    ];
    const request = new Request("https://x.test/upload", {
      method: "POST",
      body: "abcdef",
    });

    const result = await renderRoute(routes, request, { maxActionBodyBytes: 3 });

    expect(result.ok && result.value).toMatchObject({ status: 413, html: "<h1>Payload Too Large</h1>" });
  });

  it("applies the body byte cap before request hooks and middleware consume the stream", async () => {
    const calls: string[] = [];
    const request = new Request("https://x.test/upload", {
      method: "POST",
      body: "abcdef",
    });

    const result = await renderRoute([{ path: "/upload", action: () => "ok", render: () => "ok" }], request, {
      maxActionBodyBytes: 3,
      hooks: {
        onRequest: async ({ request: hookRequest }) => {
          calls.push(await hookRequest.text());
        },
      },
      middleware: [
        async ({ request: middlewareRequest }) => {
          calls.push(await middlewareRequest.text());
        },
      ],
    });

    expect(result.ok && result.value.status).toBe(413);
    expect(calls).toEqual([]);
  });

  it("reapplies the body byte cap after middleware replaces the request", async () => {
    let actionCalled = false;
    let laterMiddlewareCalled = false;

    const result = await renderRoute(
      [
        {
          path: "/upload",
          action: () => {
            actionCalled = true;
          },
          render: () => "ok",
        },
      ],
      new Request("https://x.test/upload", { method: "POST", body: "ok" }),
      {
        maxActionBodyBytes: 3,
        middleware: [
          ({ request }) => new Request(request.url, { method: "POST", body: "abcdef" }),
          () => {
            laterMiddlewareCalled = true;
          },
        ],
      },
    );

    expect(result.ok && result.value.status).toBe(413);
    expect(laterMiddlewareCalled).toBe(false);
    expect(actionCalled).toBe(false);
  });

  it("fails closed when middleware returns a consumed request body", async () => {
    const result = await renderRoute(
      [{ path: "/upload", action: () => "ok", render: () => "ok" }],
      new Request("https://x.test/upload", { method: "POST", body: "ok" }),
      {
        maxActionBodyBytes: 3,
        middleware: [
          async ({ request }) => {
            await request.text();
            return request;
          },
        ],
      },
    );

    expect(result.ok && result.value.status).toBe(413);
  });

  it("releases the superseded body branch when middleware returns its request snapshot", async () => {
    let actionBody = "";
    const input = new Request("https://x.test/upload", { method: "POST", body: "payload" });

    const result = await renderRoute(
      [
        {
          path: "/upload",
          action: async ({ request }) => {
            actionBody = await request.text();
          },
          render: () => "ok",
        },
      ],
      input,
      {
        middleware: [({ request }) => request],
      },
    );

    expect(result.ok && result.value.status).toBe(200);
    expect(actionBody).toBe("payload");
    expect(input.bodyUsed).toBe(true);
  });

  it("releases request bodies on terminal size and middleware responses", async () => {
    const oversized = new Request("https://x.test/upload", {
      method: "POST",
      headers: { "content-length": "7" },
      body: "payload",
    });
    const denied = new Request("https://x.test/upload", { method: "POST", body: "payload" });
    const forbidden = new Request("https://x.test/upload", { method: "POST", body: "payload" });
    const { requireUser } = await import("../src/router");

    const oversizedResult = await renderRoute([{ path: "/upload", render: () => "ok" }], oversized, {
      maxActionBodyBytes: 3,
    });
    const deniedResult = await renderRoute([{ path: "/upload", render: () => "ok" }], denied, {
      middleware: [requireUser(() => undefined)],
    });
    const forbiddenResult = await renderRoute([{ path: "/upload", render: () => "ok" }], forbidden, {
      middleware: [() => new Response("forbidden", { status: 403 })],
    });

    expect(oversizedResult.ok && oversizedResult.value.status).toBe(413);
    expect(deniedResult.ok && deniedResult.value.status).toBe(302);
    expect(forbiddenResult.ok && forbiddenResult.value.status).toBe(403);
    expect(oversized.bodyUsed).toBe(true);
    expect(denied.bodyUsed).toBe(true);
    expect(forbidden.bodyUsed).toBe(true);
  });

  it("releases request bodies on method, not-found, and CSRF rejection responses", async () => {
    const methodRejected = new Request("https://x.test/upload", { method: "POST", body: "payload" });
    const notFound = new Request("https://x.test/missing", { method: "POST", body: "payload" });
    const csrfRejected = new Request("https://x.test/upload", { method: "POST", body: "payload" });
    const routes: RouteDefinition[] = [{ path: "/upload", action: () => "ok", render: () => "ok" }];

    const methodResult = await renderRoute(routes, methodRejected, { allowedMethods: ["GET"] });
    const notFoundResult = await renderRoute(routes, notFound);
    const csrfResult = await renderRoute(routes, csrfRejected, { csrf: { verify: () => false } });

    expect(methodResult.ok && methodResult.value.status).toBe(405);
    expect(notFoundResult.ok && notFoundResult.value.status).toBe(404);
    expect(csrfResult.ok && csrfResult.value.status).toBe(403);
    expect(methodRejected.bodyUsed).toBe(true);
    expect(notFound.bodyUsed).toBe(true);
    expect(csrfRejected.bodyUsed).toBe(true);
  });

  it.each([Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY, -1, 1.5])(
    "rejects invalid maxActionBodyBytes configuration %s before request callbacks",
    async (maxActionBodyBytes) => {
      let calls = 0;
      const request = new Request("https://x.test/upload", {
        method: "POST",
        body: "abcdef",
      });

      await expect(
        renderRoute([{ path: "/upload", action: () => new Response("ok"), render: () => "ok" }], request, {
          maxActionBodyBytes,
          middleware: [
            () => {
              calls++;
            },
          ],
        }),
      ).rejects.toThrow("maxActionBodyBytes must be a non-negative finite integer");
      expect(calls).toBe(0);
    },
  );

  it("drops unsafe URL and event-handler attributes from rendered head descriptors", () => {
    expect(
      renderHead({
        links: [
          { rel: "preload", href: "javascript:alert(1)", onload: "alert(1)" },
          { rel: "stylesheet", href: "/app.css" },
        ],
        scripts: [{ src: "javascript:alert(1)", type: "module", onload: "alert(1)" }],
      }),
    ).toBe(`<link rel="stylesheet" href="/app.css"><script type="module"></script>`);
  });

  it("parses cookies and commits in-memory sessions", async () => {
    expect(parseCookies("theme=dark; sid=abc")).toEqual({ theme: "dark", sid: "abc" });
    expect(parseCookies("theme=dark; bad=%E0%A4%A; sid=abc")).toEqual({ theme: "dark", sid: "abc" });
    expect(parseCookies("sid=abc%00def; theme=dark")).toEqual({ theme: "dark" });
    expect(parseCookies("si%1Fd=abc; theme=dark")).toEqual({ theme: "dark" });
    expect(parseCookies("sid=abc\u0000def; theme=dark")).toEqual({ theme: "dark" });
    expect(serializeCookie("sid", "abc", { httpOnly: true, sameSite: "Lax", path: "/" })).toBe(
      "sid=abc; Path=/; HttpOnly; SameSite=Lax",
    );

    const storage = createMemorySessionStorage({ cookieName: "sid" });
    const session = await storage.createSession({ userId: "u1" });
    const cookie = await storage.commitSession(session);
    const restored = await storage.getSession(cookie);

    expect(restored.data).toEqual({ userId: "u1" });
    expect(cookie).toContain("Secure");
  });

  it("stores reserved cookie names as own string values without changing the prototype", () => {
    const cookies = parseCookies("__proto__=proto; constructor=ctor; toString=string");

    expect(Object.getPrototypeOf(cookies)).toBe(Object.prototype);
    expect(Object.hasOwn(cookies, "__proto__")).toBe(true);
    expect(cookies["__proto__"]).toBe("proto");
    expect(cookies.constructor).toBe("ctor");
    expect(cookies.toString).toBe("string");
    expect(typeof parseCookies("theme=dark").toString).toBe("function");
  });

  it("uses getRandomValues when randomUUID is unavailable", async () => {
    const cryptoDescriptor = Object.getOwnPropertyDescriptor(globalThis, "crypto");
    let randomCalls = 0;
    Object.defineProperty(globalThis, "crypto", {
      configurable: true,
      value: {
        getRandomValues: (bytes: Uint8Array) => {
          randomCalls++;
          bytes.fill(7);
          return bytes;
        },
      },
    });
    try {
      const storage = createMemorySessionStorage();
      const session = await storage.createSession({});

      expect(session.id).toBe("BwcHBwcHBwcHBwcHBwcHBw");
      expect(randomCalls).toBe(1);
    } finally {
      if (cryptoDescriptor) {
        Object.defineProperty(globalThis, "crypto", cryptoDescriptor);
      } else {
        Reflect.deleteProperty(globalThis, "crypto");
      }
    }
  });

  it("treats absent reserved session cookie names as missing", async () => {
    const memoryStorage = createMemorySessionStorage({ cookieName: "constructor" });
    const cookieStorage = createCookieSessionStorage({
      cookieName: "constructor",
      secret: sessionSecret,
    });

    await expect(memoryStorage.getSession(null)).resolves.toEqual({ id: "", data: {} });
    await expect(cookieStorage.getSession(null)).resolves.toEqual({ id: "", data: {} });
  });

  it("does not commit authenticated data under an unknown cookie session ID", async () => {
    const storage = createMemorySessionStorage<{ userId?: string }>({
      cookieName: "sid",
      id: () => "rotated-id",
    });
    const untrusted = await storage.getSession("sid=attacker-id");
    untrusted.data.userId = "victim";

    const cookie = await storage.commitSession(untrusted);

    expect(cookie).toContain("sid=rotated-id");
    await expect(storage.getSession("sid=attacker-id")).resolves.toEqual({ id: "attacker-id", data: {} });
    await expect(storage.getSession(cookie)).resolves.toEqual({ id: "rotated-id", data: { userId: "victim" } });
  });

  it("rotates a reconstructed unknown session before committing it", async () => {
    const storage = createMemorySessionStorage<{ userId?: string }>({
      cookieName: "sid",
      id: () => "rotated-id",
    });
    const unknown = await storage.getSession("sid=attacker-id");

    const cookie = await storage.commitSession({ id: unknown.id, data: { userId: "victim" } });

    expect(cookie).toContain("sid=rotated-id");
    await expect(storage.getSession("sid=attacker-id")).resolves.toEqual({ id: "attacker-id", data: {} });
  });

  it("regenerates a known memory session ID for a privilege change", async () => {
    const ids = ["before-login", "after-login"];
    const storage = createMemorySessionStorage<{ userId?: string }>({ cookieName: "sid", id: () => ids.shift() ?? "extra" });
    const beforeLogin = await storage.createSession({});
    const afterLogin = await storage.regenerateSession(beforeLogin);
    afterLogin.data.userId = "victim";

    const cookie = await storage.commitSession(afterLogin);

    await expect(storage.getSession("sid=before-login")).resolves.toEqual({ id: "before-login", data: {} });
    await expect(storage.getSession(cookie)).resolves.toEqual({ id: "after-login", data: { userId: "victim" } });
  });

  it("destroys memory sessions and treats the last duplicate cookie as untrusted", async () => {
    const ids = ["known", "rotated"];
    const storage = createMemorySessionStorage<{ userId?: string }>({ cookieName: "sid", id: () => ids.shift() ?? "extra" });
    const session = await storage.createSession({ userId: "u1" });
    await storage.destroySession(session);
    await expect(storage.getSession("sid=known")).resolves.toEqual({ id: "known", data: {} });

    const duplicate = await storage.getSession("sid=known; sid=attacker-selected");
    duplicate.data.userId = "victim";
    const cookie = await storage.commitSession(duplicate);

    expect(cookie).toContain("sid=rotated");
    await expect(storage.getSession("sid=attacker-selected")).resolves.toEqual({ id: "attacker-selected", data: {} });
  });

  it("rejects cookie path and domain values that can inject attributes or headers", async () => {
    expect(() => serializeCookie("sid", "abc", { path: "/; SameSite=None" })).toThrow("Invalid cookie Path");
    expect(() => serializeCookie("sid", "abc", { path: "/\r\nSet-Cookie: injected=1" })).toThrow("Invalid cookie Path");
    expect(() => serializeCookie("sid", "abc", { domain: "example.test; Secure" })).toThrow("Invalid cookie Domain");
    expect(serializeCookie("sid", "abc", { path: "/", domain: "example.test" })).toBe(
      "sid=abc; Path=/; Domain=example.test",
    );

    const memoryStorage = createMemorySessionStorage({
      cookieName: "sid",
      cookie: { path: "/; SameSite=None" },
      id: () => "s1",
    });
    await expect(memoryStorage.commitSession({ id: "s1", data: {} })).rejects.toThrow("Invalid cookie Path");

    const cookieStorage = createCookieSessionStorage({
      secret: sessionSecret,
      cookieName: "sid",
      cookie: { path: "/", domain: "example.test; Secure" },
      id: () => "s1",
    });
    await expect(cookieStorage.commitSession({ id: "s1", data: {} })).rejects.toThrow("Invalid cookie Domain");
  });

  it("rejects CSP options that can inject directives or source expressions", () => {
    expect(createSecurityHeaders({ csp: true, nonce: "abc123" }).get("content-security-policy")).toContain(
      `script-src 'nonce-abc123' 'strict-dynamic'`,
    );
    expect(() => createSecurityHeaders({ csp: true, nonce: "abc' https://evil.test 'unsafe-inline" })).toThrow(
      "Invalid CSP nonce",
    );
    expect(() => createSecurityHeaders({ csp: true, frameAncestors: "'self'; script-src *" })).toThrow(
      "Invalid CSP frame-ancestors",
    );
    expect(
      createSecurityHeaders({ csp: true, frameAncestors: "'self' https://app.example" }).get("content-security-policy"),
    ).toContain("frame-ancestors 'self' https://app.example");
  });

  it("signs cookie values and rejects tampered session cookies", async () => {
    const signed = signCookieValue("session", "secret");
    expect(verifySignedCookieValue(signed, "secret")).toBe("session");
    expect(verifySignedCookieValue(`${signed}x`, "secret")).toBeUndefined();
    expect(verifySignedCookieValue(`${signed}.extra`, "secret")).toBeUndefined();

    const storage = createCookieSessionStorage<{ userId: string }>({
      secret: sessionSecret,
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

  it("preserves the signing contract without a Node Buffer global", () => {
    const bufferDescriptor = Object.getOwnPropertyDescriptor(globalThis, "Buffer");
    Object.defineProperty(globalThis, "Buffer", { configurable: true, value: undefined });
    try {
      const signed = signCookieValue("hello", "key");

      expect(signed).toBe("aGVsbG8.a-znJOS63WXYo_y1dro-4sxa6aNs1kHDt_ruUVSEy0k");
      expect(verifySignedCookieValue(signed, "key")).toBe("hello");
      expect(verifySignedCookieValue(`${signed}x`, "key")).toBeUndefined();
    } finally {
      if (bufferDescriptor) {
        Object.defineProperty(globalThis, "Buffer", bufferDescriptor);
      } else {
        Reflect.deleteProperty(globalThis, "Buffer");
      }
    }
  });

  it("rejects an expired signed cookie session when it is replayed", async () => {
    let now = 1_000;
    const storage = createCookieSessionStorage<{ userId: string }>({
      secret: sessionSecret,
      cookieName: "sid",
      maxAgeMs: 100,
      now: () => now,
    });
    const cookie = await storage.commitSession({ id: "s1", data: { userId: "u1" } });
    now += 100;

    await expect(storage.getSession(cookie)).resolves.toEqual({ id: "", data: {} });
  });

  it("rejects a legacy signed session without an expiry when expiry is required", async () => {
    const legacy = serializeCookie("sid", signCookieValue(JSON.stringify({ id: "s1", data: { userId: "u1" } }), sessionSecret));
    const storage = createCookieSessionStorage<{ userId: string }>({ secret: sessionSecret, cookieName: "sid", maxAgeMs: 100 });

    await expect(storage.getSession(legacy)).resolves.toEqual({ id: "", data: {} });
  });

  it("validates signed-session secrets and rotates signing keys", async () => {
    expect(() => createCookieSessionStorage({ secret: "weak" })).toThrow("at least 32");
    const oldSecret = "o".repeat(32);
    const newSecret = "n".repeat(32);
    const oldStorage = createCookieSessionStorage<{ userId: string }>({ secret: oldSecret, cookieName: "sid" });
    const oldCookie = await oldStorage.commitSession({ id: "s1", data: { userId: "u1" } });
    const rotated = createCookieSessionStorage<{ userId: string }>({
      secret: newSecret,
      verificationSecrets: [oldSecret],
      cookieName: "sid",
    });

    await expect(rotated.getSession(oldCookie)).resolves.toEqual({ id: "s1", data: { userId: "u1" } });
    const newCookie = await rotated.commitSession({ id: "s1", data: { userId: "u1" } });
    await expect(oldStorage.getSession(newCookie)).resolves.toEqual({ id: "", data: {} });
  });

  it("documents copied-cookie replay after stateless destroy", async () => {
    const storage = createCookieSessionStorage<{ userId: string }>({ secret: sessionSecret, cookieName: "sid" });
    const session = { id: "s1", data: { userId: "u1" } };
    const copiedCookie = await storage.commitSession(session);
    await storage.destroySession(session);

    await expect(storage.getSession(copiedCookie)).resolves.toEqual(session);
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

  it("rejects request replacement after requireUser authorizes an identity", async () => {
    const { requireUser } = await import("../src/router");
    let actionCookie: string | null = null;
    const routes: RouteDefinition[] = [
      {
        path: "/admin",
        action: ({ request }) => {
          actionCookie = request.headers.get("cookie");
          return "saved";
        },
        render: () => "<h1>Admin</h1>",
      },
    ];
    const request = new Request("https://x.test/admin", {
      method: "POST",
      headers: { cookie: "sid=attacker" },
    });

    await expect(
      renderRoute(routes, request, {
        middleware: [
          requireUser(({ request: guardedRequest }) =>
            guardedRequest.headers.get("cookie") === "sid=attacker" ? { id: "attacker" } : undefined,
          ),
          ({ request: authorizedRequest }) =>
            new Request(authorizedRequest, { headers: { cookie: "sid=victim" } }),
        ],
      }),
    ).rejects.toThrow("Middleware cannot replace the request after requireUser has authorized it");
    expect(actionCookie).toBeNull();
  });

  it("rejects request replacement after a wrapped requireUser guard authorizes an identity", async () => {
    const { requireUser } = await import("../src/router");
    const guard = requireUser(({ request }) =>
      request.headers.get("cookie") === "sid=attacker" ? { id: "attacker" } : undefined,
    );
    let actionCookie: string | null = null;
    let wrapperContinued = false;
    const request = new Request("https://x.test/admin", {
      method: "POST",
      headers: { cookie: "sid=attacker" },
    });

    await expect(
      renderRoute(
        [
          {
            path: "/admin",
            action: ({ request: actionRequest }) => {
              actionCookie = actionRequest.headers.get("cookie");
            },
            render: () => "ok",
          },
        ],
        request,
        {
          middleware: [
            async (context) => {
              const result = await guard({ ...context });
              if (result) {
                return result;
              }
              wrapperContinued = true;
            },
            ({ request: authorizedRequest }) =>
              new Request(authorizedRequest, { headers: { cookie: "sid=victim" } }),
          ],
        },
      ),
    ).rejects.toThrow("Middleware cannot replace the request after requireUser has authorized it");
    expect(wrapperContinued).toBe(true);
    expect(actionCookie).toBeNull();
  });

  it("isolates URL mutations made by middleware after authorization", async () => {
    const { requireUser } = await import("../src/router");
    const result = await renderRoute(
      [
        { path: "/tenant-a", render: () => "tenant-a" },
        { path: "/tenant-b", render: () => "tenant-b" },
      ],
      "https://x.test/tenant-a",
      {
        middleware: [
          requireUser(() => ({ id: "user" })),
          ({ url }) => {
            url.pathname = "/tenant-b";
          },
        ],
      },
    );

    expect(result.ok && result.value.html).toBe("tenant-a");
  });

  it("isolates request header mutations made by observational hooks", async () => {
    const { requireUser } = await import("../src/router");
    let actionCookie: string | null = null;
    const request = new Request("https://x.test/admin", {
      method: "POST",
      headers: { cookie: "sid=attacker" },
    });

    const result = await renderRoute(
      [
        {
          path: "/admin",
          action: ({ request: actionRequest }) => {
            actionCookie = actionRequest.headers.get("cookie");
          },
          render: () => "ok",
        },
      ],
      request,
      {
        middleware: [requireUser(() => ({ id: "attacker" }))],
        hooks: {
          onMatch: ({ request: hookRequest }) => {
            hookRequest.headers.set("cookie", "sid=victim");
          },
        },
      },
    );

    expect(result.ok && result.value.status).toBe(200);
    expect(actionCookie).toBe("sid=attacker");
  });
});
