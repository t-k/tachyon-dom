import { describe, expect, it } from "vitest";
import { applyDeferredDataChunk } from "../src/runtime/stream-client";
import { connectRouteHotReloader, createRouteHotReloader } from "../src/runtime/router";
import { enhanceForm, validateFormData } from "../src/runtime/form";

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

  it("includes the clicked submitter in enhanced form data", async () => {
    document.body.innerHTML = `<form action="/save" method="post"><input name="title" value="Hello"><button name="intent" value="publish">Publish</button></form>`;
    const form = document.querySelector("form");
    const button = document.querySelector("button");
    if (!(form instanceof HTMLFormElement) || !(button instanceof HTMLButtonElement)) {
      throw new Error("Missing form.");
    }
    const submitted: string[] = [];
    const cleanup = enhanceForm(form, {
      submit: ({ formData }) => {
        submitted.push(String(formData.get("intent")));
        return new Response("ok");
      },
    });

    form.dispatchEvent(new SubmitEvent("submit", { bubbles: true, cancelable: true, submitter: button }));
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(submitted).toEqual(["publish"]);
    cleanup();
  });

  it("reads action and method attributes when form properties are clobbered", async () => {
    document.body.innerHTML = `<form action="/save" method="post"><input name="action" value="/clobbered"><input name="method" value="get"></form>`;
    const form = document.querySelector("form");
    const actionInput = document.querySelector(`input[name="action"]`);
    const methodInput = document.querySelector(`input[name="method"]`);
    if (
      !(form instanceof HTMLFormElement) ||
      !(actionInput instanceof HTMLInputElement) ||
      !(methodInput instanceof HTMLInputElement)
    ) {
      throw new Error("Missing form.");
    }
    Object.defineProperty(form, "action", { configurable: true, value: actionInput });
    Object.defineProperty(form, "method", { configurable: true, value: methodInput });
    const submitted: string[] = [];
    const cleanup = enhanceForm(form, {
      submit: ({ request }) => {
        submitted.push(`${request.method} ${new URL(request.url).pathname}`);
        return new Response("ok");
      },
    });

    form.dispatchEvent(new SubmitEvent("submit", { bubbles: true, cancelable: true }));
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(submitted).toEqual(["POST /save"]);
    cleanup();
  });

  it("validates form data before enhanced submission and focuses invalid fields", async () => {
    document.body.innerHTML = `<form action="/save" method="post"><input name="email" value="bad"></form>`;
    const form = document.querySelector("form");
    const input = document.querySelector("input");
    if (!(form instanceof HTMLFormElement) || !(input instanceof HTMLInputElement)) {
      throw new Error("Missing form.");
    }
    const events: string[] = [];
    const cleanup = enhanceForm(form, {
      validate: ({ formData }) =>
        validateFormData(formData, {
          email: { pattern: /^[^@]+@[^@]+$/, message: "Enter a valid email." },
        }),
      submit: () => {
        events.push("submit");
        return new Response("ok");
      },
      onInvalid: ({ errors }) => {
        events.push(errors.email ?? "missing");
      },
    });

    form.dispatchEvent(new SubmitEvent("submit", { bubbles: true, cancelable: true }));
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(events).toEqual(["Enter a valid email."]);
    expect(input.validationMessage).toBe("Enter a valid email.");
    expect(document.activeElement).toBe(input);
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

  it("connects route HMR updates from Vite import.meta.hot style APIs", async () => {
    const callbacks = new Map<string, (payload: { routeIds?: string[]; href?: string }) => void>();
    const calls: string[] = [];
    connectRouteHotReloader(
      {
        on: (event, callback) => callbacks.set(event, callback),
        dispose: () => undefined,
      },
      createRouteHotReloader({
        currentPath: () => "/current",
        invalidate: (href) => calls.push(`invalidate:${href}`),
        navigate: async (href) => {
          calls.push(`navigate:${href}`);
        },
      }),
    );

    callbacks.get("tachyon-dom:routes-update")?.({ routeIds: ["home"] });
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(calls).toEqual(["invalidate:/current", "navigate:/current"]);
  });

  it("applies deferred data chunks to matching DOM sinks", () => {
    document.body.innerHTML = `<output data-tachyon-deferred-target="route:post:comments"></output>`;
    const applied = applyDeferredDataChunk(document, {
      id: "route:post",
      key: "comments",
      value: ["A", "B"],
    });

    expect(applied).toBe(true);
    expect(document.querySelector("output")?.textContent).toBe(`["A","B"]`);
  });
});
