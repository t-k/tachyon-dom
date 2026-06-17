import { createFileRoute } from "@tanstack/react-router";

const items = Array.from({ length: 80 }, (_, index) => `stream item ${index + 1}`);

export const Route = createFileRoute("/stream")({
  component: StreamPage,
});

function StreamPage() {
  return (
    <main data-route="stream">
      <h1>Stream</h1>
      <p data-stream="shell">Shell</p>
      <section data-stream="done">
        <h2>Deferred payload</h2>
        <ul>
          {items.map((item) => (
            <li key={item}>{item}</li>
          ))}
        </ul>
      </section>
    </main>
  );
}
