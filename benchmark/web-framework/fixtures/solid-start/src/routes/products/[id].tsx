import { useParams } from "@solidjs/router";

export default function Product() {
  const params = useParams();
  const label = () => `Product ${params.id}`;
  const items = () => Array.from({ length: 80 }, (_, index) => `${label()} item ${index + 1}`);
  return (
    <main data-route="product">
      <h1>{label()}</h1>
      <p>Dynamic route {params.id}</p>
      <ul>
        {items().map((item) => (
          <li>{item}</li>
        ))}
      </ul>
    </main>
  );
}
