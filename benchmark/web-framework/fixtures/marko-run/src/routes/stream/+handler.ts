const encoder = new TextEncoder();
const items = Array.from({ length: 80 }, (_, index) => `<li>stream item ${index + 1}</li>`).join("");

export const GET = (): Response =>
  new Response(
    new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(
          encoder.encode(
            '<!doctype html><html><body><main data-route="stream"><h1>Stream</h1><p data-stream="shell">Shell</p>',
          ),
        );
        setTimeout(() => {
          controller.enqueue(
            encoder.encode(
              `<section data-stream="done"><h2>Deferred payload</h2><ul>${items}</ul></section></main></body></html>`,
            ),
          );
          controller.close();
        }, 20);
      },
    }),
    { headers: { "content-type": "text/html; charset=utf-8" } },
  );
