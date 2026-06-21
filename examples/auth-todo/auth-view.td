<script>
import { enhanceForm, validateFormData } from "../../src/runtime/form";
import { err, ok } from "../../src/result";

export const emailPattern = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export const normalizeEmail = (email) => email.trim().toLowerCase();

export const userIdForEmail = (email) => normalizeEmail(email).replaceAll(/[^a-z0-9._-]/g, "-");

export const signIn = (email, passphrase, messages) => {
  const normalizedEmail = normalizeEmail(email);
  if (!emailPattern.test(normalizedEmail)) {
    return err({ message: messages.invalidEmail });
  }
  if (passphrase.length < 8) {
    return err({ message: messages.invalidPassphrase });
  }
  return ok({ email: normalizedEmail, userId: userIdForEmail(normalizedEmail) });
};

export const bindAuthForm = (form, options) =>
  enhanceForm(form, {
    validate: ({ formData }) =>
      validateFormData(formData, {
        email: { pattern: emailPattern, message: options.messages.invalidEmail, required: true },
        passphrase: { message: options.messages.invalidPassphrase, minLength: 8, required: true },
      }),
    submit: ({ formData }) => {
      const result = signIn(
        String(formData.get("email") ?? ""),
        String(formData.get("passphrase") ?? ""),
        options.messages,
      );
      if (!result.ok) {
        return new Response(result.error.message, { status: 400 });
      }
      options.state.session = result.value;
      const writeResult = options.writeSession(result.value);
      const todosReadResult = options.readTodos(result.value);
      options.state.todos = todosReadResult.ok ? todosReadResult.value : [];
      options.state.status = !writeResult.ok
        ? writeResult.error.message
        : !todosReadResult.ok
          ? todosReadResult.error.message
          : options.messages.signedIn;
      options.render();
      return new Response("ok");
    },
    onInvalid: ({ errors }) => {
      options.state.status = errors.email ?? errors.passphrase ?? "";
      options.render();
    },
    onSuccess: async ({ response }) => {
      if (!response.ok) {
        options.state.status = await response.text();
        options.render();
      }
    },
    onError: ({ error }) => {
      options.state.status = error instanceof Error ? error.message : "Unknown error.";
      options.render();
    },
  });
</script>
<section class="auth-panel" aria-labelledby="auth-title">
  <div>
    <h2 id="auth-title" data-testid="auth-title">{copy.signIn}</h2>
    <p>{copy.localOnlyNotice}</p>
  </div>
  <form data-testid="auth-form" novalidate>
    <div class="field">
      <label for="auth-email">{copy.emailLabel}</label>
      <span id="auth-email-hint">{copy.emailHint}</span>
      <input id="auth-email" name="email" type="email" autocomplete="email" aria-describedby="auth-email-hint" required />
    </div>
    <div class="field">
      <label for="auth-passphrase">{copy.passphraseLabel}</label>
      <span id="auth-passphrase-hint">{copy.passphraseHint}</span>
      <input id="auth-passphrase" name="passphrase" type="password" autocomplete="current-password" aria-describedby="auth-passphrase-hint" minlength="8" required />
    </div>
    <button type="submit">{copy.signIn}</button>
  </form>
  <p class="status" data-testid="auth-status" aria-live="polite">{status}</p>
</section>
