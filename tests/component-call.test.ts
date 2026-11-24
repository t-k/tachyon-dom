import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import {
  compileTachyonSfc,
  compileTemplate,
  generateClientModule,
  generateServerModule,
  generateServerStreamModule,
  renderServerTemplate,
} from "../src/compiler";
import { templateScopeIdentifiers, transformSfcScript } from "../src/compiler/sfc";
import { createSignal, createTemplateComponent, hydrate, mount, onCleanup, type Signal } from "../src/index";
import { checkTachyonTemplateTypes } from "../src/template-typecheck";
import { evaluateGeneratedClientModule } from "./generated-client-module";

const loadClientModule = async (code: string) => evaluateGeneratedClientModule(code);

const loadJsModule = async (code: string) =>
  import(`data:text/javascript;base64,${Buffer.from(code).toString("base64")}`);

const collectStream = async (stream: AsyncIterable<string>): Promise<string> => {
  let out = "";
  for await (const chunk of stream) out += chunk;
  return out;
};

const compileComponent = async <Props extends Record<string, unknown>>(
  source: string,
  options: {
    scope?: (props: Props) => Record<string, unknown>;
    onMount?: () => void;
    onDispose?: () => void;
  } = {},
) => {
  const compiled = compileTemplate(source);
  if (!compiled.ok) throw new Error(compiled.error.message);
  const clientMod = await loadClientModule(generateClientModule(compiled.value, { reactive: true }));
  const serverMod = (await loadJsModule(generateServerModule(compiled.value))) as {
    render: (scope: Record<string, unknown>) => string;
  };
  const streamMod = (await loadJsModule(generateServerStreamModule(compiled.value))) as {
    stream: (scope: Record<string, unknown>) => AsyncIterable<string>;
  };
  return createTemplateComponent<Props>({
    client: {
      ...clientMod,
      bind: (root, scope) => {
        options.onMount?.();
        if (options.onDispose) onCleanup(options.onDispose);
        return clientMod.bind(root, scope);
      },
    },
    ...(options.scope ? { scope: options.scope } : {}),
    render: (props) => serverMod.render(options.scope ? options.scope(props) : props),
    stream: (props) => streamMod.stream(options.scope ? options.scope(props) : props),
  });
};

describe("declarative component composition (<Panel />)", () => {
  it("compiles PascalCase and dotted component calls into componentCall IR and keeps inline <component>", () => {
    const result = compileTemplate(
      `<main><Panel title={title} staticLabel="Hello" active /><Ui.Badge count={count} /><component name="Inline" v={x}><span>{v}</span></component></main>`,
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.value.ir.directives).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: "componentCall",
          path: [0],
          tagName: "Panel",
          props: [
            { name: "title", value: "title", kind: "expression" },
            { name: "staticLabel", value: "Hello", kind: "static" },
            { name: "active", value: true, kind: "boolean" },
          ],
        }),
        expect.objectContaining({
          kind: "componentCall",
          path: [1],
          tagName: "Ui.Badge",
          props: [{ name: "count", value: "count", kind: "expression" }],
        }),
        expect.objectContaining({
          kind: "component",
          name: "Inline",
        }),
      ]),
    );
  });

  it("allows href and onClick prop names on components while rejecting forbidden directives and non-empty children", () => {
    const okProps = compileTemplate(`<main><Link href={url} onClick={handle} name={userName} /></main>`);
    expect(okProps.ok).toBe(true);

    const badDirective = compileTemplate(`<main><Panel on:click={handle} /></main>`);
    expect(badDirective.ok).toBe(false);

    const badProto = compileTemplate(`<main><Panel __proto__={bad} /></main>`);
    expect(badProto.ok).toBe(false);

    const badChildren = compileTemplate(`<main><Panel><p>child</p></Panel></main>`);
    expect(badChildren.ok).toBe(false);
  });

  it("tracks component tag root identifiers in templateScopeIdentifiers for SFC setup narrowing", () => {
    const ids = templateScopeIdentifiers(`<main><Panel title={title} /><Ui.Card /></main>`);
    expect(ids).toBeDefined();
    expect(ids?.has("Panel")).toBe(true);
    expect(ids?.has("Ui")).toBe(true);
    expect(ids?.has("title")).toBe(true);

    const sfc = compileTachyonSfc(
      `<script setup>\nimport { component as Panel } from "./Panel.td";\nconst title = "Hi";\nconst unused = 123;\n</script>\n<main><Panel title={title} /></main>`,
    );
    expect(sfc.ok).toBe(true);
    if (!sfc.ok) return;
    const transformed = transformSfcScript(sfc.value.descriptor.script, {
      templateIdentifiers: templateScopeIdentifiers(sfc.value.template),
    });
    expect(transformed.ok).toBe(true);
    if (!transformed.ok) return;
    expect(transformed.value.exposedBindings).toContain("Panel");
    expect(transformed.value.exposedBindings).toContain("title");
  });

  it("mounts, updates reactively without unwrapping signals, hydrates SSR/stream output, and preserves sibling paths", async () => {
    const disposed = vi.fn();
    const Panel = await compileComponent<{ title: string; countSignal?: Signal<number>; label?: string }>(
      `<section class="panel"><h2>{title}</h2><p>{label}</p><span class="sig">{countSignal}</span></section>`,
      { onDispose: disposed },
    );

    const parentCompiled = compileTemplate(
      `<main><h1>Header</h1><Panel title={title()} countSignal={countSignal} label="Static" /><footer>{footer()}</footer></main>`,
    );
    expect(parentCompiled.ok).toBe(true);
    if (!parentCompiled.ok) return;

    const parentClient = await loadClientModule(generateClientModule(parentCompiled.value, { reactive: true }));
    const parentServer = (await loadJsModule(generateServerModule(parentCompiled.value))) as {
      render: (scope: Record<string, unknown>) => string;
    };
    const parentStream = (await loadJsModule(generateServerStreamModule(parentCompiled.value))) as {
      stream: (scope: Record<string, unknown>) => AsyncIterable<string>;
    };

    const title = createSignal("First");
    const countSignal = createSignal(10);
    const footer = createSignal("Foot-1");

    const ssrHtml = parentServer.render({ Panel, title, countSignal, footer });
    const streamHtml = await collectStream(parentStream.stream({ Panel, title, countSignal, footer }));
    const interpreterHtml = renderServerTemplate(parentCompiled.value, { Panel, title, countSignal, footer });
    expect(streamHtml).toBe(ssrHtml);
    expect(interpreterHtml).toBe(ssrHtml);
    expect(ssrHtml).toContain("<!--tachyon-component-->");
    expect(ssrHtml).toContain("<!--/tachyon-component-->");
    expect(ssrHtml).toContain("<h2>First</h2>");
    expect(ssrHtml).toContain("<footer>Foot-1</footer>");

    // Client mount
    const mountRoot = document.createElement("div");
    const mountHandle = mount(mountRoot, parentClient, { Panel, title, countSignal, footer });
    expect(mountRoot.querySelector("h2")?.textContent).toBe("First");
    expect(mountRoot.querySelector(".sig")?.textContent).toBe("10");
    expect(mountRoot.querySelector("footer")?.textContent).toBe("Foot-1");

    title.set("Second");
    countSignal.set(20);
    footer.set("Foot-2");
    expect(mountRoot.querySelector("h2")?.textContent).toBe("Second");
    expect(mountRoot.querySelector(".sig")?.textContent).toBe("20");
    expect(mountRoot.querySelector("footer")?.textContent).toBe("Foot-2");
    mountHandle.dispose();
    expect(disposed).toHaveBeenCalledTimes(1);

    // SSR -> Hydrate preserves existing DOM nodes
    title.set("First");
    countSignal.set(10);
    footer.set("Foot-1");
    const hydrateRoot = document.createElement("div");
    hydrateRoot.innerHTML = ssrHtml;
    const originalSection = hydrateRoot.querySelector("section.panel");
    const originalFooter = hydrateRoot.querySelector("footer");
    const hydrated = hydrate(hydrateRoot, parentClient, { Panel, title, countSignal, footer });
    expect(hydrated.ok).toBe(true);
    if (!hydrated.ok) return;
    expect(hydrateRoot.querySelector("section.panel")).toBe(originalSection);
    expect(hydrateRoot.querySelector("footer")).toBe(originalFooter);

    title.set("Hydrated-Update");
    countSignal.set(99);
    footer.set("Foot-Hydrated");
    expect(originalSection?.querySelector("h2")?.textContent).toBe("Hydrated-Update");
    expect(originalSection?.querySelector(".sig")?.textContent).toBe("99");
    expect(originalFooter?.textContent).toBe("Foot-Hydrated");
    hydrated.value.dispose();
    expect(disposed).toHaveBeenCalledTimes(2);
  });

  it("preserves child DOM identity and local state on keyed <for> reorder and disposes on remove or <if> toggle", async () => {
    let instanceCounter = 0;
    const disposedIds: number[] = [];
    const ItemCard = await compileComponent<{ label: string }>(
      `<article class="card"><store local={0} /><b>{label}</b><button on:click={inc}>{local}</button></article>`,
      {
        onDispose: () => {
          disposedIds.push(++instanceCounter);
        },
        scope: (props) => ({
          ...props,
          inc: () => undefined,
        }),
      },
    );

    const parentCompiled = compileTemplate(
      `<section><ul><for each={items} key={item.id}><li><ItemCard label={item.label} /></li></for></ul><if test={open}><ItemCard label={banner} /></if></section>`,
    );
    expect(parentCompiled.ok).toBe(true);
    if (!parentCompiled.ok) return;

    const parentClient = await loadClientModule(generateClientModule(parentCompiled.value, { reactive: true }));
    const items = createSignal([
      { id: "a", label: "Alpha" },
      { id: "b", label: "Beta" },
    ]);
    const open = createSignal(true);
    const banner = createSignal("Banner-1");

    const root = document.createElement("div");
    const handle = mount(root, parentClient, { ItemCard, items, open, banner });
    const cardsBefore = Array.from(root.querySelectorAll("li article.card"));
    expect(cardsBefore.map((el) => el.querySelector("b")?.textContent)).toEqual(["Alpha", "Beta"]);
    expect(root.querySelectorAll("article.card")).toHaveLength(3);

    // Reorder + update label
    items.set([
      { id: "b", label: "Beta-2" },
      { id: "a", label: "Alpha-2" },
    ]);
    const cardsAfter = Array.from(root.querySelectorAll("li article.card"));
    expect(cardsAfter[0]).toBe(cardsBefore[1]);
    expect(cardsAfter[1]).toBe(cardsBefore[0]);
    expect(cardsAfter.map((el) => el.querySelector("b")?.textContent)).toEqual(["Beta-2", "Alpha-2"]);

    // Toggle <if> false disposes branch component
    open.set(false);
    expect(root.querySelectorAll("article.card")).toHaveLength(2);
    expect(disposedIds).toHaveLength(1);

    // Remove row "a"
    items.set([{ id: "b", label: "Beta-3" }]);
    expect(root.querySelectorAll("article.card")).toHaveLength(1);
    expect(disposedIds).toHaveLength(2);

    handle.dispose();
    expect(disposedIds).toHaveLength(3);
  });

  it("rejects mismatched child structure on hydrate and rolls back without mutating SSR DOM", async () => {
    const Panel = await compileComponent<{ title: string }>(`<section><h2>{title}</h2></section>`);
    const parentCompiled = compileTemplate(`<main><Panel title={title} /><button on:click={onClick}>Go</button></main>`);
    expect(parentCompiled.ok).toBe(true);
    if (!parentCompiled.ok) return;
    const parentClient = await loadClientModule(generateClientModule(parentCompiled.value, { reactive: true }));

    const onClick = vi.fn();
    const root = document.createElement("div");
    // Child rendered wrong tag (<div> instead of <section>)
    root.innerHTML = `<main><!--tachyon-component--><div><h2>Wrong</h2></div><!--/tachyon-component--><button>Go</button></main>`;
    const result = hydrate(root, parentClient, { Panel, title: "Hello", onClick });
    expect(result.ok).toBe(false);
    // Sibling click listener must not remain bound after failed hydrate
    root.querySelector("button")?.click();
    expect(onClick).not.toHaveBeenCalled();
  });

  it("typechecks component call props (missing, excess, wrong type, non-component)", () => {
    const source = `
<script setup lang="ts">
import type { TemplateComponent } from "./src/runtime/component";
declare const Panel: TemplateComponent<{ title: string; count?: number }>;
declare const notAComp: number;
const okTitle = "Hello";
const badCount = "nope";
</script>
<main>
  <Panel title={okTitle} count={badCount} />
  <Panel title={okTitle} extra={1} />
  <Panel />
  <notAComp />
</main>
`;
    const checked = checkTachyonTemplateTypes(source, { fileName: `${process.cwd()}/virtual-component-call.td` });
    expect(checked.ok).toBe(true);
    if (!checked.ok) return;
    const messages = checked.value.map((d) => d.message).join("\n");
    expect(messages).toContain("not assignable");
    expect(messages).toContain("extra");
    expect(messages).toContain("title");
  });

  it("propagates server and stream target queries to imported .td components in the Vite plugin", async () => {
    const { tachyonDom } = await import("../src/vite");
    const plugin = tachyonDom();
    const resolveId = plugin.resolveId as unknown as (
      this: { resolve: (source: string, importer?: string, opts?: unknown) => Promise<{ id: string } | null> },
      source: string,
      importer?: string,
    ) => Promise<string | null>;

    const ctx = {
      resolve: async (source: string) => ({ id: `/virtual/${source.replace(/^\.\//, "")}` }),
    };

    expect(await resolveId.call(ctx, "./Panel.td", "/virtual/Page.td?server")).toBe("/virtual/Panel.td?server");
    expect(await resolveId.call(ctx, "./Panel.td", "/virtual/Page.td?stream")).toBe("/virtual/Panel.td?stream");
    expect(await resolveId.call(ctx, "./Panel.td", "/virtual/Page.td?client")).toBeNull();
    expect(await resolveId.call(ctx, "./Panel.td?client", "/virtual/Page.td?server")).toBeNull();
  });

  it("resolves component tag names in template-language and explains component-call bindings", async () => {
    const { createTemplateLanguageFeatures } = await import("../src/template-language");
    const { explainCompiledTemplate } = await import("../src/compiler/explain");

    const source = `<script setup>\nimport { component as Panel } from "./Panel.td";\nconst title = "Hi";\n</script>\n<main><Panel title={title} /></main>`;
    const features = createTemplateLanguageFeatures(source);
    const panelUse = source.indexOf("<Panel") + 1;
    const line = source.slice(0, panelUse).split("\n").length - 1;
    const character = panelUse - (source.lastIndexOf("\n", panelUse) + 1);
    const def = features.definition({ line, character });
    expect(def).toBeDefined();

    const compiled = compileTemplate(`<main><if test={open}><Panel title={title} /></if></main>`);
    expect(compiled.ok).toBe(true);
    if (!compiled.ok) return;
    const explanation = explainCompiledTemplate(compiled.value);
    expect(explanation.runtimeImports).toContain("tachyon-dom/runtime/component");
    expect(explanation.regions[0]?.reasons.join(" ")).toContain("<Panel />");

    const plainCompiled = compileTemplate(`<main><p>{title}</p></main>`);
    expect(plainCompiled.ok).toBe(true);
    if (!plainCompiled.ok) return;
    expect(explainCompiledTemplate(plainCompiled.value).runtimeImports).not.toContain("tachyon-dom/runtime/component");
  });

  it("covers all generated PICT scenarios across targets, placements, props, and lifecycles", async () => {
    const tsv = readFileSync("docs.local/coverage-ledger/component-call.generated.tsv", "utf8").trim().split("\n");
    const rows = tsv.slice(1).map((line) => {
      const [target, placement, propsKind, targetExpr, lifecycle] = line.split("\t");
      return { target, placement, propsKind, targetExpr, lifecycle };
    });
    expect(rows.length).toBeGreaterThanOrEqual(20);

    const Leaf = await compileComponent<{ label?: string; flag?: boolean; sig?: Signal<number> }>(
      `<div class="leaf"><span class="l">{label}</span><span class="f">{flag}</span><span class="s">{sig}</span></div>`,
    );

    const Wrapper = await compileComponent<{ LeafComp: typeof Leaf; label?: string; flag?: boolean; sig?: Signal<number> }>(
      `<section class="wrap"><LeafComp label={label} flag={flag} sig={sig} /></section>`,
    );

    for (const row of rows) {
      const tag = row.targetExpr === "dotted_member" ? "Ui.Leaf" : "Leaf";
      const propAttrs =
        row.propsKind === "none"
          ? ""
          : row.propsKind === "static_and_bool"
            ? ` label="Static" flag`
            : row.propsKind === "reactive_expr"
              ? ` label={label()}`
              : ` sig={sig}`;

      const callTag =
        row.placement === "nested_component"
          ? `<Wrapper LeafComp={${tag}}${propAttrs} />`
          : `<${tag}${propAttrs} />`;

      const templateSource =
        row.placement === "top_level"
          ? `<main>${callTag}</main>`
          : row.placement === "with_siblings"
            ? `<main><em>Before</em>${callTag}<strong>{tail()}</strong></main>`
            : row.placement === "inside_if"
              ? `<main><if test={open()}>${callTag}</if><strong>{tail()}</strong></main>`
              : row.placement === "inside_for"
                ? `<main><ul><for each={items()} key={item.id}><li>${callTag}</li></for></ul><strong>{tail()}</strong></main>`
                : `<main>${callTag}<strong>{tail()}</strong></main>`;

      const compiled = compileTemplate(templateSource);
      expect(compiled.ok, JSON.stringify(row)).toBe(true);
      if (!compiled.ok) continue;

      const label = createSignal("Init");
      const sig = createSignal(1);
      const tail = createSignal("Tail-1");
      const open = createSignal(true);
      const items = createSignal([
        { id: 1, name: "one" },
        { id: 2, name: "two" },
      ]);
      const scope = { Leaf, Ui: { Leaf }, Wrapper, label, sig, tail, open, items };

      const serverMod = (await loadJsModule(generateServerModule(compiled.value))) as {
        render: (s: Record<string, unknown>) => string;
      };
      const ssr = serverMod.render(scope);

      if (row.target === "server") {
        expect(ssr).toContain("<!--tachyon-component-->");
        continue;
      }
      if (row.target === "stream") {
        const streamMod = (await loadJsModule(generateServerStreamModule(compiled.value))) as {
          stream: (s: Record<string, unknown>) => AsyncIterable<string>;
        };
        expect(await collectStream(streamMod.stream(scope))).toBe(ssr);
        continue;
      }

      const clientMod = await loadClientModule(generateClientModule(compiled.value, { reactive: true }));
      const host = document.createElement("div");
      let handle: { dispose: () => void };
      if (row.target === "client_hydrate") {
        host.innerHTML = ssr;
        const firstLeaf = host.querySelector(".leaf");
        const hydrated = hydrate(host, clientMod, scope);
        expect(hydrated.ok, JSON.stringify(row)).toBe(true);
        if (!hydrated.ok) continue;
        expect(host.querySelector(".leaf")).toBe(firstLeaf);
        handle = hydrated.value;
      } else {
        handle = mount(host, clientMod, scope);
      }

      expect(host.querySelectorAll(".leaf").length).toBe(row.placement === "inside_for" ? 2 : 1);
      if (row.propsKind === "static_and_bool") {
        expect(host.querySelector(".l")?.textContent).toBe("Static");
        expect(host.querySelector(".f")?.textContent).toBe("true");
      }

      if (row.lifecycle === "prop_update") {
        label.set("Updated");
        sig.set(42);
        tail.set("Tail-2");
        if (row.propsKind === "reactive_expr") expect(host.querySelector(".l")?.textContent).toBe("Updated");
        if (row.propsKind === "signal_passthrough") expect(host.querySelector(".s")?.textContent).toBe("42");
        if (row.placement !== "top_level") expect(host.querySelector("strong")?.textContent).toBe("Tail-2");
      } else if (row.lifecycle === "reorder_or_toggle") {
        if (row.placement === "inside_if") {
          open.set(false);
          expect(host.querySelectorAll(".leaf").length).toBe(0);
          open.set(true);
          expect(host.querySelectorAll(".leaf").length).toBe(1);
        } else if (row.placement === "inside_for") {
          const before = Array.from(host.querySelectorAll(".leaf"));
          items.set([
            { id: 2, name: "two" },
            { id: 1, name: "one" },
          ]);
          const after = Array.from(host.querySelectorAll(".leaf"));
          expect(after[0]).toBe(before[1]);
          expect(after[1]).toBe(before[0]);
        }
      }

      handle.dispose();
    }
  });
});
