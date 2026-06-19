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
