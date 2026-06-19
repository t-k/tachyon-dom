<main>
  <store count={initialCount} />
  <h1>{title}</h1>
  <component name="CounterPanel"><section hydrate:id={islandId} class:active={active}><if test={active}><button id="boundary-button" data-testid="boundary-button" on:click={increment}>{count}</button></if><ul><for each={rows} key={row.id}><li class:active={row.active}>{row.label}</li></for></ul></section></component>
</main>
