const items = Array.from({ length: 80 }, (_, index) => `stream item ${index + 1}`);

export default function StreamPage() {
  return (
    <main data-route="stream">
      <h1>Stream</h1>
      <p data-stream="shell">Shell</p>
      <section data-stream="done">
        <h2>Deferred payload</h2>
        <ul>
          {items.map((item) => (
            <li>{item}</li>
          ))}
        </ul>
      </section>
    </main>
  );
}
