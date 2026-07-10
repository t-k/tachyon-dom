import { Await, createFileRoute } from "@tanstack/react-router";

const items = Array.from({ length: 80 }, (_, index) => `stream item ${index + 1}`);
const delay = (milliseconds: number) => new Promise((resolve) => setTimeout(resolve, milliseconds));

export const Route = createFileRoute("/stream")({
  loader: () => ({ items: delay(20).then(() => items) }),
  component: StreamPage,
});

function StreamPage() {
  const data = Route.useLoaderData();
  return (
    <main data-route="stream">
      <h1>Stream</h1>
      <p data-stream="shell">Shell</p>
      <Await promise={data.items} fallback={<p data-stream="pending">Loading payload</p>}>
        {(resolvedItems) => (
          <section data-stream="done">
            <h2>Deferred payload</h2>
            <ul>{resolvedItems.map((item) => <li key={item}>{item}</li>)}</ul>
          </section>
        )}
      </Await>
    </main>
  );
}
