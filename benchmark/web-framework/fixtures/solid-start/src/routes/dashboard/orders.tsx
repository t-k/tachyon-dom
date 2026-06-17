const items = Array.from({ length: 120 }, (_, index) => `order item ${index + 1}`);

export default function Orders() {
  return (
    <main data-route="orders">
      <h1>Dashboard</h1>
      <h2>Orders</h2>
      <ul>
        {items.map((item) => (
          <li>{item}</li>
        ))}
      </ul>
    </main>
  );
}
