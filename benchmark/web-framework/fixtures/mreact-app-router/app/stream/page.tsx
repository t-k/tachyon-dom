import { Await, defer } from "@reckona/mreact-router";

const items = Array.from({ length: 80 }, (_, index) => `stream item ${index + 1}`);
const delay = (milliseconds: number) => new Promise((resolve) => setTimeout(resolve, milliseconds));

export const stream = true;

export const loader = () => defer({ items: delay(20).then(() => items) });

export default function StreamPage(props: { data: { items: Promise<string[]> } }) {
  return (
    <main data-route="stream">
      <h1>Stream</h1>
      <p data-stream="shell">Shell</p>
      <Await value={props.data.items} placeholder={<p data-stream="pending">Loading payload</p>}>
        {(resolvedItems) => (
          <section data-stream="done">
            <h2>Deferred payload</h2>
            <ul>{resolvedItems.map((item) => <li key={item}>{item}</li>)}</ul>
          </section>
        )}
      </Await>
    </main>
  );
}
