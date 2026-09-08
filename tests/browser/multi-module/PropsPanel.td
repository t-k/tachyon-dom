<script setup>
inputScope.started();
const suffix = "!";
</script>
<main><store count={0}/><p data-eager>{label + suffix}</p><section hydrate:interaction="click"><button data-label>{label + suffix}</button><input bind:value={count}/><output>{count}</output></section></main>
