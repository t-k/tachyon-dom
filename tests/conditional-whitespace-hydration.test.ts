// @vitest-environment jsdom
// An `<if>` region is delimited by the same marker comments on the server and in the client template, so the
// whitespace text on either side of it never merges with the branch in the parsed document and hydration adopts
// exactly the nodes between the markers. These cases cover the whitespace-formatted shapes that used to merge.
import { describe, expect, it } from "vitest";
import {
  compileTemplate,
  generateClientModule,
  renderServerTemplate,
  type CompileTemplateOptions,
} from "../src/compiler";
import { hydrate } from "../src/runtime/mount";
import { createSignal, type Signal } from "../src/runtime/signal";
import { evaluateGeneratedClientModule } from "./generated-client-module";

const source = `<section>
  <h1>Panel</h1>
  <button id="toggle" on:click={toggle}>Toggle</button>
  <if test={open}>
    <p id="details">Details</p>
  </if>
  <p id="footer">{footer}</p>
</section>`;

const compile = (template: string, options: CompileTemplateOptions = {}) => {
  const compiled = compileTemplate(template, options);
  if (!compiled.ok) throw new Error(compiled.error.message);
  return compiled.value;
};

const hydrateServerOutput = (
  template: string,
  serverScope: Record<string, unknown>,
  clientScope: Record<string, unknown>,
  options: CompileTemplateOptions = {},
) => {
  const compiled = compile(template, options);
  const module = evaluateGeneratedClientModule(
    generateClientModule(compiled, { reactive: true, instrumentBindings: false }),
  );
  const root = document.createElement("div");
  root.innerHTML = renderServerTemplate(compiled, serverScope);
  const result = hydrate(root, module, clientScope);
  return { root, result };
};

const setup = (open: boolean, options: CompileTemplateOptions = {}) => {
  const openSignal = createSignal(open);
  const footer = createSignal("Footer");
  const { root, result } = hydrateServerOutput(
    source,
    { open, footer: "Footer" },
    { open: openSignal, footer, toggle: () => openSignal.update((value) => !value) },
    options,
  );
  return { root, result, openSignal, footer };
};

const expectHydrated = (result: ReturnType<typeof hydrate>) => {
  if (!result.ok) throw new Error(result.error.message);
  return result.value;
};

describe("hydrating a formatted template around a conditional", () => {
  it("delimits the region with markers on the server so whitespace siblings keep their own text nodes", () => {
    const compiled = compile(source);
    expect(renderServerTemplate(compiled, { open: false, footer: "Footer" })).toContain(
      `</button>\n  <!--tachyon-if--><!--/tachyon-if-->\n  <p id="footer">Footer</p>`,
    );
    expect(renderServerTemplate(compiled, { open: true, footer: "Footer" })).toContain(
      `</button>\n  <!--tachyon-if-->\n    <p id="details">Details</p>\n  <!--/tachyon-if-->\n  <p id="footer">Footer</p>`,
    );
    expect(compiled.client.templateHtml).toContain(
      `</button>\n  <!--tachyon-if--><!--/tachyon-if-->\n  <p id="footer">`,
    );
  });

  it("hydrates when the branch starts hidden and toggles it afterwards", () => {
    const { root, result, openSignal, footer } = setup(false);
    const handle = expectHydrated(result);
    expect(root.querySelector("#details")).toBeNull();
    openSignal.set(true);
    expect(root.querySelector("#details")?.textContent).toBe("Details");
    footer.set("Updated");
    expect(root.querySelector("#footer")?.textContent).toBe("Updated");
    openSignal.set(false);
    expect(root.querySelector("#details")).toBeNull();
    expect(root.querySelector("#footer")?.textContent).toBe("Updated");
    handle.dispose();
  });

  it("adopts the server branch when it starts visible", () => {
    const { root, result, openSignal, footer } = setup(true);
    const serverDetails = root.querySelector("#details");
    const handle = expectHydrated(result);
    expect(root.querySelector("#details")).toBe(serverDetails);
    footer.set("Updated");
    expect(root.querySelector("#footer")?.textContent).toBe("Updated");
    openSignal.set(false);
    expect(root.querySelector("#details")).toBeNull();
    openSignal.set(true);
    expect(root.querySelector("#details")?.textContent).toBe("Details");
    handle.dispose();
    expect(root.querySelector("#details")).toBeNull();
  });

  it("removes a server-visible branch when the client starts hidden", () => {
    const openSignal = createSignal(false);
    const footer = createSignal("Footer");
    const { root, result } = hydrateServerOutput(
      source,
      { open: true, footer: "Footer" },
      { open: openSignal, footer, toggle: () => undefined },
    );
    const handle = expectHydrated(result);
    expect(root.querySelector("#details")).toBeNull();
    footer.set("Updated");
    expect(root.querySelector("#footer")?.textContent).toBe("Updated");
    handle.dispose();
  });

  it("hydrates the condensed form of the same template", () => {
    const { root, result, openSignal, footer } = setup(true, { whitespace: "condense" });
    const handle = expectHydrated(result);
    expect(root.querySelector("#details")?.textContent).toBe("Details");
    openSignal.set(false);
    expect(root.querySelector("#details")).toBeNull();
    footer.set("Updated");
    expect(root.querySelector("#footer")?.textContent).toBe("Updated");
    handle.dispose();
  });
});

describe("hydrating conditional regions beside other structure", () => {
  const nestedSource = `<section>
  <if test={outer}>
    <p id="outer">Outer</p>
    <if test={inner}>
      <em id="inner">Inner</em>
    </if>
  </if>
  <p id="footer">{footer}</p>
</section>`;

  const nested = (server: { outer: boolean; inner: boolean }, client: { outer: boolean; inner: boolean }) => {
    const outer = createSignal(client.outer);
    const inner = createSignal(client.inner);
    const footer = createSignal("Footer");
    const { root, result } = hydrateServerOutput(
      nestedSource,
      { ...server, footer: "Footer" },
      { outer, inner, footer },
    );
    return { root, result, outer, inner, footer };
  };

  it("adopts a nested region inside a branch and keeps the later sibling aligned", () => {
    const { root, result, outer, inner, footer } = nested({ outer: true, inner: true }, { outer: true, inner: true });
    const serverOuter = root.querySelector("#outer");
    const serverInner = root.querySelector("#inner");
    const handle = expectHydrated(result);
    expect(root.querySelector("#outer")).toBe(serverOuter);
    expect(root.querySelector("#inner")).toBe(serverInner);
    footer.set("Updated");
    expect(root.querySelector("#footer")?.textContent).toBe("Updated");
    inner.set(false);
    expect(root.querySelector("#inner")).toBeNull();
    expect(root.querySelector("#outer")).toBe(serverOuter);
    inner.set(true);
    expect(root.querySelector("#inner")?.textContent).toBe("Inner");
    outer.set(false);
    expect(root.querySelector("#outer")).toBeNull();
    expect(root.querySelector("#inner")).toBeNull();
    outer.set(true);
    expect(root.querySelector("#outer")?.textContent).toBe("Outer");
    expect(root.querySelector("#inner")?.textContent).toBe("Inner");
    footer.set("Again");
    expect(root.querySelector("#footer")?.textContent).toBe("Again");
    handle.dispose();
    expect(root.querySelector("#outer")).toBeNull();
  });

  it("hydrates a visible outer region whose nested region is empty", () => {
    const { root, result, inner, footer } = nested({ outer: true, inner: false }, { outer: true, inner: false });
    const handle = expectHydrated(result);
    expect(root.querySelector("#inner")).toBeNull();
    inner.set(true);
    expect(root.querySelector("#inner")?.textContent).toBe("Inner");
    footer.set("Updated");
    expect(root.querySelector("#footer")?.textContent).toBe("Updated");
    handle.dispose();
  });

  it("drops a server-visible nested region when the client hides the outer one", () => {
    const { root, result, footer } = nested({ outer: true, inner: true }, { outer: false, inner: true });
    const handle = expectHydrated(result);
    expect(root.querySelector("#outer")).toBeNull();
    expect(root.querySelector("#inner")).toBeNull();
    footer.set("Updated");
    expect(root.querySelector("#footer")?.textContent).toBe("Updated");
    handle.dispose();
  });

  it("matches a same-tag static sibling that directly follows the region", () => {
    const template = `<main><if test={open}><p>Details</p></if><p id="footer">{footer}</p></main>`;
    for (const open of [true, false]) {
      const openSignal = createSignal(open);
      const footer = createSignal("Footer");
      const { root, result } = hydrateServerOutput(template, { open, footer: "Footer" }, { open: openSignal, footer });
      const serverFooter = root.querySelector("#footer");
      const handle = expectHydrated(result);
      expect(root.querySelector("#footer")).toBe(serverFooter);
      footer.set("Updated");
      expect(root.querySelector("#footer")?.textContent).toBe("Updated");
      openSignal.set(!open);
      expect(root.querySelectorAll("p")).toHaveLength(open ? 1 : 2);
      handle.dispose();
    }
  });

  it("keeps a list in a later sibling aligned with a formatted region", () => {
    const template = `<section>
  <if test={open}>
    <p id="details">Details</p>
  </if>
  <ul id="list">
    <for each={items} key={item}><li>{item}</li></for>
  </ul>
  <p id="footer">{footer}</p>
</section>`;
    for (const open of [true, false]) {
      const openSignal = createSignal(open);
      const items: Signal<string[]> = createSignal(["a", "b"]);
      const footer = createSignal("Footer");
      const { root, result } = hydrateServerOutput(
        template,
        { open, items: ["a", "b"], footer: "Footer" },
        { open: openSignal, items, footer },
      );
      const handle = expectHydrated(result);
      items.set(["a", "b", "c"]);
      expect(Array.from(root.querySelectorAll("li"), (item) => item.textContent)).toEqual(["a", "b", "c"]);
      footer.set("Updated");
      expect(root.querySelector("#footer")?.textContent).toBe("Updated");
      openSignal.set(!open);
      expect(root.querySelector("#details") !== null).toBe(!open);
      expect(Array.from(root.querySelectorAll("li"), (item) => item.textContent)).toEqual(["a", "b", "c"]);
      handle.dispose();
    }
  });
});
