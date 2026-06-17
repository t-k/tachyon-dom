import { createFileRoute } from "@tanstack/react-router";

const items = Array.from({ length: 120 }, (_, index) => `user item ${index + 1}`);

export const Route = createFileRoute("/dashboard/users")({
  component: Users,
});

function Users() {
  return (
    <main data-route="users">
      <h1>Dashboard</h1>
      <h2>Users</h2>
      <ul>
        {items.map((item) => (
          <li key={item}>{item}</li>
        ))}
      </ul>
    </main>
  );
}
