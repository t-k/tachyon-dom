<script setup>
globalThis.__lazySetupRuns = (globalThis.__lazySetupRuns ?? 0) + 1;
const label = "Send";
const submit = (event) => {
  event.preventDefault();
  globalThis.__lazySubmits = (globalThis.__lazySubmits ?? 0) + 1;
};
</script>
<main id="generated-lazy"><section hydrate:interaction="click"><form on:submit={submit}><button type="submit">{label}</button></form></section></main>
