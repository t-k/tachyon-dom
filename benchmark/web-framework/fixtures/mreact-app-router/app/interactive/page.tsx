import { cell } from "@reckona/mreact-reactive-core";

export default function Interactive() {
  const count = cell(0);
  return (
    <main data-route="interactive">
      <h1>Interactive</h1>
      <h2>Counter</h2>
      <button data-action="increment" type="button" onClick={() => count.set((value) => value + 1)}>
        Increment
      </button>
      <output data-count={count.get()}>{count.get()}</output>
    </main>
  );
}
