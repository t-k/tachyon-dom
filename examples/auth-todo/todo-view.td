<script>
import { enhanceForm, validateFormData } from "../../src/runtime/form";
import { err, ok } from "../../src/result";

export const createTodo = (title, messages, now = Date.now()) => {
  const trimmed = title.trim();
  if (trimmed.length === 0) {
    return err({ message: messages.todoRequired });
  }
  return ok({
    completed: false,
    createdAt: now,
    id: `${now}-${Math.random().toString(16).slice(2)}`,
    title: trimmed,
  });
};

export const openTodoText = (todos, messages) => {
  const openCount = todos.filter((todo) => !todo.completed).length;
  return openCount === 1 ? messages.openCountOne : messages.openCountMany.replaceAll("{count}", String(openCount));
};

export const todoViewModels = (todos, messages) =>
  todos.map((todo) => ({ ...todo, toggleLabel: todo.completed ? messages.markOpen : messages.markComplete }));

export const createTodoScope = (state, session, options) => ({
  copy: options.copy,
  hasTodos: state.todos.length > 0,
  isEmpty: state.todos.length === 0,
  openCount: openTodoText(state.todos, options.messages),
  session,
  status: state.status,
  todos: todoViewModels(state.todos, options.messages),
});

const listen = (element, eventName, handler) => {
  element.addEventListener(eventName, handler);
  return () => element.removeEventListener(eventName, handler);
};

export const bindTodoView = (root, options) => {
  const cleanups = [];
  const todoForm = root.querySelector('[data-testid="todo-form"]');
  if (todoForm instanceof HTMLFormElement) {
    cleanups.push(
      enhanceForm(todoForm, {
        validate: ({ formData }) =>
          validateFormData(formData, {
            title: { maxLength: 120, message: options.messages.todoRequired, required: true },
          }),
        submit: ({ formData }) => {
          const result = createTodo(String(formData.get("title") ?? ""), options.messages);
          if (!result.ok) {
            return new Response(result.error.message, { status: 400 });
          }
          options.state.todos = [result.value, ...options.state.todos];
          options.state.status = options.messages.todoAdded;
          options.saveTodos();
          options.render();
          return new Response("ok");
        },
        onInvalid: ({ errors }) => {
          options.state.status = errors.title ?? "";
          options.render();
        },
      }),
    );
  }

  const signOut = root.querySelector('[data-testid="sign-out"]');
  if (signOut instanceof HTMLButtonElement) {
    cleanups.push(
      listen(signOut, "click", () => {
        options.state.session = undefined;
        options.state.todos = [];
        options.state.status = options.messages.signedOut;
        const result = options.writeSession(undefined);
        if (!result.ok) {
          options.state.status = result.error.message;
        }
        options.render();
      }),
    );
  }

  root.querySelectorAll("[data-action]").forEach((button) => {
    if (!(button instanceof HTMLButtonElement)) {
      return;
    }
    cleanups.push(
      listen(button, "click", () => {
        const id = button.dataset.id;
        if (!id) {
          return;
        }
        if (button.dataset.action === "toggle") {
          options.state.todos = options.state.todos.map((todo) =>
            todo.id === id ? { ...todo, completed: !todo.completed } : todo,
          );
          options.saveTodos();
          options.render();
          return;
        }
        if (button.dataset.action === "delete") {
          options.state.todos = options.state.todos.filter((todo) => todo.id !== id);
          options.state.status = options.messages.todoDeleted;
          options.saveTodos();
          options.render();
        }
      }),
    );
  });

  return () => {
    for (const cleanup of cleanups) {
      cleanup();
    }
  };
};
</script>
<section class="todo-panel" aria-labelledby="todo-title">
  <header class="session-bar">
    <div>
      <span class="eyebrow">{copy.signedIn}</span>
      <strong data-testid="session-email">{session.email}</strong>
    </div>
    <button type="button" class="secondary" data-testid="sign-out">{copy.signOut}</button>
  </header>
  <div class="todo-heading">
    <h2 id="todo-title">{copy.todoTitle}</h2>
    <span class="count" data-testid="todo-count">{openCount}</span>
  </div>
  <form class="todo-form" data-testid="todo-form" novalidate>
    <label for="todo-title-input">{copy.newTodoLabel}</label>
    <div class="todo-entry">
      <input id="todo-title-input" name="title" type="text" autocomplete="off" maxlength="120" placeholder={copy.todoPlaceholder} required />
      <button type="submit">{copy.addTodo}</button>
    </div>
  </form>
  <if test={isEmpty}>
    <p class="empty" data-testid="todo-empty">{copy.emptyTodos}</p>
  </if>
  <if test={hasTodos}>
    <ul class="todo-list" data-testid="todo-list" role="list">
      <for each={todos} key={todo.id}>
        <li class="todo-item" class:completed={todo.completed}>
          <span>{todo.title}</span>
          <div class="todo-actions">
            <button type="button" class="secondary" data-action="toggle" data-id={todo.id} data-testid="toggle-todo">{todo.toggleLabel}</button>
            <button type="button" class="danger" data-action="delete" data-id={todo.id}>{copy.deleteTodo}</button>
          </div>
        </li>
      </for>
    </ul>
  </if>
  <p class="status" data-testid="todo-status" aria-live="polite">{status}</p>
</section>
