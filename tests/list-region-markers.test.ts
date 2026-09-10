// @vitest-environment jsdom
// A `<for>` region is delimited by the same marker comments on the server and in the client template, so a
// list can share its parent with other dynamic regions: hydration adopts exactly the rows between the markers
// instead of inferring them from the container's element counts.
import { describe, expect, it } from "vitest";
import {
  compileTemplate,
  generateClientModule,
  generateServerStreamModule,
  renderServerTemplate,
  type CompileTemplateOptions,
} from "../src/compiler";
import { hydrate, mount } from "../src/runtime/mount";
import { createSignal } from "../src/runtime/signal";
import { evaluateGeneratedClientModule } from "./generated-client-module";

type Row = { id: string; label: string };

const renderStreamModuleToString = async (module: string, scope: Record<string, unknown>): Promise<string> => {
  const stream = new Function(`${module.replace("export const stream", "const stream")}; return stream;`)() as (
    scope: Record<string, unknown>,
  ) => AsyncIterable<string>;
  let output = "";
  for await (const chunk of stream(scope)) output += chunk;
  return output;
};

const compile = (template: string, options: CompileTemplateOptions = {}) => {
  const compiled = compileTemplate(template, options);
  if (!compiled.ok) throw new Error(compiled.error.message);
  return compiled.value;
};

const clientModuleFor = (template: string, options: CompileTemplateOptions = {}) =>
  evaluateGeneratedClientModule(
    generateClientModule(compile(template, options), { reactive: true, instrumentBindings: false }),
  );

const hydrateServerOutput = (
  template: string,
  serverScope: Record<string, unknown>,
  clientScope: Record<string, unknown>,
) => {
  const compiled = compile(template);
  const module = evaluateGeneratedClientModule(
    generateClientModule(compiled, { reactive: true, instrumentBindings: false }),
  );
  const root = document.createElement("div");
  root.innerHTML = renderServerTemplate(compiled, serverScope);
  const before = root.innerHTML;
  const result = hydrate(root, module, clientScope);
  if (!result.ok) throw new Error(`${result.error.message}\n${before}`);
  return { root, handle: result.value };
};

const mountClient = (template: string, clientScope: Record<string, unknown>) => {
  const module = clientModuleFor(template);
  const root = document.createElement("div");
  return { root, handle: mount(root, module, clientScope) };
};

const rowsOf = (...labels: string[]): Row[] => labels.map((label) => ({ id: label.toLowerCase(), label }));

const listAndConditional = `<ul>
  <for each={rows} key={row.id}>
    <li class="row">{row.label}</li>
  </for>
  <if test={loading}>
    <li class="status">Loading</li>
  </if>
</ul>`;

const twoLists = `<ul>
  <for each={first} as="row" key={row.id}>
    <li class="first">{row.label}</li>
  </for>
  <for each={second} as="row" key={row.id}>
    <li class="second">{row.label}</li>
  </for>
</ul>`;

const listWithTextSiblings = `<p>Before {head}
  <for each={rows} key={row.id}><b>{row.label}</b></for>
  after {tail}</p>`;

const conditionalInRows = `<ul>
  <for each={rows} key={row.id}>
    <li><span>{row.label}</span><if test={row.flag}><em>flag</em></if></li>
  </for>
</ul>`;

const listInConditional = `<section>
  <if test={open}>
    <ul>
      <for each={rows} key={row.id}>
        <li>{row.label}</li>
      </for>
    </ul>
  </if>
  <p>{tail}</p>
</section>`;

const genericTwoLists = `<ul>
  <for each={first} as="row" key={row.id}>
    <li class="first" on:click={pick}>{row.label}</li>
  </for>
  <for each={second} as="row" key={row.id}>
    <li class="second" title={row.label}>{row.label}</li>
  </for>
</ul>`;

const texts = (root: ParentNode, selector: string) =>
  Array.from(root.querySelectorAll(selector)).map((element) => element.textContent);

describe("<for> region markers", () => {
  it("delimits the list with the same markers on every target", () => {
    const compiled = compile(listAndConditional);
    const scope = { rows: rowsOf("Alpha", "Beta"), loading: true };
    const server = renderServerTemplate(compiled, scope);
    expect(server).toContain(
      `<!--tachyon-for-->\n    <li class="row">Alpha</li>\n  \n    <li class="row">Beta</li>\n  <!--/tachyon-for-->`,
    );
    expect(server).toContain(`<!--tachyon-if-->\n    <li class="status">Loading</li>\n  <!--/tachyon-if-->`);
    expect(compiled.client.templateHtml).toContain(
      `<!--tachyon-for--><!--/tachyon-for-->\n  <!--tachyon-if--><!--/tachyon-if-->`,
    );
    expect(compiled.client.templateHtml).not.toContain("tachyon-list");
  });

  it("renders the same HTML from the string and stream targets", async () => {
    for (const template of [listAndConditional, twoLists, listWithTextSiblings, conditionalInRows, listInConditional]) {
      const compiled = compile(template);
      const scope = {
        rows: [
          { id: "a", label: "Alpha", flag: true },
          { id: "b", label: "Beta", flag: false },
        ],
        first: rowsOf("One"),
        second: rowsOf("Two", "Three"),
        loading: true,
        open: true,
        head: "H",
        tail: "T",
      };
      const streamed = await renderStreamModuleToString(generateServerStreamModule(compiled), scope);
      expect(streamed).toBe(renderServerTemplate(compiled, scope));
    }
  });

  it("does not report a diagnostic when a <for> shares its parent with an <if>", () => {
    const compiled = compile(listAndConditional);
    expect(compiled.client.hydrationDynamicRegionErrors ?? []).toEqual([]);
    expect(compile(twoLists).client.hydrationDynamicRegionErrors ?? []).toEqual([]);
  });

  it("hydrates a <for> beside an <if> under one parent and keeps both live", () => {
    const rows = createSignal(rowsOf("Alpha", "Beta"));
    const loading = createSignal(true);
    const { root } = hydrateServerOutput(listAndConditional, { rows: rows(), loading: true }, { rows, loading });
    const serverRow = root.querySelector(".row");
    expect(texts(root, ".row")).toEqual(["Alpha", "Beta"]);
    expect(texts(root, ".status")).toEqual(["Loading"]);
    rows.set(rowsOf("Beta", "Alpha", "Gamma"));
    expect(texts(root, ".row")).toEqual(["Beta", "Alpha", "Gamma"]);
    expect(root.querySelector(".row")?.nextElementSibling).toBe(serverRow);
    loading.set(false);
    expect(root.querySelector(".status")).toBeNull();
    expect(texts(root, ".row")).toEqual(["Beta", "Alpha", "Gamma"]);
    loading.set(true);
    expect(texts(root, "li")).toEqual(["Beta", "Alpha", "Gamma", "Loading"]);
  });

  it("hydrates the same shape when the <if> comes first", () => {
    const template = `<ul>
  <if test={loading}><li class="status">Loading</li></if>
  <for each={rows} key={row.id}><li class="row">{row.label}</li></for>
</ul>`;
    const rows = createSignal(rowsOf("Alpha"));
    const loading = createSignal(false);
    const { root } = hydrateServerOutput(template, { rows: rows(), loading: false }, { rows, loading });
    loading.set(true);
    rows.set(rowsOf("Alpha", "Beta"));
    expect(texts(root, "li")).toEqual(["Loading", "Alpha", "Beta"]);
    loading.set(false);
    expect(texts(root, "li")).toEqual(["Alpha", "Beta"]);
  });

  it.each([
    ["text-only rows", twoLists],
    ["generic rows", genericTwoLists],
  ])("hydrates two sibling lists independently (%s)", (_name, template) => {
    const first = createSignal(rowsOf("One"));
    const second = createSignal(rowsOf("Two", "Three"));
    const { root } = hydrateServerOutput(
      template,
      { first: first(), second: second() },
      { first, second, pick: () => undefined },
    );
    const serverSecond = root.querySelector(".second");
    expect(texts(root, "li")).toEqual(["One", "Two", "Three"]);
    first.set(rowsOf("One", "Uno"));
    expect(texts(root, "li")).toEqual(["One", "Uno", "Two", "Three"]);
    second.set(rowsOf("Three"));
    expect(texts(root, "li")).toEqual(["One", "Uno", "Three"]);
    first.set([]);
    expect(texts(root, "li")).toEqual(["Three"]);
    expect(root.querySelector(".second")).not.toBe(serverSecond);
    second.set(rowsOf("Two", "Three"));
    expect(texts(root, ".second")).toEqual(["Two", "Three"]);
  });

  it("keeps text siblings around a list bound after hydration", () => {
    const rows = createSignal(rowsOf("A", "B"));
    const head = createSignal("H");
    const tail = createSignal("T");
    const { root } = hydrateServerOutput(
      listWithTextSiblings,
      { rows: rows(), head: "H", tail: "T" },
      { rows, head, tail },
    );
    expect(root.querySelector("p")?.textContent?.replace(/\s+/g, " ")).toBe("Before H AB after T");
    head.set("Head");
    tail.set("Tail");
    rows.set(rowsOf("C"));
    expect(root.querySelector("p")?.textContent?.replace(/\s+/g, " ")).toBe("Before Head C after Tail");
  });

  it("hydrates conditionals nested in rows and lists nested in conditionals", () => {
    const rows = createSignal([
      { id: "a", label: "Alpha", flag: true },
      { id: "b", label: "Beta", flag: false },
    ]);
    const flagged = hydrateServerOutput(conditionalInRows, { rows: rows() }, { rows });
    expect(texts(flagged.root, "li")).toEqual(["Alphaflag", "Beta"]);
    rows.set([
      { id: "b", label: "Beta", flag: true },
      { id: "a", label: "Alpha", flag: false },
    ]);
    expect(texts(flagged.root, "li")).toEqual(["Betaflag", "Alpha"]);

    const open = createSignal(true);
    const inner = createSignal(rowsOf("One"));
    const tail = createSignal("T");
    const nested = hydrateServerOutput(
      listInConditional,
      { open: true, rows: inner(), tail: "T" },
      { open, rows: inner, tail },
    );
    inner.set(rowsOf("One", "Two"));
    tail.set("Tail");
    expect(texts(nested.root, "li")).toEqual(["One", "Two"]);
    expect(nested.root.querySelector("p")?.textContent).toBe("Tail");
    open.set(false);
    expect(nested.root.querySelector("ul")).toBeNull();
    open.set(true);
    expect(texts(nested.root, "li")).toEqual(["One", "Two"]);
  });

  it.each([
    ["list beside conditional", listAndConditional],
    ["two lists", twoLists],
    ["generic two lists", genericTwoLists],
    ["text siblings", listWithTextSiblings],
    ["conditional in rows", conditionalInRows],
  ])("produces the same DOM after updates whether mounted or hydrated (%s)", (_name, template) => {
    const scopes = () => ({
      rows: createSignal([
        { id: "a", label: "Alpha", flag: true },
        { id: "b", label: "Beta", flag: false },
      ]),
      first: createSignal(rowsOf("One")),
      second: createSignal(rowsOf("Two")),
      loading: createSignal(true),
      head: createSignal("H"),
      tail: createSignal("T"),
      pick: () => undefined,
    });
    const mounted = scopes();
    const hydrated = scopes();
    const mountRoot = mountClient(template, mounted).root;
    const hydrateRoot = hydrateServerOutput(
      template,
      {
        rows: mounted.rows(),
        first: mounted.first(),
        second: mounted.second(),
        loading: true,
        head: "H",
        tail: "T",
      },
      hydrated,
    ).root;
    const normalize = (html: string) => html.replace(/\s+/g, " ");
    expect(normalize(hydrateRoot.innerHTML)).toBe(normalize(mountRoot.innerHTML));
    for (const scope of [mounted, hydrated]) {
      scope.rows.set([
        { id: "c", label: "Gamma", flag: false },
        { id: "a", label: "Alpha", flag: false },
      ]);
      scope.first.set(rowsOf("One", "Uno"));
      scope.second.set([]);
      scope.loading.set(false);
      scope.head.set("Head");
      scope.tail.set("Tail");
    }
    expect(normalize(hydrateRoot.innerHTML)).toBe(normalize(mountRoot.innerHTML));
  });
});
