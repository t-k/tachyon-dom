<script>
export const scope = {
  active: true,
  count: 1,
  form: { enabled: true, name: "Ada" },
  initialCount: 1,
  messagePromise: Promise.resolve("Stream ready"),
  panelWidth: "64%",
  refs: {},
  rows: [{ id: 1, label: "Hydration shorthand" }],
  selectedId: 1,
  slots: { header: "<h2>Projected header</h2>" },
  title: "Syntax Gallery",
};

export const increment = () => undefined;
</script>
<main hydrate:idle>
  <store count={initialCount} />
  <h1>{title}</h1>
  <component name="Panel" heading={title}><section hydrate:visible="80px" ref={refs.panel} style:width={panelWidth} class:active={active} title={heading}>
      <slot name="header"></slot>
      <label>
        <span>Name</span>
        <input bind:value={form.name}></input>
      </label>
      <label>
        <span>Enabled</span>
        <input bind:checked={form.enabled}></input>
      </label>
      <button type="button" on:click={increment}>{count}</button>
      <ul>
        <for each={rows} key={row.id}>
          <li class:selected={row.id === selectedId}>{row.label}</li>
        </for>
      </ul>
      <if test={active}>
        <p>{heading}</p>
      </if>
      <await value={messagePromise} then="message" fallback="<p>Loading</p>" error="<p>Failed</p>" reorder="preserve">
        <p>{message}</p>
      </await>
    </section></component>
</main>
