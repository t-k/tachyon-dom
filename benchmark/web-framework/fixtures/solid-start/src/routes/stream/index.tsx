import { Suspense } from "solid-js";
import { createAsync } from "@solidjs/router";

const items = Array.from({ length: 80 }, (_, index) => `stream item ${index + 1}`);
const delay = (milliseconds: number) => new Promise((resolve) => setTimeout(resolve, milliseconds));

export default function StreamPage() {
  const deferredItems = createAsync(async () => {
    await delay(20);
    return items;
  });
  return (
    <main data-route="stream">
      <h1>Stream</h1>
      <p data-stream="shell">Shell</p>
      <Suspense fallback={<p data-stream="pending">Loading payload</p>}>
        <section data-stream="done">
          <h2>Deferred payload</h2>
          <ul>{deferredItems()?.map((item) => <li>{item}</li>)}</ul>
        </section>
      </Suspense>
    </main>
  );
}
