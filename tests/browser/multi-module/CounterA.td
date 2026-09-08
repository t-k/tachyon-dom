<script setup lang="ts">
import { createSignal } from "tachyon-dom/runtime/signal";
import { shared, events } from "./shared";
const count = createSignal(0);
const rows = createSignal([{ id: "row", label: "A0" }]);
const increment = () => {
  events.a++;
  count.update((value) => value + 1);
  rows.set([{ id: "row", label: "A" + count() }]);
};
</script>
<main><button data-count on:click={increment}>{count}</button><p data-shared>{shared}</p><ul><for each={rows} key={row.id}><li>{row.label}</li></for></ul></main>
