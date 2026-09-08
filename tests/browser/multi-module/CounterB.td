<script setup lang="ts">
import { createSignal } from "tachyon-dom/runtime/signal";
import { shared, events } from "./shared";
const count = createSignal(10);
const rows = createSignal([{ id: "row", label: "B10" }]);
const increment = () => {
  events.b++;
  count.update((value) => value + 1);
  rows.set([{ id: "row", label: "B" + count() }]);
};
</script>
<main><button data-count on:click={increment}>{count}</button><p data-shared>{shared}</p><ul><for each={rows} key={row.id}><li>{row.label}</li></for></ul></main>
