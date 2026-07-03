import { describe, expect, it, vi } from "vitest";
import {
  createRuntimeApiExample,
  mountClientRouterExample,
  mountErrorBoundaryExample,
  mountResourceStatusExample,
  restoreCurrentScrollExample,
} from "../examples/runtime-apis";

describe("runtime API examples", () => {
  it("demonstrates resource, error recovery, and i18n APIs", async () => {
    const example = createRuntimeApiExample();

    await expect(example.user.refetch()).resolves.toEqual({ id: "42", name: "User 42" });
    expect(example.user.data()).toEqual({ id: "42", name: "User 42" });
    expect(example.i18n.t("ja", "greeting", { name: "太郎" })).toBe("こんにちは太郎");
    const redirect = example.requireLocale({
      request: new Request("https://example.com/", { headers: { "accept-language": "ja,en;q=0.8" } }),
      url: new URL("https://example.com/"),
      env: {},
    });
    expect(redirect).toBeInstanceOf(Response);
    expect((redirect as Response).headers.get("location")).toBe("/ja");

    example.disposeErrorHandler();
  });

  it("demonstrates error boundaries and resource status rendering", async () => {
    const boundaryRoot = document.createElement("div");
    const disposeBoundary = mountErrorBoundaryExample(boundaryRoot);
    expect(boundaryRoot.textContent).toBe("Ready");
    disposeBoundary();

    const statusRoot = document.createElement("div");
    const disposeStatus = mountResourceStatusExample(statusRoot);
    expect(statusRoot.textContent).toBe("Loading");
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(statusRoot.textContent).toBe("User 42");
    disposeStatus();
  });

  it("demonstrates client router view transitions and scroll restoration options", async () => {
    const root = document.createElement("main");
    const router = mountClientRouterExample(root);
    expect(router.navigate).toBeTypeOf("function");
    router.dispose();

    const navigate = vi.fn<ScrollRestoringNavigate>().mockResolvedValue(undefined);
    await restoreCurrentScrollExample({ navigate });
    expect(navigate).toHaveBeenCalledWith(expect.any(String), { replace: true, restoreScroll: true });
  });
});

type ScrollRestoringNavigate = (
  href: string,
  options?: { replace?: boolean; restoreScroll?: boolean },
) => Promise<void>;
