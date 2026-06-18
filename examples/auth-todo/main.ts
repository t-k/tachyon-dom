import "./styles.css";
import { enhanceForm, validateFormData } from "../../src/runtime/form";
import { err, ok, type Result } from "../../src/result";

type Session = {
  email: string;
  userId: string;
};

type Todo = {
  id: string;
  title: string;
  completed: boolean;
  createdAt: number;
};

type AuthTodoState = {
  session: Session | undefined;
  todos: Todo[];
  status: string;
};

type AuthTodoError = {
  message: string;
};

type MessageKey =
  | "appTitle"
  | "appSummary"
  | "emailLabel"
  | "emailHint"
  | "passphraseLabel"
  | "passphraseHint"
  | "signIn"
  | "signOut"
  | "invalidEmail"
  | "invalidPassphrase"
  | "signedIn"
  | "signedOut"
  | "todoTitle"
  | "todoPlaceholder"
  | "addTodo"
  | "emptyTodos"
  | "openCountOne"
  | "openCountMany"
  | "markComplete"
  | "markOpen"
  | "deleteTodo"
  | "todoRequired"
  | "todoAdded"
  | "todoDeleted"
  | "localOnlyNotice"
  | "newTodoLabel";

const messages: Record<"en", Record<MessageKey, string>> = {
  en: {
    addTodo: "Add todo",
    appSummary: "A browser-only example with an auth gate, user-scoped persistence, and accessible forms.",
    appTitle: "Authenticated Todo",
    deleteTodo: "Delete",
    emailHint: "Use any email address for this local demo.",
    emailLabel: "Email",
    emptyTodos: "No todos yet.",
    invalidEmail: "Enter a valid email address.",
    invalidPassphrase: "Use at least 8 characters.",
    localOnlyNotice: "Demo credentials are validated locally. The passphrase is never stored.",
    markComplete: "Complete",
    markOpen: "Reopen",
    newTodoLabel: "New todo",
    openCountMany: "{count} open",
    openCountOne: "1 open",
    passphraseHint: "Minimum 8 characters.",
    passphraseLabel: "Passphrase",
    signIn: "Sign in",
    signOut: "Sign out",
    signedIn: "Signed in.",
    signedOut: "Signed out.",
    todoAdded: "Todo added.",
    todoDeleted: "Todo deleted.",
    todoPlaceholder: "Write the next task",
    todoRequired: "Enter a todo title.",
    todoTitle: "Todos",
  },
};

const t = (key: MessageKey, values: Record<string, string | number> = {}): string =>
  Object.entries(values).reduce((text, [name, value]) => text.replaceAll(`{${name}}`, String(value)), messages.en[key]);

const sessionStorageKey = "tachyon-auth-todo:session";
const todoStoragePrefix = "tachyon-auth-todo:todos:";

const emailPattern = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

const escapeHtml = (value: string): string =>
  value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");

const storageResult = <T>(read: () => T): Result<T, AuthTodoError> => {
  try {
    return ok(read());
  } catch (error) {
    return err({ message: error instanceof Error ? error.message : "Storage unavailable." });
  }
};

const normalizeEmail = (email: string): string => email.trim().toLowerCase();

const userIdForEmail = (email: string): string => normalizeEmail(email).replaceAll(/[^a-z0-9._-]/g, "-");

const readSession = (): Result<Session | undefined, AuthTodoError> =>
  storageResult(() => {
    const raw = localStorage.getItem(sessionStorageKey);
    if (!raw) {
      return undefined;
    }
    const parsed = JSON.parse(raw) as Partial<Session>;
    if (typeof parsed.email !== "string" || typeof parsed.userId !== "string") {
      return undefined;
    }
    return { email: parsed.email, userId: parsed.userId };
  });

const writeSession = (session: Session | undefined): Result<void, AuthTodoError> =>
  storageResult(() => {
    if (!session) {
      localStorage.removeItem(sessionStorageKey);
      return;
    }
    localStorage.setItem(sessionStorageKey, JSON.stringify(session));
  });

const todoStorageKey = (session: Session): string => `${todoStoragePrefix}${session.userId}`;

const readTodos = (session: Session | undefined): Result<Todo[], AuthTodoError> =>
  storageResult(() => {
    if (!session) {
      return [];
    }
    const raw = localStorage.getItem(todoStorageKey(session));
    if (!raw) {
      return [];
    }
    const parsed = JSON.parse(raw) as Array<Partial<Todo>>;
    if (!Array.isArray(parsed)) {
      return [];
    }
    return parsed.flatMap((todo) =>
      typeof todo.id === "string" &&
      typeof todo.title === "string" &&
      typeof todo.completed === "boolean" &&
      typeof todo.createdAt === "number"
        ? [{ id: todo.id, title: todo.title, completed: todo.completed, createdAt: todo.createdAt }]
        : [],
    );
  });

const writeTodos = (session: Session | undefined, todos: Todo[]): Result<void, AuthTodoError> =>
  storageResult(() => {
    if (!session) {
      return;
    }
    localStorage.setItem(todoStorageKey(session), JSON.stringify(todos));
  });

const signIn = (email: string, passphrase: string): Result<Session, AuthTodoError> => {
  const normalizedEmail = normalizeEmail(email);
  if (!emailPattern.test(normalizedEmail)) {
    return err({ message: t("invalidEmail") });
  }
  if (passphrase.length < 8) {
    return err({ message: t("invalidPassphrase") });
  }
  return ok({ email: normalizedEmail, userId: userIdForEmail(normalizedEmail) });
};

const createTodo = (title: string, now = Date.now()): Result<Todo, AuthTodoError> => {
  const trimmed = title.trim();
  if (trimmed.length === 0) {
    return err({ message: t("todoRequired") });
  }
  return ok({
    completed: false,
    createdAt: now,
    id: `${now}-${Math.random().toString(16).slice(2)}`,
    title: trimmed,
  });
};

const renderAuthForm = (state: AuthTodoState): string => `
  <section class="auth-panel" aria-labelledby="auth-title">
    <div>
      <h2 id="auth-title" data-testid="auth-title">${t("signIn")}</h2>
      <p>${t("localOnlyNotice")}</p>
    </div>
    <form data-testid="auth-form" novalidate>
      <div class="field">
        <label for="auth-email">${t("emailLabel")}</label>
        <span id="auth-email-hint">${t("emailHint")}</span>
        <input id="auth-email" name="email" type="email" autocomplete="email" aria-describedby="auth-email-hint" required />
      </div>
      <div class="field">
        <label for="auth-passphrase">${t("passphraseLabel")}</label>
        <span id="auth-passphrase-hint">${t("passphraseHint")}</span>
        <input
          id="auth-passphrase"
          name="passphrase"
          type="password"
          autocomplete="current-password"
          aria-describedby="auth-passphrase-hint"
          minlength="8"
          required
        />
      </div>
      <button type="submit">${t("signIn")}</button>
    </form>
    <p class="status" data-testid="auth-status" aria-live="polite">${escapeHtml(state.status)}</p>
  </section>
`;

const openTodoText = (todos: readonly Todo[]): string => {
  const openCount = todos.filter((todo) => !todo.completed).length;
  return openCount === 1 ? t("openCountOne") : t("openCountMany", { count: openCount });
};

const renderTodoList = (todos: readonly Todo[]): string => {
  if (todos.length === 0) {
    return `<p class="empty" data-testid="todo-empty">${t("emptyTodos")}</p>`;
  }
  return `
    <ul class="todo-list" data-testid="todo-list" role="list">
      ${todos
        .map(
          (todo) => `
            <li class="todo-item${todo.completed ? " completed" : ""}">
              <span>${escapeHtml(todo.title)}</span>
              <div class="todo-actions">
                <button type="button" class="secondary" data-action="toggle" data-id="${escapeHtml(todo.id)}" data-testid="toggle-todo">
                  ${todo.completed ? t("markOpen") : t("markComplete")}
                </button>
                <button type="button" class="danger" data-action="delete" data-id="${escapeHtml(todo.id)}">
                  ${t("deleteTodo")}
                </button>
              </div>
            </li>
          `,
        )
        .join("")}
    </ul>
  `;
};

const renderTodoApp = (state: AuthTodoState, session: Session): string => `
  <section class="todo-panel" aria-labelledby="todo-title">
    <header class="session-bar">
      <div>
        <span class="eyebrow">${t("signedIn")}</span>
        <strong data-testid="session-email">${escapeHtml(session.email)}</strong>
      </div>
      <button type="button" class="secondary" data-testid="sign-out">${t("signOut")}</button>
    </header>
    <div class="todo-heading">
      <h2 id="todo-title">${t("todoTitle")}</h2>
      <span class="count" data-testid="todo-count">${openTodoText(state.todos)}</span>
    </div>
    <form class="todo-form" data-testid="todo-form" novalidate>
      <label for="todo-title-input">${t("newTodoLabel")}</label>
      <div class="todo-entry">
        <input id="todo-title-input" name="title" type="text" autocomplete="off" maxlength="120" placeholder="${t(
          "todoPlaceholder",
        )}" required />
        <button type="submit">${t("addTodo")}</button>
      </div>
    </form>
    ${renderTodoList(state.todos)}
    <p class="status" data-testid="todo-status" aria-live="polite">${escapeHtml(state.status)}</p>
  </section>
`;

const renderShell = (state: AuthTodoState): string => `
  <div class="shell">
    <header class="topbar">
      <div>
        <h1>${t("appTitle")}</h1>
        <p>${t("appSummary")}</p>
      </div>
    </header>
    ${state.session ? renderTodoApp(state, state.session) : renderAuthForm(state)}
  </div>
`;

const initialStatus = (
  sessionResult: Result<Session | undefined, AuthTodoError>,
  todosResult: Result<Todo[], AuthTodoError>,
): string => {
  if (!sessionResult.ok) {
    return sessionResult.error.message;
  }
  if (!todosResult.ok) {
    return todosResult.error.message;
  }
  return "";
};

export const mountAuthTodoExample = (app: HTMLElement): (() => void) => {
  const sessionResult = readSession();
  const initialSession = sessionResult.ok ? sessionResult.value : undefined;
  const todosResult = readTodos(initialSession);
  const state: AuthTodoState = {
    session: initialSession,
    status: initialStatus(sessionResult, todosResult),
    todos: todosResult.ok ? todosResult.value : [],
  };
  const cleanups: Array<() => void> = [];

  const cleanup = (): void => {
    for (const dispose of cleanups.splice(0)) {
      dispose();
    }
  };

  const saveTodos = (): void => {
    const result = writeTodos(state.session, state.todos);
    if (!result.ok) {
      state.status = result.error.message;
    }
  };

  const render = (): void => {
    cleanup();
    app.innerHTML = renderShell(state);

    const authForm = app.querySelector<HTMLFormElement>('[data-testid="auth-form"]');
    if (authForm) {
      cleanups.push(
        enhanceForm(authForm, {
          validate: ({ formData }) =>
            validateFormData(formData, {
              email: { pattern: emailPattern, message: t("invalidEmail"), required: true },
              passphrase: { message: t("invalidPassphrase"), minLength: 8, required: true },
            }),
          submit: ({ formData }) => {
            const result = signIn(String(formData.get("email") ?? ""), String(formData.get("passphrase") ?? ""));
            if (!result.ok) {
              return new Response(result.error.message, { status: 400 });
            }
            state.session = result.value;
            const writeResult = writeSession(result.value);
            const todosReadResult = readTodos(result.value);
            state.todos = todosReadResult.ok ? todosReadResult.value : [];
            state.status = !writeResult.ok
              ? writeResult.error.message
              : !todosReadResult.ok
                ? todosReadResult.error.message
                : t("signedIn");
            render();
            return new Response("ok");
          },
          onInvalid: ({ errors }) => {
            state.status = errors.email ?? errors.passphrase ?? "";
            render();
          },
          onSuccess: async ({ response }) => {
            if (!response.ok) {
              state.status = await response.text();
              render();
            }
          },
          onError: ({ error }) => {
            state.status = error instanceof Error ? error.message : "Unknown error.";
            render();
          },
        }),
      );
    }

    const todoForm = app.querySelector<HTMLFormElement>('[data-testid="todo-form"]');
    if (todoForm) {
      cleanups.push(
        enhanceForm(todoForm, {
          validate: ({ formData }) =>
            validateFormData(formData, {
              title: { maxLength: 120, message: t("todoRequired"), required: true },
            }),
          submit: ({ formData }) => {
            const result = createTodo(String(formData.get("title") ?? ""));
            if (!result.ok) {
              return new Response(result.error.message, { status: 400 });
            }
            state.todos = [result.value, ...state.todos];
            state.status = t("todoAdded");
            saveTodos();
            render();
            return new Response("ok");
          },
          onInvalid: ({ errors }) => {
            state.status = errors.title ?? "";
            render();
          },
        }),
      );
    }

    app.querySelector<HTMLButtonElement>('[data-testid="sign-out"]')?.addEventListener("click", () => {
      state.session = undefined;
      state.todos = [];
      state.status = t("signedOut");
      const result = writeSession(undefined);
      if (!result.ok) {
        state.status = result.error.message;
      }
      render();
    });

    app.querySelectorAll<HTMLButtonElement>("[data-action]").forEach((button) => {
      button.addEventListener("click", () => {
        const id = button.dataset.id;
        if (!id) {
          return;
        }
        if (button.dataset.action === "toggle") {
          state.todos = state.todos.map((todo) => (todo.id === id ? { ...todo, completed: !todo.completed } : todo));
          saveTodos();
          render();
          return;
        }
        if (button.dataset.action === "delete") {
          state.todos = state.todos.filter((todo) => todo.id !== id);
          state.status = t("todoDeleted");
          saveTodos();
          render();
        }
      });
    });
  };

  render();

  return () => {
    cleanup();
    app.innerHTML = "";
  };
};

const app = document.querySelector("#app");
if (app instanceof HTMLElement) {
  mountAuthTodoExample(app);
}
