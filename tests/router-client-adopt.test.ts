import { afterEach, describe, expect, it, vi } from "vitest";
import { createClientRouter, rawHtml, type ClientRouteDefinition } from "../src/runtime/router";

const setup = (path: string) => {
  window.history.replaceState({}, "", path);
  document.body.innerHTML = `<main id="app"><h1 id="server">Server home</h1></main>`;
  const root = document.querySelector("#app");
  if (!(root instanceof HTMLElement)) throw new Error("Missing app root.");
  const renders: string[] = [];
  const routes: ClientRouteDefinition[] = [
    {
      path: "/",
      render: () => {
        renders.push("/");
        return rawHtml(`<h1 id="client">Client home</h1>`);
      },
    },
    {
      path: "/about/",
      render: () => {
        renders.push("/about/");
        return rawHtml(`<h1>About</h1>`);
      },
    },
  ];
  return { root, renders, routes };
};

describe("client router adopting the server-rendered route on start", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("keeps the current document untouched on start and only renders on the next navigation", async () => {
    const { root, renders, routes } = setup("/");
    const server = root.querySelector("#server");
    const disposed: string[] = [];
    const router = createClientRouter({ root, routes, adopt: () => disposed.push("adopted view") });

    await router.start();

    expect(renders).toEqual([]);
    expect(root.querySelector("#server")).toBe(server);
    expect(disposed).toEqual([]);
    expect(location.pathname).toBe("/");
    // The adopted entry gets the same scroll key a rendered entry would, so a later back navigation restores it.
    expect(typeof (history.state as { __tachyonScrollKey?: unknown }).__tachyonScrollKey).toBe("number");

    await router.navigate("/about/");

    expect(renders).toEqual(["/about/"]);
    expect(root.innerHTML).toBe(`<h1>About</h1>`);
    expect(disposed).toEqual(["adopted view"]);

    await router.navigate("/");

    expect(renders).toEqual(["/about/", "/"]);
    expect(root.innerHTML).toBe(`<h1 id="client">Client home</h1>`);
    expect(disposed).toEqual(["adopted view"]);
    router.dispose();
  });

  it("accepts a plain true and disposes the adopted view when the router is disposed", async () => {
    const { root, renders, routes } = setup("/");
    const router = createClientRouter({ root, routes, adopt: true });

    await router.start();
    router.dispose();

    expect(renders).toEqual([]);
    expect(root.innerHTML).toBe(`<h1 id="server">Server home</h1>`);

    const disposed: string[] = [];
    const second = createClientRouter({ root, routes, adopt: () => disposed.push("second") });
    await second.start();
    second.dispose();
    expect(disposed).toEqual(["second"]);
  });

  it("renders on start when adopt is not requested", async () => {
    const { root, renders, routes } = setup("/");
    const router = createClientRouter({ root, routes });

    await router.start();

    expect(renders).toEqual(["/"]);
    expect(root.innerHTML).toBe(`<h1 id="client">Client home</h1>`);
    expect(typeof (history.state as { __tachyonScrollKey?: unknown }).__tachyonScrollKey).toBe("number");
    router.dispose();
  });

  it("adopts whatever the server rendered even when no client route matches the current URL", async () => {
    const { root, renders, routes } = setup("/missing/");
    const router = createClientRouter({ root, routes, adopt: true });

    await router.start();

    expect(renders).toEqual([]);
    expect(root.innerHTML).toBe(`<h1 id="server">Server home</h1>`);

    await router.navigate("/about/");
    expect(root.innerHTML).toBe(`<h1>About</h1>`);
    router.dispose();
  });
});
