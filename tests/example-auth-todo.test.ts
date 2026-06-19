import { existsSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { mountAuthTodoExample } from "../examples/auth-todo/main";

const rootForTest = (): HTMLElement => {
  document.body.innerHTML = `<main id="app"></main>`;
  const app = document.querySelector("#app");
  if (!(app instanceof HTMLElement)) {
    throw new Error("Missing app root.");
  }
  localStorage.clear();
  return app;
};

const submit = (form: HTMLFormElement): void => {
  form.dispatchEvent(new SubmitEvent("submit", { bubbles: true, cancelable: true }));
};

const flushAsyncForm = async (): Promise<void> => {
  await new Promise((resolve) => setTimeout(resolve, 0));
};

const signIn = async (app: HTMLElement, email: string): Promise<void> => {
  app.querySelector<HTMLInputElement>('[name="email"]')!.value = email;
  app.querySelector<HTMLInputElement>('[name="passphrase"]')!.value = "correct horse";
  submit(app.querySelector<HTMLFormElement>('[data-testid="auth-form"]')!);
  await flushAsyncForm();
};

const addTodo = async (app: HTMLElement, title: string): Promise<void> => {
  app.querySelector<HTMLInputElement>('[name="title"]')!.value = title;
  submit(app.querySelector<HTMLFormElement>('[data-testid="todo-form"]')!);
  await flushAsyncForm();
};

describe("authenticated todo example", () => {
  it("uses template files without a hand-written index file", () => {
    const root = join(process.cwd(), "examples", "auth-todo");

    expect(existsSync(join(root, "auth-view.td"))).toBe(true);
    expect(existsSync(join(root, "shell.td"))).toBe(true);
    expect(existsSync(join(root, "todo-view.td"))).toBe(true);
    expect(existsSync(join(root, "index.html"))).toBe(false);
  });

  it("keeps todo controls unavailable until the user signs in", async () => {
    const app = rootForTest();

    mountAuthTodoExample(app);

    expect(app.querySelector('[data-testid="todo-form"]')).toBeNull();
    expect(app.querySelector('[data-testid="auth-title"]')?.textContent).toBe("Sign in");

    app.querySelector<HTMLInputElement>('[name="email"]')!.value = "invalid";
    app.querySelector<HTMLInputElement>('[name="passphrase"]')!.value = "short";
    submit(app.querySelector<HTMLFormElement>('[data-testid="auth-form"]')!);
    await flushAsyncForm();

    expect(app.querySelector('[data-testid="auth-status"]')?.textContent).toBe("Enter a valid email address.");
    expect(localStorage.getItem("tachyon-auth-todo:session")).toBeNull();
    expect(app.querySelector('[data-testid="todo-form"]')).toBeNull();
  });

  it("stores todos under the signed-in user and restores them after remount", async () => {
    const app = rootForTest();

    mountAuthTodoExample(app);
    await signIn(app, "owner@example.com");
    await addTodo(app, "Ship authenticated example");

    expect(app.querySelector('[data-testid="session-email"]')?.textContent).toBe("owner@example.com");
    expect(app.querySelector('[data-testid="todo-count"]')?.textContent).toBe("1 open");
    expect(app.querySelector('[data-testid="todo-list"]')?.textContent).toContain("Ship authenticated example");

    app.querySelector<HTMLButtonElement>('[data-testid="toggle-todo"]')?.click();
    expect(app.querySelector('[data-testid="todo-count"]')?.textContent).toBe("0 open");

    mountAuthTodoExample(app);

    expect(app.querySelector('[data-testid="session-email"]')?.textContent).toBe("owner@example.com");
    expect(app.querySelector('[data-testid="todo-list"]')?.textContent).toContain("Ship authenticated example");
    expect(app.querySelector('[data-testid="todo-count"]')?.textContent).toBe("0 open");
  });

  it("isolates todo data between signed-in users", async () => {
    const app = rootForTest();

    mountAuthTodoExample(app);
    await signIn(app, "first@example.com");
    await addTodo(app, "First account item");
    app.querySelector<HTMLButtonElement>('[data-testid="sign-out"]')?.click();

    await signIn(app, "second@example.com");
    expect(app.querySelector('[data-testid="todo-empty"]')?.textContent).toBe("No todos yet.");
    await addTodo(app, "Second account item");
    app.querySelector<HTMLButtonElement>('[data-testid="sign-out"]')?.click();

    await signIn(app, "first@example.com");

    expect(app.querySelector('[data-testid="todo-list"]')?.textContent).toContain("First account item");
    expect(app.querySelector('[data-testid="todo-list"]')?.textContent).not.toContain("Second account item");
  });
});
