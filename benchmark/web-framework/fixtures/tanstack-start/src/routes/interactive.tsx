import { createFileRoute } from "@tanstack/react-router";
import { useState } from "react";

export const Route = createFileRoute("/interactive")({
  component: Interactive,
});

function Interactive() {
  const [count, setCount] = useState(0);
  return (
    <main data-route="interactive">
      <h1>Interactive</h1>
      <h2>Counter</h2>
      <button data-action="increment" type="button" onClick={() => setCount((value) => value + 1)}>
        Increment
      </button>
      <output data-count={count}>{count}</output>
    </main>
  );
}
