import "./styles.css";
import * as authViewModule from "./auth-view.td";
import authViewSource from "./auth-view.td?raw";
import shellSource from "./shell.td?raw";
import * as todoViewModule from "./todo-view.td";
import todoViewSource from "./todo-view.td?raw";
import { renderServerTemplate, type CompiledTemplate } from "../../src/compiler";
import { compileTachyonSfc } from "../../src/compiler/sfc";
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

type AuthViewModule = {
  bindAuthForm: (
    form: HTMLFormElement,
    options: {
      messages: AuthTodoMessages;
      readTodos: typeof readTodos;
      render: () => void;
      state: AuthTodoState;
      writeSession: typeof writeSession;
    },
  ) => () => void;
};

type TodoViewModule = {
  bindTodoView: (
    root: HTMLElement,
    options: {
      copy: Record<string, string>;
      messages: AuthTodoMessages;
      render: () => void;
      saveTodos: () => void;
      state: AuthTodoState;
      writeSession: typeof writeSession;
    },
  ) => () => void;
  createTodoScope: (
    state: AuthTodoState,
    session: Session,
    options: { copy: Record<string, string>; messages: AuthTodoMessages },
  ) => Record<string, unknown>;
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

type AuthTodoMessages = (typeof messages)["en"];

const authView = authViewModule as unknown as AuthViewModule;
const todoView = todoViewModule as unknown as TodoViewModule;

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

const compileView = (source: string): CompiledTemplate => {
  const result = compileTachyonSfc(source);
  if (!result.ok) {
    throw new Error(result.error.message);
  }
  return result.value.template;
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

const renderAuthForm = (state: AuthTodoState): string =>
  renderServerTemplate(authViewTemplate, { copy: copy(), status: state.status });

const renderTodoApp = (state: AuthTodoState, session: Session): string =>
  renderServerTemplate(
    todoViewTemplate,
    todoView.createTodoScope(state, session, { copy: copy(), messages: messages.en }),
  );

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

const app = document.querySelector("#app");
if (app instanceof HTMLElement) {
  mountAuthTodoExample(app);
}
