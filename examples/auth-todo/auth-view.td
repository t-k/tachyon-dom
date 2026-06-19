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
