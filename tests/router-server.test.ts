import { afterEach, describe, expect, it, vi } from "vitest";
import { createRouteManifest, matchRoute, renderHead, renderRoute, type RouteDefinition } from "../src/router";

describe("server router", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("matches static, dynamic, nested, and wildcard routes", () => {
    const routes: RouteDefinition[] = [
      { id: "home", path: "/", render: () => "home" },
      {
        id: "app",
        path: "/app",
        render: ({ outlet }) => `<main>${outlet}</main>`,
        children: [{ id: "settings", path: "settings/:tab", render: () => "settings" }],
      },
      { id: "fallback", path: "*", render: () => "fallback" },
    ];

    const nested = matchRoute(routes, "/app/settings/profile");
    expect(nested.ok && nested.value.params).toEqual({ tab: "profile" });
    expect(nested.ok && nested.value.branch.map((entry) => entry.route.id)).toEqual(["app", "settings"]);

    expect(createRouteManifest(routes).map((route) => route.path)).toEqual(["/", "/app", "/app/settings/:tab", "*"]);
    const missing = matchRoute(routes, "/missing");
    expect(missing.ok && missing.value.route.id).toBe("fallback");
  });

  it("reuses compiled route matchers across requests for the same route table", () => {
    const NativeRegExp = RegExp;
    let constructed = 0;
    vi.stubGlobal("RegExp", function RegExpSpy(pattern: string, flags?: string) {
      constructed += 1;
      return new NativeRegExp(pattern, flags);
    } as unknown as RegExpConstructor);
    const routes: RouteDefinition[] = [
      { path: "/users/new", render: () => "new" },
      { path: "/users/:id", render: () => "user" },
      { path: "*", render: () => "fallback" },
    ];

    expect(matchRoute(routes, "/users/1").ok).toBe(true);
    expect(constructed).toBeGreaterThan(0);
    constructed = 0;
    expect(matchRoute(routes, "/users/2").ok).toBe(true);

    expect(constructed).toBe(0);
  });

  it("returns a route error instead of throwing for invalid encoded params", () => {
    const routes: RouteDefinition[] = [{ id: "item", path: "/items/:id", render: () => "" }];

    const result = matchRoute(routes, "/items/%zz");

    expect(result.ok).toBe(false);
    expect(!result.ok && result.error.status).toBe(400);
  });

  it("renders route loaders, nested layouts, head tags, and hydration state", async () => {
    const routes: RouteDefinition[] = [
      {
        id: "app",
        path: "/app",
        head: () => ({ links: [{ rel: "modulepreload", href: "/app.js" }] }),
        render: ({ outlet }) => `<main>${outlet}</main>`,
        children: [
          {
            id: "user",
            path: "users/:id",
            loader: ({ params }) => ({ name: `User ${params.id}` }),
            head: ({ data }) => {
              const user = data as { name: string };
              return { title: user.name, metas: [{ name: "description", content: "profile" }] };
            },
            render: ({ data }) => {
              const user = data as { name: string };
              return `<h1>${user.name}</h1>`;
            },
          },
        ],
      },
    ];

    const result = await renderRoute(routes, "https://example.com/app/users/42");

    expect(result.ok).toBe(true);
    if (!result.ok) {
      throw new Error(result.error.message);
    }
    expect(result.value.status).toBe(200);
    expect(result.value.html).toBe(`<main><h1>User 42</h1></main>`);
    expect(result.value.headHtml).toContain(`<title>User 42</title>`);
    expect(result.value.headHtml).toContain(`<meta name="description" content="profile">`);
    expect(result.value.headHtml).toContain(`<link rel="modulepreload" href="/app.js">`);
    expect(result.value.stateScript).toContain(`data-tachyon-state="route:user"`);
    expect(result.value.loaderData).toEqual({ user: { name: "User 42" } });
  });

  it("serializes undefined loader data as null hydration state", async () => {
    const routes: RouteDefinition[] = [
      {
        id: "optional",
        path: "/optional",
        loader: () => undefined,
        render: () => `<p>optional</p>`,
      },
    ];

    const result = await renderRoute(routes, "https://example.com/optional");

    expect(result.ok).toBe(true);
    if (!result.ok) {
      throw new Error(result.error.message);
    }
    expect(result.value.status).toBe(200);
    expect(result.value.stateScript).toContain(`data-tachyon-state="route:optional"`);
    expect(result.value.stateScript).toContain(`>null</script>`);
  });

  it("runs route actions before rendering loader data", async () => {
    let saved = "";
    const routes: RouteDefinition[] = [
      {
        id: "contact",
        path: "/contact",
        action: async ({ request }) => {
          const form = await request.formData();
          saved = String(form.get("name"));
          return { ok: true };
        },
        loader: () => ({ saved }),
        render: ({ actionResult, data }) => {
          const loaded = data as { saved: string };
          const action = actionResult as { ok: boolean };
          return `<p>${loaded.saved}:${action.ok}</p>`;
        },
      },
    ];
    const body = new URLSearchParams({ name: "Ada" });
    const request = new Request("https://example.com/contact", {
      method: "POST",
      body,
      headers: { "content-type": "application/x-www-form-urlencoded" },
    });

    const result = await renderRoute(routes, request);

    expect(result.ok && result.value.html).toBe(`<p>Ada:true</p>`);
  });

  it("renders configured 404 and error boundaries", async () => {
    const notFound = await renderRoute([], "https://example.com/missing", {
      notFound: ({ url }) => `<h1>Missing ${url.pathname}</h1>`,
    });
    expect(notFound.ok && notFound.value).toMatchObject({ status: 404, html: "<h1>Missing /missing</h1>" });

    const broken = await renderRoute(
      [
        {
          id: "broken",
          path: "/broken",
          loader: () => {
            throw new Error("boom");
          },
          render: () => "never",
        },
      ],
      "https://example.com/broken",
      { error: ({ error }) => `<h1>${error instanceof Error ? error.message : "error"}</h1>` },
    );
    expect(broken.ok && broken.value).toMatchObject({ status: 500, html: "<h1>boom</h1>" });
  });

  it("bubbles errors to the nearest nested route error boundary", async () => {
    const result = await renderRoute(
      [
        {
          id: "app",
          path: "/app",
          error: ({ error }) => `<h1>App ${error instanceof Error ? error.message : "error"}</h1>`,
          render: ({ outlet }) => `<main>${outlet}</main>`,
          children: [
            {
              id: "broken",
              path: "broken",
              loader: () => {
                throw new Error("boom");
              },
              render: () => "never",
            },
          ],
        },
      ],
      "https://example.com/app/broken",
    );

    expect(result.ok && result.value).toMatchObject({ status: 500, html: "<h1>App boom</h1>" });
  });

  it("escapes head descriptors", () => {
    expect(
      renderHead({
        title: `<Admin>`,
        metas: [{ name: "description", content: `"quoted"` }],
        scripts: [{ src: "/app.js", type: "module" }],
      }),
    ).toBe(
      `<title>&lt;Admin&gt;</title><meta name="description" content="&quot;quoted&quot;"><script src="/app.js" type="module"></script>`,
    );
  });
});
