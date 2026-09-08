<script setup lang="ts">
// The mount site overrides `label` with a method that reads `this.secret`;
// the real Vite build must keep `secret` in the merged scope.
const secret = "READY";
const label = () => "LOCAL";
</script>
<main><p data-label>{label()}</p></main>
