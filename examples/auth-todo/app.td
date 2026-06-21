<script>
import * as authView from "./auth-view.td";
import authViewSource from "./auth-view.td?raw";
import shellSource from "./shell.td?raw";
import * as todoView from "./todo-view.td";
import todoViewSource from "./todo-view.td?raw";
import { renderServerTemplate } from "../../src/compiler";
import { compileTachyonSfc } from "../../src/compiler/sfc";
import { err, ok } from "../../src/result";

const messages = {
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

const t = (key, values = {}) =>
  Object.entries(values).reduce((text, [name, value]) => text.replaceAll(`{${name}}`, String(value)), messages.en[key]);

const copy = () => ({
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

const compileView = (source) => {
  const result = compileTachyonSfc(source);
  if (!result.ok) {
    throw new Error(result.error.message);
  }
  return result.value.template;
};

const authViewTemplate = compileView(authViewSource);
const shellTemplate = compileView(shellSource);
const todoViewTemplate = compileView(todoViewSource);

const storageResult = (read) => {
  try {
    return ok(read());
  } catch (error) {
    return err({ message: error instanceof Error ? error.message : "Storage unavailable." });
  }
};

const readSession = () =>
  storageResult(() => {
    const raw = localStorage.getItem(sessionStorageKey);
    if (!raw) {
      return undefined;
    }
    const parsed = JSON.parse(raw);
    if (typeof parsed.email !== "string" || typeof parsed.userId !== "string") {
      return undefined;
    }
    return { email: parsed.email, userId: parsed.userId };
  });

const writeSession = (session) =>
  storageResult(() => {
    if (!session) {
      localStorage.removeItem(sessionStorageKey);
      return;
    }
    localStorage.setItem(sessionStorageKey, JSON.stringify(session));
  });

const todoStorageKey = (session) => `${todoStoragePrefix}${session.userId}`;

const readTodos = (session) =>
  storageResult(() => {
    if (!session) {
      return [];
    }
    const raw = localStorage.getItem(todoStorageKey(session));
    if (!raw) {
      return [];
    }
    const parsed = JSON.parse(raw);
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

const writeTodos = (session, todos) =>
  storageResult(() => {
    if (!session) {
      return;
    }
    localStorage.setItem(todoStorageKey(session), JSON.stringify(todos));
  });

const renderAuthForm = (state) => renderServerTemplate(authViewTemplate, { copy: copy(), status: state.status });

const renderTodoApp = (state, session) =>
  renderServerTemplate(todoViewTemplate, todoView.createTodoScope(state, session, { copy: copy(), messages: messages.en }));

const renderShell = (state) =>
  renderServerTemplate(shellTemplate, {
    copy: copy(),
    outlet: state.session ? renderTodoApp(state, state.session) : renderAuthForm(state),
  });

const initialStatus = (sessionResult, todosResult) => {
  if (!sessionResult.ok) {
    return sessionResult.error.message;
  }
  if (!todosResult.ok) {
    return todosResult.error.message;
  }
  return "";
};

export const mountAuthTodoExample = (app) => {
  const sessionResult = readSession();
  const initialSession = sessionResult.ok ? sessionResult.value : undefined;
  const todosResult = readTodos(initialSession);
  const state = {
    session: initialSession,
    status: initialStatus(sessionResult, todosResult),
    todos: todosResult.ok ? todosResult.value : [],
  };
  const cleanups = [];

  const cleanup = () => {
    for (const dispose of cleanups.splice(0)) {
      dispose();
    }
  };

  const saveTodos = () => {
    const result = writeTodos(state.session, state.todos);
    if (!result.ok) {
      state.status = result.error.message;
    }
  };

  const render = () => {
    cleanup();
    app.innerHTML = renderShell(state);

    const authForm = app.querySelector('[data-testid="auth-form"]');
    if (authForm instanceof HTMLFormElement) {
      cleanups.push(
        authView.bindAuthForm(authForm, {
          messages: messages.en,
          readTodos,
          render,
          state,
          writeSession,
        }),
      );
    }

    if (state.session) {
      cleanups.push(
        todoView.bindTodoView(app, {
          copy: copy(),
          messages: messages.en,
          render,
          saveTodos,
          state,
          writeSession,
        }),
      );
    }
  };

  render();

  return () => {
    cleanup();
    app.innerHTML = "";
  };
};
</script>
