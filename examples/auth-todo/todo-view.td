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
