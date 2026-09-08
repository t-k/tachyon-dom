<script setup lang="ts">
import { createSignal } from "tachyon-dom/runtime/signal";
import { shared, sharedText, events } from "./shared";
const shown = true;
const draft = createSignal("");
const count = createSignal(0);
const increment = () => {
  events.ssr++;
  count.update((value) => value + 1);
};
</script>
<main><p data-eager>{shared}</p><if test={shown}><section hydrate:interaction="click"><p data-text>{sharedText}</p><button data-count on:click={increment}>{count}</button><input bind:value={draft}></section></if></main>
