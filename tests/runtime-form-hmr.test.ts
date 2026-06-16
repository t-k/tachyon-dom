import { describe, expect, it } from "vitest";
import { createRouteHotReloader } from "../src/runtime/router";
import { enhanceForm } from "../src/runtime/form";

describe("runtime form and HMR helpers", () => {
  it("enhances forms with fetch while preserving normal form markup", async () => {
    document.body.innerHTML = `<form action="/save" method="post"><input name="title" value="Hello"></form>`;
    const form = document.querySelector("form");
    if (!(form instanceof HTMLFormElement)) {
      throw new Error("Missing form.");
    }
    const submitted: string[] = [];
    const cleanup = enhanceForm(form, {
      submit: async ({ request }) => {
        submitted.push(`${request.method} ${new URL(request.url).pathname}`);
        return new Response("ok");
      },
      onSuccess: async ({ response }) => {
        submitted.push(await response.text());
      },
    });

    form.dispatchEvent(new SubmitEvent("submit", { bubbles: true, cancelable: true }));
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(submitted).toEqual(["POST /save", "ok"]);
    cleanup();
  });

  it("invalidates cached routes and re-navigates the current page on HMR updates", async () => {
    const calls: string[] = [];
    const reloader = createRouteHotReloader({
      currentPath: () => "/users/1",
      invalidate: (href) => calls.push(`invalidate:${href}`),
      navigate: async (href, options) => {
        calls.push(`navigate:${href}:${options?.replace ? "replace" : "push"}`);
      },
    });

    await reloader.accept({ routeIds: ["user"] });

    expect(calls).toEqual(["invalidate:/users/1", "navigate:/users/1:replace"]);
  });
});
