# Client bundle size of interactive pages

`pnpm bench:client-bundle` builds a handful of small interactive pages as production Tachyon DOM route apps and records what a cold browser fetches for each initial route. It follows the shape of mreact's client delivery report: fixed application fixtures, the framework's own production build path, and gzip plus Brotli sizes of the delivered files rather than an esbuild snippet.

## Fixtures

Every fixture in `fixtures.ts` is a starter-shaped project: a `src/routes` tree of `.td` pages, a `src/client/main.ts` entry, and the starter's `vite.config.ts` with `tachyonDom({ reactive: true })` and `tachyonApp()`. The runner writes the project into a temporary directory, links the checkout as `node_modules/tachyon-dom` so the package resolves through its published `exports` to `dist/`, and runs `vite build` from the project directory with `NODE_ENV=production`.

| Fixture       | Page                                                                                           |
| ------------- | ---------------------------------------------------------------------------------------------- |
| `counter`     | A server-rendered counter hydrated with one signal and one click handler.                      |
| `keyed-list`  | A keyed row list with add, clear, and selection class toggling.                                |
| `form`        | A contact form with two-way input bindings and a submit handler.                               |
| `conditional` | A details panel toggled through a conditional region.                                          |
| `multi-route` | A hydrated page adopted by a client router (`adopt`) that mounts the other page on navigation. |

## What is measured

For the initial route the runner reads the built HTML document and every same-origin module script, module preload, and stylesheet it references. Each file is measured raw, gzip (Node `zlib` default level), and Brotli (Node default settings). `javascript` sums scripts and preloads, `stylesheets` sums stylesheet links, and `initial` adds the HTML document to both.

Before a fixture is recorded, Chromium loads the built page from a loopback static server and performs the fixture's interaction: a click that must produce the expected text. A page that failed to hydrate would still have a size, so a failed interaction fails the run instead of recording a number. Pass `--skip-browser` to skip that check locally; the result then records `validated: false` for every fixture.

## Output

Results use the shared schema version 2 provenance envelope with `benchmark.name: "client-bundle"` and `contractVersion: 1`. The default output is a timestamped file under `benchmark/client-bundle/results/`, which is ignored by Git; `--output` selects another path. `--fixture <name>` limits the run to one or more fixtures.

The `Benchmarks` GitHub Actions workflow runs this suite for `all` and `client-bundle`, adds the table to the job summary through `pnpm bench:summary --client`, and uploads the JSON with the other results.

## Notes

- Sizes depend on the Node and zlib versions recorded in the provenance, so compare runs from the same runner image.
