import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

const [directory, mode] = process.argv.slice(2);
const load = (path) => import(pathToFileURL(resolve(directory, path)).href);
const digest = (data) => createHash("sha256").update(data).digest("hex");

if (mode === "bundles") {
  const { buildClientBundle, createClientBundleFixtures } = await load("scripts/client-bundle-attribution.mjs");
  const { createFeatureFixtures } = await load("scripts/verify-browser-feature-budgets.mjs");
  const applications = createClientBundleFixtures().map((fixture) => [fixture.name, fixture.entrySource]);
  const fixtures = [...applications, ...Object.entries(createFeatureFixtures())];
  assert.equal(new Set(fixtures.map(([name]) => name)).size, fixtures.length);
  const result = {};
  for (const [name, source] of fixtures) {
    const bundle = await buildClientBundle(source, { cwd: directory });
    result[name] = digest(bundle.outputFiles[0].contents);
  }
  console.log(JSON.stringify(result));
} else {
  const { compileTemplate, generateServerStreamModule } = await load("dist/compiler/index.js");
  const { parseTemplate } = await load("dist/compiler/parser.js");
  const { normalizeHtmlTagWhitespace } = await load("dist/html-whitespace.js");
  const { createSearchParamsSchema, queryStringList } = await load("dist/router-query.js");
  const { renderToReadableStream } = await load("dist/server/stream.js");

  const compile = (content) => (index) => {
    const result = compileTemplate('<main data-run="' + index + '">' + content + '</main>');
    assert(result.ok);
    return result.value;
  };
  const parse = (source) => () => {
    const result = parseTemplate(source);
    assert(result.ok);
    return result.value;
  };
  const query = (fields, count) => {
    const names = Array.from({ length: fields }, (_, index) => 'key' + index);
    const schema = createSearchParamsSchema(Object.fromEntries(names.map((name) => [name, queryStringList()])));
    const params = new URLSearchParams(Array.from({ length: count }, (_, index) => [
      names[Math.floor(index / 2) % fields], "value" + index,
    ])).toString();
    return () => schema.parse(params);
  };
  const stream = (fragment) => {
    const fragments = Array.from({ length: 256 }, () => fragment);
    return async () => {
      const chunks = [];
      for await (const chunk of renderToReadableStream(fragments)) chunks.push(chunk);
      return chunks;
    };
  };
  const template = compileTemplate('<ul><for each={rows} key={row.id}><li>{row.label}</li></for></ul>');
  assert(template.ok);
  const streamModule = generateServerStreamModule(template.value).replace("export const stream", "const stream");
  const generatedStream = new Function(streamModule + "\nreturn stream")();
  const generatedScope = { rows: Array.from({ length: 256 }, (_, id) => ({ id, label: "Row " + id })) };
  const generated = async () => {
    const chunks = [];
    for await (const chunk of generatedStream(generatedScope)) chunks.push(chunk);
    return chunks;
  };
  const nested = '<section title={value}>{value}'.repeat(48) + '</section>'.repeat(48);
  const compact = '<main>' + '<p class="row">Rendered row</p>'.repeat(900) + '</main>';
  const formatted = '<main>\n' + '<p class="row"   >Rendered row</p>\n'.repeat(300) + '</main>';
  const workloads = [
    ["compiler-small", compile("<p>{value}</p>"), 2800],
    ["compiler-nested", compile(nested), 450],
    ["parser-small-ascii", parse('<p title="short">Plain text</p>'), 120000],
    ["parser-small", parse('<p title="short">短い text</p>'), 120000],
    ["parser-long", parse('<p title="' + "alpha漢字".repeat(8192) + '">' + "long漢 text ".repeat(8192) + '</p>'), 600],
    ["parser-many-small", parse('<main>' + '<p title="name">短い本文</p>'.repeat(240) + '</main>'), 1800],
    ["html-compact", () => normalizeHtmlTagWhitespace(compact), 320],
    ["html-formatted", () => normalizeHtmlTagWhitespace(formatted), 500],
    ["query-small", query(4, 4), 60000],
    ["query-wide", query(64, 64), 18000],
    ["stream-ascii", stream("<p>Rendered row</p>"), 2000, true],
    ["stream-unicode", stream("<p>漢字と絵文字🙂</p>"), 2000, true],
    ["stream-generated", generated, 2000, true],
  ];
  const result = {};
  for (const [name, task, count, asyncTask] of workloads) {
    const output = await task(-1);
    let last;
    const warmCount = Math.max(100, Math.floor(count / 5));
    if (asyncTask) {
      for (let index = 0; index < warmCount; index++) last = await task(-index - 2);
    } else {
      for (let index = 0; index < warmCount; index++) last = task(-index - 2);
    }
    const start = performance.now();
    const cpu = process.cpuUsage();
    if (asyncTask) {
      for (let index = 0; index < count; index++) last = await task(index);
    } else {
      for (let index = 0; index < count; index++) last = task(index);
    }
    const elapsed = performance.now() - start;
    const { user, system } = process.cpuUsage(cpu);
    assert(last);
    result[name] = { cpuMicros: (user + system) / count, wallMicros: elapsed * 1000 / count, hash: digest(JSON.stringify(output)) };
  }
  console.log(JSON.stringify(result));
}
