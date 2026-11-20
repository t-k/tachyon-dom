import { expect, it, vi } from "vitest";
import { createClientRouter, rawHtml, type ClientRouteDefinition } from "../src/runtime/router";
import { matchRoute, type RouteDefinition } from "../src/router";

const fixtures = {
  tie: ["/teams/123", "team:123"],
  generic: ["/acme/portal/detail", "portal:acme"],
  nested: ["/parent/sub+folder/123", "nested:123"],
  encoded: ["/encoded%20name/a%2Fb/", "encoded:a/b"],
  wildcard: ["/missing", "fallback-last:"],
  missing: ["/missing", "missing"],
} as const;

it.each([
  ["indexed", "tie", "absent"],
  ["indexed", "generic", "duplicate"],
  ["indexed", "nested", "absent"],
  ["indexed", "encoded", "duplicate"],
  ["indexed", "wildcard", "duplicate"],
  ["indexed", "missing", "absent"],
  ["small", "tie", "absent"],
  ["generic", "missing", "absent"],
  ["generic", "tie", "duplicate"],
  ["generic", "encoded", "absent"],
  ["small", "generic", "absent"],
  ["small", "wildcard", "duplicate"],
  ["small", "nested", "duplicate"],
  ["generic", "nested", "duplicate"],
  ["generic", "wildcard", "duplicate"],
  ["generic", "generic", "absent"],
  ["small", "missing", "absent"],
  ["small", "encoded", "absent"],
] as const)("preserves ranked matches in a %s table (%s, %s global)", async (table, outcome, global) => {
  const entry = (id: string, path: string) => ({
    id, path,
    render: ({ params }: { params: Record<string, string> }) => id + ":" + Object.values(params).join(","),
  });
  const shared = [
    entry("team", "/teams/:id"),
    entry("tie-loser", "/teams/:name"),
    entry("weaker", "/acme/:name/*rest"),
    entry("portal", "/:tenant/portal/detail"),
    { ...entry("parent", "/parent"), children: [entry("nested", "sub+folder/:id")] },
    entry("encoded", "/encoded%20name/:value"),
  ];
  const filler = Array.from({ length: table === "small" ? 0 : 64 }, (_, index) =>
    entry("filler", table === "indexed" ? `/category-${index}/detail/item` : `/:anything/unused-${index}`),
  );
  const fallbacks = global === "absent" ? [] : [entry("fallback-first", "*"), entry("fallback-last", "*")];
  const routes = [...shared, ...filler, ...fallbacks];
  const [href, expected] = fixtures[outcome];
  const serverMatch = matchRoute(routes satisfies RouteDefinition[], href);
  expect(serverMatch.ok ? serverMatch.value.route.id + ":" + Object.values(serverMatch.value.params).join(",") : "missing")
    .toBe(expected);
  if (outcome === "nested" && serverMatch.ok) {
    expect(serverMatch.value.branch.map(({ route }) => route.id)).toEqual(["parent", "nested"]);
  }
  const root = document.createElement("main");
  document.body.append(root);
  const router = createClientRouter({
    root,
    routes: routes.map((route): ClientRouteDefinition => route.id === "parent"
      ? { ...route, render: () => rawHtml("<section><div data-tachyon-outlet></div></section>") }
      : route),
    notFound: () => "missing",
    scrollTo: () => undefined,
  });
  try {
    await router.navigate(href);
    expect(root.textContent).toBe(expected);
  } finally {
    router.dispose();
    root.remove();
    history.replaceState(null, "", "/");
  }
});

it("skips unrelated multi-segment patterns in large route tables", () => {
  const routes = Array.from({ length: 64 }, (_, index) => ({
    id: String(index), path: `/category-${index}/detail`, render: () => "",
  }));
  matchRoute(routes, "/warmup");
  const exec = vi.spyOn(RegExp.prototype, "exec");
  try {
    const matched = matchRoute(routes, "/category-63/detail");
    expect(matched.ok && matched.value.route.id).toBe("63");
    const checked = exec.mock.contexts.filter((regex) => regex instanceof RegExp && regex.source.includes("category-"));
    expect(checked).toHaveLength(2);
    exec.mockClear();
    const first = matchRoute(routes, "/category-0/detail");
    expect(first.ok && first.value.route.id).toBe("0");
    expect(exec.mock.contexts.filter((regex) => regex instanceof RegExp && regex.source.includes("category-")))
      .toHaveLength(1);
  } finally {
    exec.mockRestore();
  }
});
