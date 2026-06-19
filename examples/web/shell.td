<div class="shell">
  <header class="topbar">
    <div>
      <h1>Tachyon DOM</h1>
      <p>HTML-first compiler, store state, hydrate boundary markers, keyed list updates, and chunk streaming.</p>
    </div>
    <button id="rerender" class="secondary">Re-stream SSR</button>
  </header>
  <section class="grid">
    <article class="panel">
      <h2>Browser Preview</h2>
      <div id="preview" class="preview" data-testid="preview"></div>
      <div class="controls">
        <button id="increment" data-testid="increment">Increment store</button>
        <button id="hydrate" class="secondary" data-testid="hydrate">Hydrate boundary</button>
        <button id="prepend" class="secondary" data-testid="prepend">Prepend row</button>
        <button id="rotate" class="secondary" data-testid="rotate">Rotate rows</button>
        <button id="toggle" class="secondary" data-testid="toggle">Toggle active</button>
      </div>
    </article>
    <aside class="panel">
      <h2>Runtime State</h2>
      <div class="metrics">
        <div class="metric"><span>Count</span><strong id="metric-count" data-testid="metric-count">0</strong></div>
        <div class="metric"><span>Rows</span><strong id="metric-rows" data-testid="metric-rows">0</strong></div>
        <div class="metric"><span>Hydrate</span><strong id="metric-hydrate" data-testid="metric-hydrate">0</strong></div>
        <div class="metric"><span>Hydrated</span><strong id="metric-hydrated" data-testid="metric-hydrated">no</strong></div>
      </div>
      <h2>Stream Chunks</h2>
      <div id="chunks" class="chunk-list" data-testid="stream-chunks"></div>
    </aside>
  </section>
  <section class="grid">
    <article class="panel">
      <h2>Template</h2>
      <pre class="code">{templateSource}</pre>
    </article>
    <article class="panel">
      <h2>Compiler IR</h2>
      <pre class="code" data-testid="compiler-ir">{compilerIr}</pre>
    </article>
    <article class="panel">
      <h2>Generated Client Shape</h2>
      <pre class="code" data-testid="generated-client">{generatedClientModule}</pre>
    </article>
  </section>
</div>
