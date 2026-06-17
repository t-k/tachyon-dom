"use client";

import { useState } from "react";

export function Counter() {
  const [count, setCount] = useState(0);
  return (
    <>
      <button data-action="increment" type="button" onClick={() => setCount((value) => value + 1)}>
        Increment
      </button>
      <output data-count={count}>{count}</output>
    </>
  );
}
