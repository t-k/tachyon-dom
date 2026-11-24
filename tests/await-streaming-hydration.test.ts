import { existsSync, readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import {
  compileTemplate,
  generateClientModule,
  generateServerModule,
  generateServerStreamModule,
  renderServerTemplate,
} from "../src/compiler";
import { createSignal, createStore, createTemplateComponent, hydrate, mount } from "../src/index";
import { applyPendingAwaitSwaps } from "../src/runtime/stream-client";
import { evaluateGeneratedClientModule } from "./generated-client-module";

const loadJsModule = async (code: string) =>
  import(`data:text/javascript;base64,${Buffer.from(code).toString("base64")}`);

const createDeferred = <T>() => {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
};

/** Simulates browser execution of inline `<script data-tachyon-await=...>` tags inside `root`. */
const executeAwaitScripts = (root: ParentNode): void => {
  for (const script of Array.from(root.querySelectorAll("script[data-tachyon-await]"))) {
    const code = script.textContent ?? "";
    if (code) {
      new Function(code)();
    }
  }
};

describe("<await> streaming replacement and hydration", () => {
  it("replaces pending HTML with resolved content instead of appending, and flushes shell before promise settles", async () => {
    const compiled = compileTemplate(
      `<main><h1>Shell</h1><await value={msgPromise} then="msg" pending="<p class=loading>Loading...</p>" error="<p class=err>Failed</p>"><p class="ready">{msg}</p></await><footer>{tail()}</footer></main>`,
    );
    expect(compiled.ok).toBe(true);
    if (!compiled.ok) return;

    const streamCode = generateServerStreamModule(compiled.value);
    const streamMod = (await loadJsModule(streamCode)) as {
      stream: (scope: Record<string, unknown>, options?: { nonce?: string }) => AsyncIterable<string>;
    };

    const deferred = createDeferred<string>();
    const tail = createSignal("Foot");
    const iterator = streamMod.stream({ msgPromise: deferred.promise, tail })[Symbol.asyncIterator]();

    // First chunk(s) must deliver the shell including footer BEFORE the promise resolves
    let shell = "";
    while (!shell.includes("</footer></main>")) {
      const next = await iterator.next();
      expect(next.done).toBe(false);
      shell += next.value;
    }
    expect(shell).toContain("Loading...");
    expect(shell).toContain("<footer>Foot</footer></main>");

    // Now resolve the promise and collect trailing swap chunks
    deferred.resolve("Hello Stream");
    let trailing = "";
    while (true) {
      const next = await iterator.next();
      if (next.done) break;
      trailing += next.value;
    }
    expect(trailing).toContain("<template");
    expect(trailing).toContain("Hello Stream");

    // Simulate browser executing streamed HTML + inline swap script
    const container = document.createElement("div");
    document.body.appendChild(container);
    try {
      container.innerHTML = shell + trailing;
      executeAwaitScripts(container);

      // Pending placeholder MUST be gone and replaced by resolved content
      expect(container.querySelector(".loading")).toBeNull();
      expect(container.querySelector(".ready")?.textContent).toBe("Hello Stream");
      expect(container.querySelector("template[data-tachyon-await]")).toBeNull();
      expect(container.querySelector('script[data-tachyon-await^="swap:"]')).toBeNull();
    } finally {
      container.remove();
    }
  });

  it("supports reorder='resolve' (resolve order) and reorder='preserve' (document order)", async () => {
    const resolveTpl = compileTemplate(
      `<main><await value={first} then="a" pending="<span>P1</span>" reorder="resolve"><p id="a">{a}</p></await><await value={second} then="b" pending="<span>P2</span>" reorder="resolve"><p id="b">{b}</p></await></main>`,
    );
    expect(resolveTpl.ok).toBe(true);
    if (!resolveTpl.ok) return;
    const resolveMod = (await loadJsModule(generateServerStreamModule(resolveTpl.value))) as {
      stream: (scope: Record<string, unknown>) => AsyncIterable<string>;
    };

    const d1 = createDeferred<string>();
    const d2 = createDeferred<string>();
    const itResolve = resolveMod.stream({ first: d1.promise, second: d2.promise })[Symbol.asyncIterator]();

    let shell = "";
    while (!shell.includes("</main>")) {
      shell += (await itResolve.next()).value;
    }
    // Resolve second BEFORE first
    d2.resolve("SecondReady");
    const firstSwap = await itResolve.next();
    let swapChunk1 = firstSwap.value ?? "";
    while (!swapChunk1.includes("SecondReady")) {
      swapChunk1 += (await itResolve.next()).value ?? "";
    }
    expect(swapChunk1).toContain("SecondReady");
    expect(swapChunk1).not.toContain("FirstReady");

    d1.resolve("FirstReady");
    let rest = "";
    while (true) {
      const next = await itResolve.next();
      if (next.done) break;
      rest += next.value;
    }
    expect(rest).toContain("FirstReady");

    // Preserve order: even if second resolves first, first swap arrives before second swap
    const preserveTpl = compileTemplate(
      `<main><await value={first} then="a" pending="<span>P1</span>" reorder="preserve"><p id="a">{a}</p></await><await value={second} then="b" pending="<span>P2</span>" reorder="preserve"><p id="b">{b}</p></await></main>`,
    );
    expect(preserveTpl.ok).toBe(true);
    if (!preserveTpl.ok) return;
    const preserveMod = (await loadJsModule(generateServerStreamModule(preserveTpl.value))) as {
      stream: (scope: Record<string, unknown>) => AsyncIterable<string>;
    };

    const p1 = createDeferred<string>();
    const p2 = createDeferred<string>();
    p2.resolve("SecondFast");
    setTimeout(() => p1.resolve("FirstSlow"), 5);
    let preserveOut = "";
    for await (const chunk of preserveMod.stream({ first: p1.promise, second: p2.promise })) {
      preserveOut += chunk;
    }
    expect(preserveOut.indexOf("FirstSlow")).toBeLessThan(preserveOut.indexOf("SecondFast"));
  });

  it("hydrates <await> templates after swap, before swap (streaming in-flight), and under strict CSP without inline scripts", async () => {
    const compiled = compileTemplate(
      `<main><h1>Title</h1><await value={userPromise} then="user" pending="<p class=wait>Wait</p>" error="<p class=fail>Fail</p>" reorder="resolve"><section><span class="name">{user}</span><button on:click={onClick}>{count()}</button></section></await><footer>{footer()}</footer></main>`,
    );
    expect(compiled.ok).toBe(true);
    if (!compiled.ok) return;

    const clientMod = evaluateGeneratedClientModule(generateClientModule(compiled.value, { reactive: true }));
    const streamMod = (await loadJsModule(generateServerStreamModule(compiled.value))) as {
      stream: (scope: Record<string, unknown>, options?: { nonce?: string }) => AsyncIterable<string>;
    };

    // Case 1: Hydrate BEFORE swap arrives (streaming in-flight)
    {
      const deferred = createDeferred<string>();
      const count = createSignal(1);
      const footer = createSignal("F1");
      const onClick = vi.fn(() => count.update((n) => n + 1));

      const iter = streamMod.stream({ userPromise: deferred.promise, count, footer, onClick })[Symbol.asyncIterator]();
      let shell = "";
      while (!shell.includes("</main>")) shell += (await iter.next()).value;

      const host = document.createElement("div");
      document.body.appendChild(host);
      try {
        host.innerHTML = shell;
        const originalFooter = host.querySelector("footer");
        const hydrated = hydrate(host, clientMod, { userPromise: deferred.promise, count, footer, onClick });
        expect(hydrated.ok).toBe(true);
        if (!hydrated.ok) return;

        // Sibling outside <await> is immediately interactive before promise settles!
        footer.set("F2");
        expect(originalFooter?.textContent).toBe("F2");
        expect(host.querySelector(".wait")).not.toBeNull();

        // Now promise settles and swap chunk arrives
        deferred.resolve("Alice");
        let trailing = "";
        while (true) {
          const next = await iter.next();
          if (next.done) break;
          trailing += next.value;
        }
        const frag = document.createElement("div");
        frag.innerHTML = trailing;
        while (frag.firstChild) host.appendChild(frag.firstChild);
        executeAwaitScripts(host);
        await Promise.resolve();

        // Pending replaced, inner DOM hydrated & interactive!
        expect(host.querySelector(".wait")).toBeNull();
        expect(host.querySelector(".name")?.textContent).toBe("Alice");
        const btn = host.querySelector("button")!;
        expect(btn.textContent).toBe("1");
        btn.click();
        expect(onClick).toHaveBeenCalledTimes(1);
        expect(btn.textContent).toBe("2");

        hydrated.value.dispose();
      } finally {
        host.remove();
      }
    }

    // Case 2: Strict CSP (inline scripts never execute); hydrate() drains pending <template> swaps
    {
      const count = createSignal(5);
      const footer = createSignal("CSP-1");
      const onClick = vi.fn(() => count.update((n) => n + 1));
      let fullHtml = "";
      for await (const chunk of streamMod.stream({
        userPromise: Promise.resolve("Bob"),
        count,
        footer,
        onClick,
      })) {
        fullHtml += chunk;
      }

      const host = document.createElement("div");
      document.body.appendChild(host);
      try {
        // Do NOT execute inline scripts!
        host.innerHTML = fullHtml;
        const hydrated = hydrate(host, clientMod, { userPromise: "Bob", count, footer, onClick });
        expect(hydrated.ok).toBe(true);
        if (!hydrated.ok) return;

        expect(host.querySelector(".wait")).toBeNull();
        expect(host.querySelector(".name")?.textContent).toBe("Bob");
        expect(host.querySelector("template[data-tachyon-await]")).toBeNull();
        host.querySelector("button")?.click();
        expect(onClick).toHaveBeenCalledTimes(1);
        expect(host.querySelector("button")?.textContent).toBe("6");
        footer.set("CSP-2");
        expect(host.querySelector("footer")?.textContent).toBe("CSP-2");

        hydrated.value.dispose();
      } finally {
        host.remove();
      }
    }
  });

  it("enforces CSP nonce validation and rejects unsafe static HTML in pending/fallback/error", async () => {
    expect(
      compileTemplate(`<main><await value={p} then="x" pending="<script>alert(1)</script>"><p>{x}</p></await></main>`)
        .ok,
    ).toBe(false);
    expect(
      compileTemplate(`<main><await value={p} then="x" error="<img src=x onerror=alert(1)>"><p>{x}</p></await></main>`)
        .ok,
    ).toBe(false);
    expect(
      compileTemplate(`<main><await value={p} then="x" pending="<a href=javascript:alert(1)>x</a>"><p>{x}</p></await></main>`)
        .ok,
    ).toBe(false);
    expect(
      compileTemplate(`<main><await value={p} then="x" pending="</template><script>x</script>"><p>{x}</p></await></main>`)
        .ok,
    ).toBe(false);
    expect(
      compileTemplate(`<main><await value={p} then="x" pending="<!--/tachyon-await:a0-->"><p>{x}</p></await></main>`)
        .ok,
    ).toBe(false);

    const valid = compileTemplate(
      `<main><await value={p} then="x" pending="<p>Loading</p>"><p>{x}</p></await></main>`,
    );
    expect(valid.ok).toBe(true);
    if (!valid.ok) return;
    const streamMod = (await loadJsModule(generateServerStreamModule(valid.value))) as {
      stream: (scope: Record<string, unknown>, options?: { nonce?: string }) => AsyncIterable<string>;
    };

    let withNonce = "";
    for await (const chunk of streamMod.stream({ p: Promise.resolve("ok") }, { nonce: "abc123XYZ" })) {
      withNonce += chunk;
    }
    expect(withNonce).toContain(`nonce="abc123XYZ"`);

    await expect(async () => {
      for await (const _ of streamMod.stream({ p: Promise.resolve("ok") }, { nonce: `" onload="alert(1)` })) {
        // should throw
      }
    }).rejects.toThrow();
  });

  it("does not bind after dispose() while pending and handles error rejection cleanly", async () => {
    const compiled = compileTemplate(
      `<main><await value={p} then="x" pending="<p class=wait>Loading</p>" error="<p class=err>Oops</p>" reorder="resolve"><button on:click={onClick}>{x}</button></await></main>`,
    );
    expect(compiled.ok).toBe(true);
    if (!compiled.ok) return;

    const clientMod = evaluateGeneratedClientModule(generateClientModule(compiled.value, { reactive: true }));
    const streamMod = (await loadJsModule(generateServerStreamModule(compiled.value))) as {
      stream: (scope: Record<string, unknown>) => AsyncIterable<string>;
    };

    // Dispose while pending: subsequent swap must NOT bind onClick
    const d1 = createDeferred<string>();
    const onClick = vi.fn();
    const iter = streamMod.stream({ p: d1.promise, onClick })[Symbol.asyncIterator]();
    let shell = "";
    while (!shell.includes("</main>")) shell += (await iter.next()).value;

    const host = document.createElement("div");
    document.body.appendChild(host);
    try {
      host.innerHTML = shell;
      const hydrated = hydrate(host, clientMod, { p: d1.promise, onClick });
      expect(hydrated.ok).toBe(true);
      if (!hydrated.ok) return;

      hydrated.value.dispose();
      d1.resolve("Late");
      let trailing = "";
      while (true) {
        const next = await iter.next();
        if (next.done) break;
        trailing += next.value;
      }
      const frag = document.createElement("div");
      frag.innerHTML = trailing;
      while (frag.firstChild) host.appendChild(frag.firstChild);
      executeAwaitScripts(host);
      await Promise.resolve();

      host.querySelector("button")?.click();
      expect(onClick).not.toHaveBeenCalled();
    } finally {
      host.remove();
    }

    // Rejection with error="..." replaces pending with error HTML and never binds then
    let errHtml = "";
    for await (const chunk of streamMod.stream({ p: Promise.reject(new Error("boom")), onClick })) {
      errHtml += chunk;
    }
    const errHost = document.createElement("div");
    document.body.appendChild(errHost);
    try {
      errHost.innerHTML = errHtml;
      applyPendingAwaitSwaps(errHost);
      const hydrated = hydrate(errHost, clientMod, { p: Promise.resolve("ignored"), onClick });
      expect(hydrated.ok).toBe(true);
      expect(errHost.querySelector(".wait")).toBeNull();
      expect(errHost.querySelector(".err")?.textContent).toBe("Oops");
      expect(errHost.querySelector("button")).toBeNull();
      if (hydrated.ok) hydrated.value.dispose();
    } finally {
      errHost.remove();
    }
  });

  it("covers all generated PICT scenarios for <await> streaming, server sync, and client mount", async () => {
    const embeddedPictTsv = [
      "Target\tValueKind\tPendingMode\tReorder\tHydrateTiming\tDisposeTiming",
      "stream_and_hydrate\tresolved_promise\twith_pending\tresolve\tafter_swap\tafter_settle",
      "stream_and_hydrate\tresolved_promise\twith_pending\tresolve\tbefore_swap\tafter_settle",
      "stream_and_hydrate\tresolved_promise\twith_pending\tpreserve\tcsp_no_inline_script\tafter_settle",
      "stream_and_hydrate\tresolved_promise\twith_pending\tresolve\tbefore_swap\twhile_pending",
      "stream_and_hydrate\trejected_promise\twith_pending\tresolve\tbefore_swap\tafter_settle",
      "stream_and_hydrate\tresolved_promise\tnone\tomitted\tafter_swap\tafter_settle",
      "server_and_hydrate\tsync_value\tnone\tomitted\tafter_swap\tafter_settle",
      "client_mount\tresolved_promise\twith_pending\tomitted\tafter_swap\tafter_settle",
      "client_mount\tresolved_promise\twith_pending\tomitted\tafter_swap\twhile_pending",
      "client_mount\trejected_promise\twith_fallback\tomitted\tafter_swap\tafter_settle",
      "stream_and_hydrate\trejected_promise\twith_fallback\tpreserve\tbefore_swap\twhile_pending",
      "client_mount\tsync_value\twith_fallback\tpreserve\tafter_swap\tafter_settle",
      "stream_and_hydrate\trejected_promise\tnone\tresolve\tcsp_no_inline_script\twhile_pending",
      "server_and_hydrate\tsync_value\twith_pending\tpreserve\tafter_swap\tafter_settle",
      "stream_and_hydrate\tresolved_promise\twith_fallback\tresolve\tcsp_no_inline_script\twhile_pending",
      "stream_and_hydrate\trejected_promise\twith_fallback\tomitted\tbefore_swap\tafter_settle",
      "client_mount\tresolved_promise\tnone\tresolve\tafter_swap\twhile_pending",
      "stream_and_hydrate\tresolved_promise\tnone\tresolve\tbefore_swap\twhile_pending",
      "stream_and_hydrate\tsync_value\tnone\tresolve\tafter_swap\tafter_settle",
      "stream_and_hydrate\trejected_promise\twith_fallback\tomitted\tcsp_no_inline_script\tafter_settle",
      "client_mount\trejected_promise\tnone\tpreserve\tafter_swap\twhile_pending",
      "server_and_hydrate\tsync_value\twith_fallback\tresolve\tafter_swap\tafter_settle",
    ];
    const ledgerPath = "docs.local/coverage-ledger/await-streaming.generated.tsv";
    if (existsSync(ledgerPath)) {
      expect(readFileSync(ledgerPath, "utf8").trim().split("\n")).toEqual(embeddedPictTsv);
    }
    const rows = embeddedPictTsv.slice(1).map((line) => {
      const [target, valueKind, pendingMode, reorder, hydrateTiming, disposeTiming] = line.split("\t");
      return { target, valueKind, pendingMode, reorder, hydrateTiming, disposeTiming };
    });
    expect(rows.length).toBeGreaterThanOrEqual(20);

    for (const row of rows) {
      const pendingAttr =
        row.pendingMode === "with_pending"
          ? ` pending="<span class=p>Loading</span>"`
          : row.pendingMode === "with_fallback"
            ? ` fallback="<span class=p>Loading</span>"`
            : "";
      const reorderAttr = row.reorder === "omitted" ? "" : ` reorder="${row.reorder}"`;
      const tpl = `<main><await value={val} then="data"${pendingAttr} error="<span class=e>Err</span>"${reorderAttr}><button on:click={hit}>{data}</button></await><em>{after()}</em></main>`;
      const compiled = compileTemplate(tpl);
      expect(compiled.ok, JSON.stringify(row)).toBe(true);
      if (!compiled.ok) continue;

      const clientMod = evaluateGeneratedClientModule(generateClientModule(compiled.value, { reactive: true }));
      const serverMod = (await loadJsModule(generateServerModule(compiled.value))) as {
        render: (scope: Record<string, unknown>) => string;
      };
      const streamMod = (await loadJsModule(generateServerStreamModule(compiled.value))) as {
        stream: (scope: Record<string, unknown>) => AsyncIterable<string>;
      };

      const after = createSignal("A1");
      const hit = vi.fn();
      const host = document.createElement("div");
      document.body.appendChild(host);
      try {
        if (row.target === "server_and_hydrate") {
          host.innerHTML = serverMod.render({ val: "SyncVal", after, hit });
          const hydrated = hydrate(host, clientMod, { val: "SyncVal", after, hit });
          expect(hydrated.ok, JSON.stringify(row)).toBe(true);
          if (!hydrated.ok) continue;
          expect(host.querySelector("button")?.textContent).toBe("SyncVal");
          host.querySelector("button")?.click();
          expect(hit).toHaveBeenCalledTimes(1);
          after.set("A2");
          expect(host.querySelector("em")?.textContent).toBe("A2");
          hydrated.value.dispose();
        } else if (row.target === "client_mount") {
          const deferred = createDeferred<string>();
          const val = row.valueKind === "sync_value" ? "SyncMount" : deferred.promise;
          const handle = mount(host, clientMod, { val, after, hit });
          if (row.valueKind === "sync_value") {
            expect(host.querySelector("button")?.textContent).toBe("SyncMount");
          } else {
            if (row.pendingMode !== "none") expect(host.querySelector(".p")?.textContent).toBe("Loading");
            if (row.disposeTiming === "while_pending") {
              handle.dispose();
              if (row.valueKind === "resolved_promise") deferred.resolve("Late");
              else deferred.reject(new Error("late"));
              await Promise.resolve();
              await Promise.resolve();
              expect(host.querySelector("button")).toBeNull();
              continue;
            }
            if (row.valueKind === "resolved_promise") deferred.resolve("AsyncMount");
            else deferred.reject(new Error("fail"));
            await Promise.resolve();
            await Promise.resolve();
            if (row.valueKind === "resolved_promise") {
              expect(host.querySelector(".p")).toBeNull();
              expect(host.querySelector("button")?.textContent).toBe("AsyncMount");
              host.querySelector("button")?.click();
              expect(hit).toHaveBeenCalledTimes(1);
            } else {
              expect(host.querySelector(".p")).toBeNull();
              expect(host.querySelector(".e")?.textContent).toBe("Err");
            }
          }
          handle.dispose();
        } else {
          // stream_and_hydrate
          const deferred = createDeferred<string>();
          const val = row.valueKind === "sync_value" ? "SyncStream" : deferred.promise;
          const iter = streamMod.stream({ val, after, hit })[Symbol.asyncIterator]();
          const usesDeferredSwap =
            row.valueKind !== "sync_value" && (row.pendingMode !== "none" || row.reorder === "resolve");

          if (row.hydrateTiming === "before_swap" && usesDeferredSwap) {
            let shell = "";
            while (!shell.includes("</main>")) shell += (await iter.next()).value;
            host.innerHTML = shell;
            const hydrated = hydrate(host, clientMod, { val, after, hit });
            expect(hydrated.ok, JSON.stringify(row)).toBe(true);
            if (!hydrated.ok) continue;

            if (row.disposeTiming === "while_pending") {
              hydrated.value.dispose();
            }
            if (row.valueKind === "resolved_promise") deferred.resolve("Resolved");
            else deferred.reject(new Error("fail"));
            let trailing = "";
            while (true) {
              const next = await iter.next();
              if (next.done) break;
              trailing += next.value;
            }
            const frag = document.createElement("div");
            frag.innerHTML = trailing;
            while (frag.firstChild) host.appendChild(frag.firstChild);
            executeAwaitScripts(host);
            await Promise.resolve();
            await Promise.resolve();

            if (row.disposeTiming === "while_pending") {
              host.querySelector("button")?.click();
              expect(hit).not.toHaveBeenCalled();
            } else if (row.valueKind === "resolved_promise") {
              expect(host.querySelector(".p")).toBeNull();
              expect(host.querySelector("button")?.textContent).toBe("Resolved");
              host.querySelector("button")?.click();
              expect(hit).toHaveBeenCalledTimes(1);
              hydrated.value.dispose();
            } else {
              expect(host.querySelector(".p")).toBeNull();
              expect(host.querySelector(".e")?.textContent).toBe("Err");
              hydrated.value.dispose();
            }
          } else {
            if (row.valueKind === "resolved_promise") deferred.resolve("Resolved");
            else if (row.valueKind === "rejected_promise") deferred.reject(new Error("fail"));
            let full = "";
            for await (const chunk of { [Symbol.asyncIterator]: () => iter }) full += chunk;
            host.innerHTML = full;
            if (row.hydrateTiming === "after_swap") executeAwaitScripts(host);
            const clientVal = row.valueKind === "sync_value" ? "SyncStream" : deferred.promise;
            const hydrated = hydrate(host, clientMod, { val: clientVal, after, hit });
            expect(hydrated.ok, JSON.stringify(row)).toBe(true);
            if (!hydrated.ok) continue;
            await Promise.resolve();
            await Promise.resolve();

            if (row.valueKind === "rejected_promise") {
              expect(host.querySelector(".p")).toBeNull();
              expect(host.querySelector(".e")?.textContent).toBe("Err");
              expect(host.querySelector("button")).toBeNull();
            } else {
              expect(host.querySelector(".p")).toBeNull();
              expect(host.querySelector("button")?.textContent).toBe(
                row.valueKind === "sync_value" ? "SyncStream" : "Resolved",
              );
              host.querySelector("button")?.click();
              expect(hit).toHaveBeenCalledTimes(1);
            }
            after.set("A2");
            expect(host.querySelector("em")?.textContent).toBe("A2");
            hydrated.value.dispose();
          }
        }
      } finally {
        host.remove();
      }
    }
  });

  it("rejects uppercase tags, HTML entity URLs, and forbidden elements in static pending/error HTML", () => {
    const cases = [
      `<main><await value={p} then="v" pending="<Img onerror=alert(1)>"><p>{v}</p></await></main>`,
      `<main><await value={p} then="v" pending="<A href='javascript:alert(1)'>x</A>"><p>{v}</p></await></main>`,
      `<main><await value={p} then="v" pending="<a href='&#106;avascript:alert(1)'>x</a>"><p>{v}</p></await></main>`,
      `<main><await value={p} then="v" error="<a href='&#x6a;avascript:alert(1)'>x</a>"><p>{v}</p></await></main>`,
      `<main><await value={p} then="v" pending="<iframe src='https://example.com'></iframe>"><p>{v}</p></await></main>`,
      `<main><await value={p} then="v" pending="<svg><set attributeName='href' to='javascript:alert(1)'/></svg>"><p>{v}</p></await></main>`,
      `<await value={p} then="v"><p>{v}</p></await>`,
    ];
    for (const source of cases) {
      const result = compileTemplate(source);
      expect(result.ok, source).toBe(false);
    }
  });

  it("isolates runtime await IDs across <for> rows and repeated child components even under out-of-order resolution", async () => {
    const rowTemplate = compileTemplate(
      `<ul><for each={rows} key={row.id}><li><await value={row.promise} then="text" pending="<span class=w>...</span>" reorder="resolve"><button on:click={row.onClick}>{text}</button></await></li></for></ul>`,
    );
    if (!rowTemplate.ok) throw new Error(rowTemplate.error.message);

    const streamMod = (await loadJsModule(generateServerStreamModule(rowTemplate.value))) as {
      stream: (scope: Record<string, unknown>) => AsyncIterable<string>;
    };
    const clientMod = await evaluateGeneratedClientModule(generateClientModule(rowTemplate.value, { reactive: true }));

    const d1 = createDeferred<string>();
    const d2 = createDeferred<string>();
    const hits: string[] = [];
    const rows = [
      { id: 1, promise: d1.promise, onClick: () => hits.push("row1") },
      { id: 2, promise: d2.promise, onClick: () => hits.push("row2") },
    ];

    const iter = streamMod.stream({ rows })[Symbol.asyncIterator]();
    let shell = "";
    while (!shell.includes("</ul>")) shell += (await iter.next()).value;

    const host = document.createElement("div");
    document.body.appendChild(host);
    try {
      host.innerHTML = shell;
      const hydrated = hydrate(host, clientMod, { rows });
      expect(hydrated.ok).toBe(true);
      if (!hydrated.ok) return;

      // Resolve row 2 BEFORE row 1
      d2.resolve("Second");
      d1.resolve("First");
      let trailing = "";
      while (true) {
        const next = await iter.next();
        if (next.done) break;
        trailing += next.value;
      }
      const frag = document.createElement("div");
      frag.innerHTML = trailing;
      while (frag.firstChild) host.appendChild(frag.firstChild);
      executeAwaitScripts(host);
      await Promise.resolve();
      await Promise.resolve();

      const buttons = Array.from(host.querySelectorAll("button"));
      expect(buttons.map((b) => b.textContent)).toEqual(["First", "Second"]);
      buttons[1]?.click();
      buttons[0]?.click();
      expect(hits).toEqual(["row2", "row1"]);

      // A duplicate late swap targeting a0 must not overwrite already-resolved/updated DOM.
      buttons[0]!.textContent = "ClientUpdated";
      const dup = document.createElement("template");
      dup.setAttribute("data-tachyon-await", "a0");
      dup.setAttribute("data-status", "resolved");
      dup.innerHTML = "<button>Stale</button>";
      host.appendChild(dup);
      expect(applyPendingAwaitSwaps(host)).toBe(0);
      expect(host.querySelector("button")?.textContent).toBe("ClientUpdated");

      hydrated.value.dispose();
    } finally {
      host.remove();
    }

    // Two instances of the same child component with deferred <await>
    const childCompiled = compileTemplate(
      `<article><await value={promise} then="body" pending="<em>Wait</em>" reorder="resolve"><button on:click={onClick}>{body}</button></await></article>`,
    );
    if (!childCompiled.ok) throw new Error(childCompiled.error.message);
    const childStream = (await loadJsModule(generateServerStreamModule(childCompiled.value))) as {
      stream: (scope: Record<string, unknown>, options?: unknown) => AsyncIterable<string>;
    };
    const childClient = await evaluateGeneratedClientModule(
      generateClientModule(childCompiled.value, { reactive: true }),
    );
    const AsyncCard = createTemplateComponent({
      client: childClient,
      stream: childStream.stream,
    });

    const parentCompiled = compileTemplate(
      `<section><AsyncCard promise={p1} onClick={c1} /><AsyncCard promise={p2} onClick={c2} /></section>`,
    );
    if (!parentCompiled.ok) throw new Error(parentCompiled.error.message);
    const parentStream = (await loadJsModule(generateServerStreamModule(parentCompiled.value))) as {
      stream: (scope: Record<string, unknown>) => AsyncIterable<string>;
    };
    const parentClient = await evaluateGeneratedClientModule(
      generateClientModule(parentCompiled.value, { reactive: true }),
    );

    const cp1 = createDeferred<string>();
    const cp2 = createDeferred<string>();
    const cardHits: string[] = [];
    const parentScope = {
      AsyncCard,
      p1: cp1.promise,
      p2: cp2.promise,
      c1: () => cardHits.push("card1"),
      c2: () => cardHits.push("card2"),
    };

    const pIter = parentStream.stream(parentScope)[Symbol.asyncIterator]();
    let pShell = "";
    while (!pShell.includes("</section>")) pShell += (await pIter.next()).value;
    // Child component must not leak bootstrap/template tags inside <!--tachyon-component-->
    expect(pShell).not.toContain("<script");
    expect(pShell).not.toContain("<template");

    const host2 = document.createElement("div");
    document.body.appendChild(host2);
    try {
      host2.innerHTML = pShell;
      const hydrated = hydrate(host2, parentClient, parentScope);
      expect(hydrated.ok).toBe(true);
      if (!hydrated.ok) return;

      cp2.resolve("CardTwo");
      cp1.resolve("CardOne");
      let pTrailing = "";
      while (true) {
        const next = await pIter.next();
        if (next.done) break;
        pTrailing += next.value;
      }
      const frag = document.createElement("div");
      frag.innerHTML = pTrailing;
      while (frag.firstChild) host2.appendChild(frag.firstChild);
      executeAwaitScripts(host2);
      await Promise.resolve();
      await Promise.resolve();

      const btns = Array.from(host2.querySelectorAll("button"));
      expect(btns.map((b) => b.textContent)).toEqual(["CardOne", "CardTwo"]);
      btns[1]?.click();
      btns[0]?.click();
      expect(cardHits).toEqual(["card2", "card1"]);
      hydrated.value.dispose();
    } finally {
      host2.remove();
    }
  });

  it("drains nested deferred <await>, preserves true completion order for pre-settled resolve, and avoids head-of-line blocking between resolve and preserve", async () => {
    // 1. Nested deferred <await>
    const nestedCompiled = compileTemplate(
      `<main><await value={outer} then="o" pending="<span>O-Wait</span>" reorder="resolve"><section><p>{o}</p><await value={inner} then="i" pending="<span>I-Wait</span>" reorder="resolve"><b>{i}</b></await></section></await></main>`,
    );
    if (!nestedCompiled.ok) throw new Error(nestedCompiled.error.message);
    const nestedStream = (await loadJsModule(generateServerStreamModule(nestedCompiled.value))) as {
      stream: (scope: Record<string, unknown>) => AsyncIterable<string>;
    };

    const outer = createDeferred<string>();
    const inner = createDeferred<string>();
    const chunks: string[] = [];
    const drainPromise = (async () => {
      for await (const chunk of nestedStream.stream({ outer: outer.promise, inner: inner.promise })) {
        chunks.push(chunk);
      }
    })();
    await Promise.resolve();
    outer.resolve("OuterDone");
    await Promise.resolve();
    await Promise.resolve();
    inner.resolve("InnerDone");
    await drainPromise;
    const html = chunks.join("");
    expect(html).toContain(`OuterDone`);
    expect(html).toContain(`InnerDone`);
    expect(html).toMatch(/data-tachyon-await="a\d+_1"/);

    // 2. Pre-settled reorder="resolve" preserves actual settlement order + mixed resolve/preserve doesn't head-of-line block
    const mixedCompiled = compileTemplate(
      `<main><await value={slowResolve} then="r1" pending="R1" reorder="resolve"><p>{r1}</p></await><await value={fastResolve} then="r2" pending="R2" reorder="resolve"><p>{r2}</p></await><await value={fastPreserve} then="p1" pending="P1" reorder="preserve"><p>{p1}</p></await></main>`,
    );
    if (!mixedCompiled.ok) throw new Error(mixedCompiled.error.message);
    const mixedStream = (await loadJsModule(generateServerStreamModule(mixedCompiled.value))) as {
      stream: (scope: Record<string, unknown>) => AsyncIterable<string>;
    };
    const slowResolve = createDeferred<string>();
    const fastResolve = createDeferred<string>();
    const fastPreserve = createDeferred<string>();
    const iter = mixedStream.stream({
      slowResolve: slowResolve.promise,
      fastResolve: fastResolve.promise,
      fastPreserve: fastPreserve.promise,
    })[Symbol.asyncIterator]();

    // Shell flushes first
    let shell = "";
    while (!shell.includes("</main>")) shell += (await iter.next()).value;
    // Settle fastResolve and fastPreserve BEFORE slowResolve
    fastResolve.resolve("FastR2");
    fastPreserve.resolve("FastP1");
    await Promise.resolve();
    await Promise.resolve();

    const emittedBeforeSlow: string[] = [];
    // Bootstrap + FastR2 + FastP1 must stream without waiting on slowResolve!
    for (let i = 0; i < 3; i++) {
      emittedBeforeSlow.push((await iter.next()).value);
    }
    const partial = emittedBeforeSlow.join("");
    expect(partial).toContain("FastR2");
    expect(partial).toContain("FastP1");
    expect(partial.indexOf("FastR2")).toBeLessThan(partial.indexOf("FastP1"));

    slowResolve.resolve("SlowR1");
    const last = (await iter.next()).value;
    expect(last).toContain("SlowR1");
  });

  it("applies strict-CSP chunks arriving AFTER hydration via MutationObserver and cleans up async nested <if> handlers on dispose", async () => {
    const compiled = compileTemplate(
      `<main><await value={p} then="v" pending="<p class=wait>Wait</p>" reorder="resolve"><if test={show}><button on:click={hit}>{v}:{label}</button></if></await></main>`,
    );
    if (!compiled.ok) throw new Error(compiled.error.message);
    const streamMod = (await loadJsModule(generateServerStreamModule(compiled.value))) as {
      stream: (scope: Record<string, unknown>) => AsyncIterable<string>;
    };
    const clientMod = await evaluateGeneratedClientModule(generateClientModule(compiled.value, { reactive: true }));

    const d = createDeferred<string>();
    const store = createStore({ label: "Before", show: true });
    const hit = vi.fn();
    const scope = new Proxy(store as Record<string, unknown>, {
      get: (t, prop) => (prop === "p" ? d.promise : prop === "hit" ? hit : Reflect.get(t, prop)),
    });

    const iter = streamMod.stream({ p: d.promise, show: true, label: "Before", hit })[Symbol.asyncIterator]();
    let shell = "";
    while (!shell.includes("</main>")) shell += (await iter.next()).value;

    const host = document.createElement("div");
    document.body.appendChild(host);
    try {
      host.innerHTML = shell;
      // Hydrate BEFORE chunk arrives, under strict CSP (never call executeAwaitScripts)
      const hydrated = hydrate(host, clientMod, scope);
      expect(hydrated.ok).toBe(true);
      if (!hydrated.ok) return;

      d.resolve("Ready");
      let trailing = "";
      while (true) {
        const next = await iter.next();
        if (next.done) break;
        trailing += next.value;
      }
      // Append trailing <template> WITHOUT executing any inline <script>
      const frag = document.createElement("div");
      frag.innerHTML = trailing;
      while (frag.firstChild) host.appendChild(frag.firstChild);

      // Wait for MutationObserver + promise microtasks
      await new Promise((r) => setTimeout(r, 0));
      await Promise.resolve();

      expect(host.querySelector(".wait")).toBeNull();
      const btn = host.querySelector("button");
      expect(btn?.textContent).toBe("Ready:Before");

      // Parent store reactivity propagates into already-resolved <await> body!
      store.label = "After";
      expect(btn?.textContent).toBe("Ready:After");

      btn?.click();
      expect(hit).toHaveBeenCalledTimes(1);

      // Dispose must clean up listeners inside async-resolved nested <if>
      hydrated.value.dispose();
      btn?.click();
      expect(hit).toHaveBeenCalledTimes(1);
    } finally {
      host.remove();
    }
  });

  it("supports non-reactive nested <await>, direct <for> inside <await>, and interpreter/codegen sync SSR ID parity", async () => {
    // 1. Non-reactive <if> containing <await> must not reference __tachyonEffect
    const nonReactiveCompiled = compileTemplate(
      `<main><if test={open}><await value={p} then="v"><p>{v}</p></await></if></main>`,
    );
    if (!nonReactiveCompiled.ok) throw new Error(nonReactiveCompiled.error.message);
    const nonReactiveCode = generateClientModule(nonReactiveCompiled.value, { reactive: false });
    expect(nonReactiveCode).not.toContain("__tachyonEffect");
    const nonReactiveMod = await evaluateGeneratedClientModule(nonReactiveCode);
    const h1 = document.createElement("div");
    const m1 = mount(h1, nonReactiveMod, { open: true, p: "StaticVal" });
    expect(h1.querySelector("p")?.textContent).toBe("StaticVal");
    m1.dispose();

    // 2. Direct <for> inside <await> mounts and hydrates rows
    const directForCompiled = compileTemplate(
      `<ul><await value={itemsPromise} then="items" pending="<li>Wait</li>"><for each={items} key={item.id}><li>{item.name}</li></for></await></ul>`,
    );
    if (!directForCompiled.ok) throw new Error(directForCompiled.error.message);
    const directForClient = await evaluateGeneratedClientModule(
      generateClientModule(directForCompiled.value, { reactive: true }),
    );
    const h2 = document.createElement("div");
    const itemsDef = createDeferred<Array<{ id: number; name: string }>>();
    const m2 = mount(h2, directForClient, { itemsPromise: itemsDef.promise });
    expect(h2.querySelector("li")?.textContent).toBe("Wait");
    itemsDef.resolve([
      { id: 1, name: "Alpha" },
      { id: 2, name: "Beta" },
    ]);
    await Promise.resolve();
    await Promise.resolve();
    expect(Array.from(h2.querySelectorAll("li")).map((el) => el.textContent)).toEqual(["Alpha", "Beta"]);
    m2.dispose();

    // 3. Sync SSR interpreter vs generated module ID parity when preceding <if> is false
    const parityCompiled = compileTemplate(
      `<main><if test={show}><await value={a} then="x"><p>{x}</p></await></if><await value={b} then="y"><span class="y">{y}</span></await></main>`,
    );
    if (!parityCompiled.ok) throw new Error(parityCompiled.error.message);
    const serverGen = (await loadJsModule(generateServerModule(parityCompiled.value))) as {
      render: (scope: Record<string, unknown>) => string;
    };
    const interpHtml = renderServerTemplate(parityCompiled.value, { show: false, a: "A", b: "B" });
    const genHtml = serverGen.render({ show: false, a: "A", b: "B" });
    expect(interpHtml).toBe(genHtml);
    expect(interpHtml).toContain("<!--tachyon-await:a1-->");
  });

  it("isolates independent root streams in the same document and ignores stale SSR chunks after client promise replacement", async () => {
    const compiled = compileTemplate(
      `<section><await value={p} then="v" pending="<span class=w>Wait</span>" reorder="resolve"><button on:click={hit}>{v}</button></await></section>`,
    );
    if (!compiled.ok) throw new Error(compiled.error.message);
    const streamMod = (await loadJsModule(generateServerStreamModule(compiled.value))) as {
      stream: (scope: Record<string, unknown>) => AsyncIterable<string>;
    };
    const clientMod = await evaluateGeneratedClientModule(generateClientModule(compiled.value, { reactive: true }));

    const d1 = createDeferred<string>();
    const d2 = createDeferred<string>();
    const hit1 = vi.fn();
    const hit2 = vi.fn();
    const it1 = streamMod.stream({ p: d1.promise, hit: hit1 })[Symbol.asyncIterator]();
    const it2 = streamMod.stream({ p: d2.promise, hit: hit2 })[Symbol.asyncIterator]();
    let s1 = "";
    while (!s1.includes("</section>")) s1 += (await it1.next()).value;
    let s2 = "";
    while (!s2.includes("</section>")) s2 += (await it2.next()).value;

    const host = document.createElement("div");
    const box1 = document.createElement("div");
    const box2 = document.createElement("div");
    box1.innerHTML = s1;
    box2.innerHTML = s2;
    host.append(box1, box2);
    document.body.appendChild(host);
    try {
      const h1 = hydrate(box1, clientMod, { p: d1.promise, hit: hit1 });
      const h2 = hydrate(box2, clientMod, { p: d2.promise, hit: hit2 });
      expect(h1.ok && h2.ok).toBe(true);
      if (!h1.ok || !h2.ok) return;

      // Resolve stream 2 BEFORE stream 1
      d2.resolve("SecondStream");
      let t2 = "";
      while (true) {
        const next = await it2.next();
        if (next.done) break;
        t2 += next.value;
      }
      const f2 = document.createElement("div");
      f2.innerHTML = t2;
      while (f2.firstChild) host.appendChild(f2.firstChild);
      executeAwaitScripts(host);

      d1.resolve("FirstStream");
      let t1 = "";
      while (true) {
        const next = await it1.next();
        if (next.done) break;
        t1 += next.value;
      }
      const f1 = document.createElement("div");
      f1.innerHTML = t1;
      while (f1.firstChild) host.appendChild(f1.firstChild);
      executeAwaitScripts(host);

      await Promise.resolve();
      await Promise.resolve();

      expect(box1.querySelector("button")?.textContent).toBe("FirstStream");
      expect(box2.querySelector("button")?.textContent).toBe("SecondStream");
      box1.querySelector("button")?.click();
      box2.querySelector("button")?.click();
      expect(hit1).toHaveBeenCalledTimes(1);
      expect(hit2).toHaveBeenCalledTimes(1);
      h1.value.dispose();
      h2.value.dispose();
    } finally {
      host.remove();
    }

    // Promise replacement after hydration must not be overwritten by a late SSR chunk
    const oldDef = createDeferred<string>();
    const newDef = createDeferred<string>();
    const pSig = createSignal<Promise<string>>(oldDef.promise);
    const it3 = streamMod.stream({ p: oldDef.promise, hit: vi.fn() })[Symbol.asyncIterator]();
    let s3 = "";
    while (!s3.includes("</section>")) s3 += (await it3.next()).value;
    const host3 = document.createElement("div");
    host3.innerHTML = s3;
    document.body.appendChild(host3);
    try {
      const h3 = hydrate(host3, clientMod, { p: pSig, hit: vi.fn() });
      expect(h3.ok).toBe(true);
      if (!h3.ok) return;
      // Switch to a brand new client-side pending promise before old SSR chunk arrives
      pSig.set(newDef.promise);
      oldDef.resolve("StaleSSR");
      let t3 = "";
      while (true) {
        const next = await it3.next();
        if (next.done) break;
        t3 += next.value;
      }
      const f3 = document.createElement("div");
      f3.innerHTML = t3;
      while (f3.firstChild) host3.appendChild(f3.firstChild);
      executeAwaitScripts(host3);
      await Promise.resolve();
      expect(host3.textContent).not.toContain("StaleSSR");
      newDef.resolve("FreshClient");
      await Promise.resolve();
      await Promise.resolve();
      expect(host3.querySelector("button")?.textContent).toBe("FreshClient");
      h3.value.dispose();
    } finally {
      host3.remove();
    }
  });

  it("handles inline await & child component inside deferred await, parent-before-child ordering, body errors, strict-CSP split template, unbalanced HTML, transparent root, frozen scope, and partial bind rollback", async () => {
    // 1. Deferred <await> containing BOTH a fast nested deferred <await>, a slower inline <await>, and a child component
    const leafCompiled = compileTemplate(`<em>{label}</em>`);
    if (!leafCompiled.ok) throw new Error(leafCompiled.error.message);
    const leafStream = (await loadJsModule(generateServerStreamModule(leafCompiled.value))) as {
      stream: (scope: Record<string, unknown>, options?: unknown) => AsyncIterable<string>;
    };
    const Leaf = { stream: leafStream.stream };
    const complexCompiled = compileTemplate(
      `<main><await value={outer} then="o" pending="<span>O</span>" reorder="resolve"><div><await value={fastChild} then="c" pending="<span>C</span>" reorder="resolve"><b>{c}</b></await><await value={slowInline} then="s"><i>{s}</i></await><Leaf label={o} /></div></await></main>`,
    );
    if (!complexCompiled.ok) throw new Error(complexCompiled.error.message);
    const complexStream = (await loadJsModule(generateServerStreamModule(complexCompiled.value))) as {
      stream: (scope: Record<string, unknown>) => AsyncIterable<string>;
    };
    const outerDef = createDeferred<string>();
    const fastChildDef = createDeferred<string>();
    const slowInlineDef = createDeferred<string>();
    const complexChunks: string[] = [];
    const runComplex = (async () => {
      for await (const chunk of complexStream.stream({
        outer: outerDef.promise,
        fastChild: fastChildDef.promise,
        slowInline: slowInlineDef.promise,
        Leaf,
      })) {
        complexChunks.push(chunk);
      }
    })();
    outerDef.resolve("OuterLabel");
    fastChildDef.resolve("FastChild");
    await Promise.resolve();
    await Promise.resolve();
    slowInlineDef.resolve("SlowInline");
    await runComplex;
    const complexHtml = complexChunks.join("");
    expect(complexHtml).toContain("OuterLabel");
    expect(complexHtml).toContain("SlowInline");
    expect(complexHtml).toContain("FastChild");
    // Parent chunk MUST be emitted before child chunk
    expect(complexHtml.indexOf("OuterLabel")).toBeLessThan(complexHtml.indexOf("FastChild"));

    // 2. Exception thrown in deferred body rejects the stream cleanly (no hang / no unhandled rejection)
    const bodyThrowCompiled = compileTemplate(
      `<main><await value={outer} then="o" pending="<span>W</span>" reorder="resolve"><await value={innerFail} then="i"><p>{i}</p></await></await></main>`,
    );
    if (!bodyThrowCompiled.ok) throw new Error(bodyThrowCompiled.error.message);
    const bodyThrowStream = (await loadJsModule(generateServerStreamModule(bodyThrowCompiled.value))) as {
      stream: (scope: Record<string, unknown>) => AsyncIterable<string>;
    };
    await expect(
      (async () => {
        for await (const _chunk of bodyThrowStream.stream({
          outer: Promise.resolve("ok"),
          innerFail: Promise.reject(new Error("body-boom")),
        })) {
          // drain
        }
      })(),
    ).rejects.toThrow("body-boom");

    // 3. Strict-CSP MutationObserver waits until template is complete (trailing swap script present) before consuming
    const cspCompiled = compileTemplate(
      `<main><await value={p} then="v" pending="<p class=wait>Wait</p>" reorder="resolve"><span class="done">{v}</span></await></main>`,
    );
    if (!cspCompiled.ok) throw new Error(cspCompiled.error.message);
    const cspClient = await evaluateGeneratedClientModule(generateClientModule(cspCompiled.value, { reactive: true }));
    const cspHost = document.createElement("div");
    cspHost.innerHTML = `<main><!--tachyon-await:a99_0--><!--td:await:pending--><p class="wait">Wait</p><!--/tachyon-await:a99_0--></main>`;
    document.body.appendChild(cspHost);
    try {
      const h = hydrate(cspHost, cspClient, { p: Promise.resolve("CompleteBody") });
      expect(h.ok).toBe(true);
      if (!h.ok) return;
      // Step 1: Append EMPTY <template> (simulating open tag parsed before body arrives)
      const tpl = document.createElement("template");
      tpl.setAttribute("data-tachyon-await", "a99_0");
      tpl.setAttribute("data-status", "resolved");
      cspHost.appendChild(tpl);
      await new Promise((r) => setTimeout(r, 0));
      // Must NOT have consumed the incomplete empty template yet!
      expect(cspHost.querySelector(".wait")).not.toBeNull();
      expect(cspHost.contains(tpl)).toBe(true);

      // Step 2: Populate template content and append trailing swap script (closing tag parsed)
      tpl.innerHTML = `<span class="done">CompleteBody</span>`;
      const sc = document.createElement("script");
      sc.setAttribute("data-tachyon-await", "swap:a99_0");
      cspHost.appendChild(sc);
      await new Promise((r) => setTimeout(r, 0));
      await Promise.resolve();
      expect(cspHost.querySelector(".wait")).toBeNull();
      expect(cspHost.querySelector(".done")?.textContent).toBe("CompleteBody");
      h.value.dispose();
    } finally {
      cspHost.remove();
    }

    // 4. Unbalanced static HTML & transparent <component> root wrapping <await> are rejected at compile time
    expect(compileTemplate(`<main><await value={p} then="v" pending="<span>Wait"><p>{v}</p></await></main>`).ok).toBe(
      false,
    );
    expect(compileTemplate(`<main><await value={p} then="v" pending="</span>"><p>{v}</p></await></main>`).ok).toBe(
      false,
    );
    expect(compileTemplate(`<component name="App"><await value={p} then="v"><p>{v}</p></await></component>`).ok).toBe(
      false,
    );

    // 5. Frozen parent scope with colliding property name shadows cleanly
    const frozenCompiled = compileTemplate(`<main><await value={p} then="v"><p>{v}</p></await></main>`);
    if (!frozenCompiled.ok) throw new Error(frozenCompiled.error.message);
    const frozenClient = await evaluateGeneratedClientModule(
      generateClientModule(frozenCompiled.value, { reactive: true }),
    );
    const frozenHost = document.createElement("div");
    const frozenHandle = mount(frozenHost, frozenClient, Object.freeze({ p: "Resolved", v: "Old" }));
    expect(frozenHost.querySelector("p")?.textContent).toBe("Resolved");
    frozenHandle.dispose();

    // 6. Partial bind failure inside <await> cleans up earlier listeners
    const rollbackCompiled = compileTemplate(
      `<main><await value={p} then="v"><div><button on:click={hit}>Click</button><span>{v.missing.deep}</span></div></await></main>`,
    );
    if (!rollbackCompiled.ok) throw new Error(rollbackCompiled.error.message);
    const rollbackClient = await evaluateGeneratedClientModule(
      generateClientModule(rollbackCompiled.value, { reactive: true }),
    );
    const rollbackHost = document.createElement("div");
    rollbackHost.innerHTML = `<main><!--tachyon-await:a0--><div><button>Click</button><span>SSR</span></div><!--/tachyon-await:a0--></main>`;
    const origBtn = rollbackHost.querySelector("button");
    const hit = vi.fn();
    const rollbackRes = hydrate(rollbackHost, rollbackClient, { p: {}, hit });
    expect(rollbackRes.ok).toBe(false);
    expect(rollbackHost.querySelector("button")).toBe(origBtn);
    origBtn?.click();
    expect(hit).not.toHaveBeenCalled();
  });
});
