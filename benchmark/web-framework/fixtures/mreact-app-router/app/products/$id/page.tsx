const itemsFor = (label: string) => Array.from({ length: 80 }, (_, index) => `${label} item ${index + 1}`);

export default function Product(props: { params: { id: string } }) {
  const label = `Product ${props.params.id}`;
  return (
    <main data-route="product">
      <h1>{label}</h1>
      <p>Dynamic route {props.params.id}</p>
      <ul>
        {itemsFor(label).map((item) => (
          <li key={item}>{item}</li>
        ))}
      </ul>
    </main>
  );
}
