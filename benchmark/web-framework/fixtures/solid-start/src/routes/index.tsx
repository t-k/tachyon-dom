const items = Array.from({ length: 80 }, (_, index) => `home item ${index + 1}`);

export default function Home() {
  return (
    <main data-route="home">
      <h1>Home</h1>
      <p>Static route rendered by SolidStart.</p>
      <ul>
        {items.map((item) => (
          <li>{item}</li>
        ))}
      </ul>
    </main>
  );
}
