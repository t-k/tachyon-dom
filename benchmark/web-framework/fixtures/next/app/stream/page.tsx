import { Suspense } from "react";

const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const items = Array.from({ length: 80 }, (_, index) => `stream item ${index + 1}`);

async function DeferredPayload() {
  await delay(25);
  return (
    <section data-stream="done">
      <h2>Deferred payload</h2>
      <ul>
        {items.map((item) => (
          <li key={item}>{item}</li>
        ))}
      </ul>
    </section>
  );
}

export default function StreamPage() {
  return (
    <main data-route="stream">
      <h1>Stream</h1>
      <p data-stream="shell">Shell</p>
      <Suspense fallback={<p data-stream="fallback">Loading</p>}>
        <DeferredPayload />
      </Suspense>
    </main>
  );
}
