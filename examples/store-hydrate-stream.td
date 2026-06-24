<script>
export const scope = {
  initialCount: 7,
  count: 7,
};
</script>
<main>
  <store count={initialCount} />
  <h1>Tachyon streaming example</h1>
  <section hydrate:idle>
    <button>{count}</button>
  </section>
</main>
