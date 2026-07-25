import { describe, expect, it } from "vitest";
import { err, ok } from "../src/result";
import { html } from "../src/server/html";
import { formAction, formField, formState, preserveFormValues, redirectResponse } from "../src/server/form-action";

describe("server form action helpers", () => {
  it("returns a redirect response after a successful submit", async () => {
    const body = new FormData();
    body.set("email", "ada@example.test");
    body.set("password", "secret");
    const action = formAction({
      parse: async (formData) => ok({ email: String(formData.get("email")) }),
      onSuccess: ({ input }) => redirectResponse(`/dashboard?email=${input.email}`),
      onError: () => new Response("unexpected", { status: 400 }),
    });

    const response = await action(new Request("https://app.test/login", { method: "POST", body }));

    expect(response.status).toBe(303);
    expect(response.headers.get("location")).toBe("/dashboard?email=ada@example.test");
  });

  it("preserves safe values and renders accessible field errors without preserving passwords", async () => {
    const body = new FormData();
    body.set("email", "not-an-email");
    body.set("password", "secret");
    body.set("returnTo", "/settings");
    const action = formAction({
      parse: async (formData) =>
        err(
          formState({
            values: preserveFormValues(formData),
            fieldErrors: { email: "Enter a valid email address." },
            formError: "Sign in could not continue.",
          }),
        ),
      onSuccess: () => redirectResponse("/dashboard"),
      onError: ({ error }) => {
        const email = formField(error, "email", { id: "login-email" });
        const returnTo = formField(error, "returnTo", { id: "login-return-to" });
        return new Response(
          String(html`<form>
            <input${email.inputAttrs()}>
            ${email.error()}
            <input type="hidden"${returnTo.inputAttrs()}>
            <p role="alert">${error.formError}</p>
          </form>`),
          { status: 422 },
        );
      },
    });

    const response = await action(new Request("https://app.test/login", { method: "POST", body }));
    const text = await response.text();

    expect(response.status).toBe(422);
    expect(text).toContain(
      `<input name="email" id="login-email" value="not-an-email" aria-invalid="true" aria-describedby="login-email-error">`,
    );
    expect(text).toContain(`<p id="login-email-error" role="alert">Enter a valid email address.</p>`);
    expect(text).toContain(`<input type="hidden" name="returnTo" id="login-return-to" value="/settings">`);
    expect(text).not.toContain("secret");
    expect(text).toContain(`<p role="alert">Sign in could not continue.</p>`);
  });

  it("supports repeated field values and custom sensitive field names", () => {
    const body = new FormData();
    body.append("tag", "one");
    body.append("tag", "two");
    body.set("token", "hidden");

    expect(preserveFormValues(body, { sensitiveNames: ["token"] })).toEqual({ tag: ["one", "two"] });
  });

  it("preserves dangerous field names without changing the result prototype", () => {
    const body = new FormData();
    body.append("__proto__", "first");
    body.append("__proto__", "second");
    body.append("constructor", "constructor-value");
    body.append("prototype", "prototype-value");

    const values = preserveFormValues(body);

    expect(Object.getPrototypeOf(values)).toBe(Object.prototype);
    expect(Object.hasOwn(values, "__proto__")).toBe(true);
    expect(values["__proto__"]).toEqual(["first", "second"]);
    expect(values.constructor).toBe("constructor-value");
    expect(values.prototype).toBe("prototype-value");
  });

  it("rejects unsafe redirect targets by default", () => {
    expect(() => redirectResponse("//evil.test/path")).toThrow("Unsafe redirect target");
    expect(() => redirectResponse("/%5C%5Cevil.test/path")).toThrow("Unsafe redirect target");
    expect(() => redirectResponse("/\t/evil.test/path")).toThrow("Unsafe redirect target");
    expect(() => redirectResponse("/\r/evil.test/path")).toThrow("Unsafe redirect target");
    expect(() => redirectResponse("/%09/evil.test/path")).toThrow("Unsafe redirect target");
    expect(() => redirectResponse("https://evil.test/path", { allowExternal: true })).toThrow("Unsafe redirect target");

    const response = redirectResponse("https://accounts.example/callback", {
      allowExternal: true,
      allowedOrigins: ["https://accounts.example"],
    });

    expect(response.status).toBe(303);
    expect(response.headers.get("location")).toBe("https://accounts.example/callback");
  });
});
