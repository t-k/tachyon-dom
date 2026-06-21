<script>
import { copy, t } from "../app";

export const scope = ({ rows, openOnly }) => ({
  addRow: () => {
    const id = Math.max(...rows().map((row) => row.id)) + 1;
    rows.set([{ id, label: `Inserted row ${id}`, owner: "User", status: "open" }, ...rows()]);
  },
  copy: copy(),
  rotateRows: () => {
    const [first, ...rest] = rows();
    rows.set(first ? [...rest, first] : []);
  },
  rowMode: () => (openOnly() ? t("openOnly") : t("allRows")),
  toggleLabel: () => (openOnly() ? t("allRows") : t("openOnly")),
  toggleOpenOnly: () => openOnly.update((value) => !value),
  visibleRows: () => rows().filter((row) => !openOnly() || row.status === "open"),
});
</script>
<section class="page-grid">
  <article class="panel">
    <div class="toolbar">
      <button type="button" data-testid="add-row" on:click={addRow}>{copy.addRow}</button>
      <button type="button" data-testid="rotate-rows" on:click={rotateRows}>{copy.rotateRows}</button>
      <button type="button" class="secondary" data-testid="toggle-open-only" on:click={toggleOpenOnly}>{toggleLabel()}</button>
    </div>
    <ul class="row-list" data-testid="row-list">
      <for each={visibleRows()} key={row.id}>
        <li class="row-card" class:is-done={row.status === "done"} data-testid="row">
          <span class="row-status">{row.status}</span><strong data-testid="row-label">{row.label}</strong><small>{row.owner}</small>
        </li>
      </for>
    </ul>
  </article>
  <article class="panel">
    <h2>{copy.selection}</h2>
    <p data-testid="row-mode">{rowMode()}</p>
  </article>
</section>
