import { existsSync, readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import {
  compileTemplate,
  generateClientModule,
  generateServerModule,
  generateServerStreamModule,
} from "../src/compiler";
import { createSignal, hydrate, mount } from "../src/index";
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
});
