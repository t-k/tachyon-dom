import { Suspense } from "react";

const items = Array.from({ length: 80 }, (_, index) => `stream item ${index + 1}`);
const delay = (milliseconds: number) => new Promise((resolve) => setTimeout(resolve, milliseconds));

export const dynamic = "force-dynamic";

async function DeferredPayload() {
  await delay(20);
  return (
    <section data-stream="done">
      <h2>Deferred payload</h2>
      <ul>{items.map((item) => <li key={item}>{item}</li>)}</ul>
    </section>
  );
}

export default function StreamPage() {
  return (
    <main data-route="stream">
      <h1>Stream</h1>
      <p data-stream="shell">Shell</p>
      <Suspense fallback={<p data-stream="pending">Loading payload</p>}>
        <DeferredPayload />
      </Suspense>
    </main>
  );
}
