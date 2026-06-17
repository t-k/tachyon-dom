import { createHandler, StartServer } from "@solidjs/start/server";

function Document(props: { assets: unknown; children: unknown; scripts: unknown }) {
  return (
    <html lang="en">
      <head>{props.assets}</head>
      <body>
        <div id="app">{props.children}</div>
        {props.scripts}
      </body>
    </html>
  );
}

export default createHandler(() => <StartServer document={Document} />);
