const items = Array.from({ length: 120 }, (_, index) => `user item ${index + 1}`);

export default function Users() {
  return (
    <main data-route="users">
      <h1>Dashboard</h1>
      <h2>Users</h2>
      <a href="/dashboard/orders" data-nav="orders">
        Orders
      </a>
      <ul>
        {items.map((item) => (
          <li key={item}>{item}</li>
        ))}
      </ul>
    </main>
  );
}
