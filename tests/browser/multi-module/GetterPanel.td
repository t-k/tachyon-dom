<script>
// A default scope getter that returns a fresh array on every read. Several
// bindings read it, so the merged scope must not notify siblings on reads.
export default {
  get label() {
    return this.user.name;
  },
  get rows() {
    return [this.label, this.label];
  },
};
</script>
<main><store count={0}/><input bind:value={label}/><output>{label}</output><p data-count>{rows.length}</p><p data-first>{rows[0]}</p><p data-count-again>{rows.length}</p></main>
