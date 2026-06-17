const itemsFor = (label: string) => Array.from({ length: 80 }, (_, index) => `${label} item ${index + 1}`);

export default async function Product({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const label = `Product ${id}`;
  return (
    <main data-route="product">
      <h1>{label}</h1>
      <p>Dynamic route {id}</p>
      <ul>
        {itemsFor(label).map((item) => (
          <li key={item}>{item}</li>
        ))}
      </ul>
    </main>
  );
}
