import { createFileRoute } from "@tanstack/react-router";

const items = Array.from({ length: 120 }, (_, index) => `order item ${index + 1}`);

export const Route = createFileRoute("/dashboard/orders")({
  component: Orders,
});

function Orders() {
  return (
    <main data-route="orders">
      <h1>Dashboard</h1>
      <h2>Orders</h2>
      <ul>
        {items.map((item) => (
          <li key={item}>{item}</li>
        ))}
      </ul>
    </main>
  );
}
