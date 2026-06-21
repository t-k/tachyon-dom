<script>
export default {
  initialCount: 7,
  count: 7,
  islandId: "counter-panel",
};
</script>
<main>
  <store count={initialCount} />
  <h1>Tachyon streaming example</h1>
  <section hydrate:id={islandId}>
    <button>{count}</button>
  </section>
</main>
