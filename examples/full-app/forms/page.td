<section class="page-grid">
  <form class="panel form-panel" action="/profile" method="post" novalidate on:submit={saveProfile}>
    <fieldset>
      <legend>{copy.formsTitle}</legend>
      <div class="field">
        <label for="display-name">{copy.displayName}</label>
        <input id="display-name" name="displayName" autocomplete="name" required />
      </div>
      <div class="field">
        <label for="email">{copy.email}</label>
        <input id="email" name="email" type="email" autocomplete="email" required />
      </div>
      <div class="field">
        <label for="role">{copy.role}</label>
        <select id="role" name="role">
          <option value="Runtime">{copy.roleRuntime}</option>
          <option value="Router">{copy.roleRouter}</option>
          <option value="Design systems">{copy.roleDesignSystems}</option>
        </select>
      </div>
    </fieldset>
    <button type="submit" data-testid="save-profile">{copy.saveProfile}</button>
    <p class="status" data-testid="form-status" aria-live="polite">{profile.status}</p>
  </form>
  <article class="panel">
    <h2>{copy.summary}</h2>
    <dl class="profile-summary">
      <div><dt>{copy.displayName}</dt><dd data-testid="profile-name">{profile.displayName}</dd></div>
      <div><dt>{copy.email}</dt><dd data-testid="profile-email">{profile.email}</dd></div>
      <div><dt>{copy.role}</dt><dd data-testid="profile-role">{profile.role}</dd></div>
    </dl>
  </article>
</section>
