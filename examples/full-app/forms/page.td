<script>
import { copy, t } from "../app";
import { err, ok } from "../../../src/result";

const profileResult = (form) => {
  const data = new FormData(form);
  const displayName = String(data.get("displayName") ?? "").trim();
  const email = String(data.get("email") ?? "")
    .trim()
    .toLowerCase();
  const role = String(data.get("role") ?? "");
  if (!displayName) {
    return err(t("nameRequired"));
  }
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return err(t("emailRequired"));
  }
  return ok({
    density: "comfortable",
    displayName,
    email,
    role,
    status: t("savedProfile", { name: displayName }),
    theme: "system",
  });
};

export const scope = ({ profile }) => ({
  copy: copy(),
  saveProfile: (event) => {
    event.preventDefault();
    const form = event.currentTarget instanceof HTMLFormElement ? event.currentTarget : undefined;
    if (!form) {
      profile.status = t("nameRequired");
      return;
    }
    const result = profileResult(form);
    if (!result.ok) {
      profile.status = result.error;
      return;
    }
    profile.displayName = result.value.displayName;
    profile.email = result.value.email;
    profile.role = result.value.role;
    profile.status = result.value.status;
  },
});
</script>
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
