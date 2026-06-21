<script>
import { batch } from "../../../src/runtime/signal";

export default ({ count, step }) => ({
  decrement: () => count.update((value) => value - step()),
  doubleStep: () =>
    batch(() => {
      step.update((value) => value * 2);
      count.update((value) => value + 0);
    }),
  increment: () => count.update((value) => value + step()),
  resetCounter: () =>
    batch(() => {
      count.set(0);
      step.set(1);
    }),
});
</script>
<section class="page-grid">
  <article class="panel counter-panel">
    <div class="counter-readout">
      <span data-testid="count-value">{count}</span>
      <small>{copy.step} <b data-testid="step-value">{step}</b></small>
    </div>
    <div class="toolbar">
      <button type="button" data-testid="decrement" on:click={decrement}>{copy.decrement}</button>
      <button type="button" data-testid="increment" on:click={increment}>{copy.increment}</button>
      <button type="button" data-testid="double-step" on:click={doubleStep}>{copy.doubleStep}</button>
      <button type="button" class="secondary" data-testid="reset-counter" on:click={resetCounter}>{copy.reset}</button>
    </div>
  </article>
  <article class="panel">
    <h2>{copy.memo}</h2>
    <p class="metric-large" data-testid="projected-value">{projected}</p>
    <p>{copy.projectedHelp}</p>
  </article>
</section>
