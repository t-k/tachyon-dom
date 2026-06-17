import { createFileRoute } from "@tanstack/react-router";

const items = Array.from({ length: 80 }, (_, index) => `home item ${index + 1}`);

export const Route = createFileRoute("/")({
  component: Home,
});

function Home() {
  return (
    <main data-route="home">
      <h1>Home</h1>
      <p>Static route rendered by TanStack Start.</p>
      <ul>
        {items.map((item) => (
          <li key={item}>{item}</li>
        ))}
      </ul>
    </main>
  );
}
