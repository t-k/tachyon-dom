import { describe, expect, it } from "vitest";
import {
  applyDeferredDataChunk,
  readDeferredDataScript,
  readDeferredDataScriptResult,
} from "../src/runtime/stream-client";
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

  it("accepts only the first valid submission while pending and restores disabled states", async () => {
    document.body.innerHTML = `<form action="/save" method="post"><button id="enabled">Save</button><button id="disabled" disabled>Unavailable</button></form>`;
    const form = document.querySelector("form");
    const enabled = document.querySelector("#enabled");
    const disabled = document.querySelector("#disabled");
    if (
      !(form instanceof HTMLFormElement) ||
      !(enabled instanceof HTMLButtonElement) ||
      !(disabled instanceof HTMLButtonElement)
    ) {
      throw new Error("Missing form controls.");
    }
    let resolveSubmission: ((response: Response) => void) | undefined;
    let submitCalls = 0;
    let successCalls = 0;
    const cleanup = enhanceForm(form, {
      submit: () => {
        submitCalls++;
        return new Promise<Response>((resolve) => {
          resolveSubmission = resolve;
        });
      },
      onSuccess: () => {
        successCalls++;
      },
    });

    form.dispatchEvent(new SubmitEvent("submit", { bubbles: true, cancelable: true, submitter: enabled }));
    form.dispatchEvent(new SubmitEvent("submit", { bubbles: true, cancelable: true, submitter: enabled }));
    await Promise.resolve();

    expect(submitCalls).toBe(1);
    expect(enabled.disabled).toBe(true);
    expect(disabled.disabled).toBe(true);

    resolveSubmission?.(new Response("ok"));
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(successCalls).toBe(1);
    expect(enabled.disabled).toBe(false);
    expect(disabled.disabled).toBe(true);
    cleanup();
  });

  it("unlocks after custom validation rejects a submission", async () => {
    document.body.innerHTML = `<form action="/save" method="post"><button>Save</button></form>`;
    const form = document.querySelector("form");
    if (!(form instanceof HTMLFormElement)) throw new Error("Missing form.");
    let validations = 0;
    let submits = 0;
    const cleanup = enhanceForm(form, {
      validate: () => (++validations === 1 ? { ok: false, errors: {} } : { ok: true, values: {} }),
      submit: () => {
        submits++;
        return new Response("ok");
      },
    });

    form.dispatchEvent(new SubmitEvent("submit", { bubbles: true, cancelable: true }));
    await new Promise((resolve) => setTimeout(resolve, 0));
    form.dispatchEvent(new SubmitEvent("submit", { bubbles: true, cancelable: true }));
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(validations).toBe(2);
    expect(submits).toBe(1);
    cleanup();
  });

  it("ignores a pending completion after enhancement cleanup", async () => {
    document.body.innerHTML = `<form action="/save" method="post"><button>Save</button></form>`;
    const form = document.querySelector("form");
    const button = document.querySelector("button");
    if (!(form instanceof HTMLFormElement) || !(button instanceof HTMLButtonElement)) {
      throw new Error("Missing form.");
    }
    let resolveSubmission: ((response: Response) => void) | undefined;
    let successes = 0;
    const cleanup = enhanceForm(form, {
      submit: () =>
        new Promise<Response>((resolve) => {
          resolveSubmission = resolve;
        }),
      onSuccess: () => {
        successes++;
      },
    });

    form.dispatchEvent(new SubmitEvent("submit", { bubbles: true, cancelable: true }));
    await Promise.resolve();
    expect(button.disabled).toBe(true);
    cleanup();
    expect(button.disabled).toBe(false);
    resolveSubmission?.(new Response("ok"));
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(successes).toBe(0);
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

  it("returns dangerous form field names as own values without changing the prototype", () => {
    const formData = new FormData();
    formData.append("__proto__", "first");
    formData.append("__proto__", "second");
    formData.append("constructor", "constructor-value");

    const result = validateFormData(formData, {});

    expect(result.ok).toBe(true);
    if (!result.ok) {
      throw new Error("Expected valid form data.");
    }
    expect(Object.getPrototypeOf(result.values)).toBe(Object.prototype);
    expect(Object.hasOwn(result.values, "__proto__")).toBe(true);
    expect(result.values["__proto__"]).toEqual(["first", "second"]);
    expect(result.values.constructor).toBe("constructor-value");
  });

  it("records validation errors for dangerous rule names", () => {
    const rules = Object.create(null) as Record<string, { required: boolean; message: string }>;
    Object.defineProperty(rules, "__proto__", {
      enumerable: true,
      value: { required: true, message: "Prototype is required." },
    });
    Object.defineProperty(rules, "constructor", {
      enumerable: true,
      value: { required: true, message: "Constructor is required." },
    });

    const result = validateFormData(new FormData(), rules);

    expect(result.ok).toBe(false);
    if (result.ok) {
      throw new Error("Expected invalid form data.");
    }
    expect(Object.getPrototypeOf(result.errors)).toBe(Object.prototype);
    expect(Object.hasOwn(result.errors, "__proto__")).toBe(true);
    expect(result.errors["__proto__"]).toBe("Prototype is required.");
    expect(result.errors.constructor).toBe("Constructor is required.");
  });

  it.each([/^ok$/g, /^ok$/y])("validates stateful pattern %s deterministically", (pattern) => {
    const formData = new FormData();
    formData.set("value", "ok");
    pattern.lastIndex = 2;
    const initialLastIndex = pattern.lastIndex;

    expect(validateFormData(formData, { value: { pattern } }).ok).toBe(true);
    expect(validateFormData(formData, { value: { pattern } }).ok).toBe(true);
    expect(pattern.lastIndex).toBe(initialLastIndex);
  });

  it("accepts a frozen non-stateful pattern", () => {
    const formData = new FormData();
    formData.set("value", "ok");
    const pattern = Object.freeze(/^ok$/);

    expect(validateFormData(formData, { value: { pattern } }).ok).toBe(true);
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

  it("distinguishes missing and invalid deferred data without throwing", () => {
    document.body.innerHTML = `<script type="application/json" data-tachyon-deferred="broken">{</script>`;

    expect(readDeferredDataScriptResult(document, "missing")).toEqual({
      ok: false,
      error: { kind: "missing", id: "missing" },
    });
    expect(readDeferredDataScriptResult(document, "broken")).toMatchObject({
      ok: false,
      error: { kind: "invalid", id: "broken" },
    });
    expect(() => readDeferredDataScript(document, "broken")).not.toThrow();
    expect(readDeferredDataScript(document, "broken")).toBeUndefined();
  });

  it("reads valid null and selector-special deferred data identifiers", () => {
    document.body.innerHTML = `<script type="application/json" data-tachyon-deferred='route:&quot;quoted&quot;'>null</script>`;
    expect(readDeferredDataScriptResult(document, `route:"quoted"`)).toEqual({ ok: true, value: null });
    expect(readDeferredDataScript(document, `route:"quoted"`)).toBeNull();
  });
});
