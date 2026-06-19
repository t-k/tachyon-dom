import "./styles.css";
import authViewSource from "./auth-view.td?raw";
import shellSource from "./shell.td?raw";
import todoViewSource from "./todo-view.td?raw";
import { compileTemplate, renderServerTemplate, type CompiledTemplate } from "../../src/compiler";
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

type TodoViewModel = Todo & {
  toggleLabel: string;
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

const copy = (): Record<string, string> => ({
  addTodo: t("addTodo"),
  appSummary: t("appSummary"),
  appTitle: t("appTitle"),
  deleteTodo: t("deleteTodo"),
  emailHint: t("emailHint"),
  emailLabel: t("emailLabel"),
  emptyTodos: t("emptyTodos"),
  localOnlyNotice: t("localOnlyNotice"),
  newTodoLabel: t("newTodoLabel"),
  passphraseHint: t("passphraseHint"),
  passphraseLabel: t("passphraseLabel"),
  signIn: t("signIn"),
  signOut: t("signOut"),
  signedIn: t("signedIn"),
  todoPlaceholder: t("todoPlaceholder"),
  todoTitle: t("todoTitle"),
});

const sessionStorageKey = "tachyon-auth-todo:session";
const todoStoragePrefix = "tachyon-auth-todo:todos:";

const emailPattern = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

const compileView = (source: string): CompiledTemplate => {
  const result = compileTemplate(source);
  if (!result.ok) {
    throw new Error(result.error.message);
  }
  return result.value;
};

const authViewTemplate = compileView(authViewSource);
const shellTemplate = compileView(shellSource);
const todoViewTemplate = compileView(todoViewSource);

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

const renderAuthForm = (state: AuthTodoState): string =>
  renderServerTemplate(authViewTemplate, { copy: copy(), status: state.status });

const openTodoText = (todos: readonly Todo[]): string => {
  const openCount = todos.filter((todo) => !todo.completed).length;
  return openCount === 1 ? t("openCountOne") : t("openCountMany", { count: openCount });
};

const todoViewModels = (todos: readonly Todo[]): TodoViewModel[] =>
  todos.map((todo) => ({ ...todo, toggleLabel: todo.completed ? t("markOpen") : t("markComplete") }));

const renderTodoApp = (state: AuthTodoState, session: Session): string =>
  renderServerTemplate(todoViewTemplate, {
    copy: copy(),
    hasTodos: state.todos.length > 0,
    isEmpty: state.todos.length === 0,
    openCount: openTodoText(state.todos),
    session,
    status: state.status,
    todos: todoViewModels(state.todos),
  });

const renderShell = (state: AuthTodoState): string =>
  renderServerTemplate(shellTemplate, {
    copy: copy(),
    outlet: state.session ? renderTodoApp(state, state.session) : renderAuthForm(state),
  });

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
