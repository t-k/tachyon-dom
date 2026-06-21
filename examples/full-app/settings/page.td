<script>
import { copy } from "../app";

export default ({ profile, root }) => ({
  copy: copy(),
  setComfortable: () => {
    profile.density = "comfortable";
    root.dataset.density = "comfortable";
  },
  setCompact: () => {
    profile.density = "compact";
    root.dataset.density = "compact";
  },
  toggleTheme: (event) => {
    const input = event.currentTarget;
    if (!(input instanceof HTMLInputElement)) {
      return;
    }
    profile.theme = input.checked ? "light" : "system";
    root.dataset.theme = profile.theme;
  },
});
</script>
<section class="page-grid">
  <article class="panel">
    <h2>{copy.settingsTitle}</h2>
    <div class="segmented" role="group" aria-label={copy.compactMode}>
      <button type="button" data-density="compact" on:click={setCompact}>{copy.compactMode}</button>
      <button type="button" data-density="comfortable" on:click={setComfortable}>{copy.comfortableMode}</button>
    </div>
    <label class="switch-row">
      <input type="checkbox" data-testid="theme-toggle" on:change={toggleTheme} />
      <span>{copy.themeLight}</span>
    </label>
  </article>
</section>
