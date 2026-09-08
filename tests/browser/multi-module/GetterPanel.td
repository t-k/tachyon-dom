<script>
// A default scope getter that returns a fresh array on every read. Several
// bindings read it, so the merged scope must not notify siblings on reads.
export default {
  get rows() {
    return [this.label, this.label];
  },
};
</script>
<main><p data-count>{rows.length}</p><p data-first>{rows[0]}</p><p data-count-again>{rows.length}</p></main>
