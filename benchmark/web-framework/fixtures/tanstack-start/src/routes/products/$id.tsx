import { createFileRoute } from "@tanstack/react-router";

export const Route = createFileRoute("/products/$id")({
  component: Product,
});

function Product() {
  const { id } = Route.useParams();
  const label = `Product ${id}`;
  const items = Array.from({ length: 80 }, (_, index) => `${label} item ${index + 1}`);
  return (
    <main data-route="product">
      <h1>{label}</h1>
      <p>Dynamic route {id}</p>
      <ul>
        {items.map((item) => (
          <li key={item}>{item}</li>
        ))}
      </ul>
    </main>
  );
}
