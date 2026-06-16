import { describe, expect, it } from "vitest";
import { createFragmentNodes, mountFragment } from "../src/runtime/fragment";
import { mountPortal } from "../src/runtime/portal";

describe("fragment and portal runtime helpers", () => {
  it("mounts and removes multiple fragment nodes without a wrapper", () => {
    document.body.innerHTML = `<main><span id="end"></span></main>`;
    const main = document.querySelector("main");
    const end = document.querySelector("#end");
    if (!main || !end) {
      throw new Error("Missing fragment host.");
    }
    const nodes = createFragmentNodes(`<h1>Title</h1><p>Body</p>`);

    const handle = mountFragment(main, end, nodes);

    expect(main.innerHTML).toBe(`<h1>Title</h1><p>Body</p><span id="end"></span>`);
    handle.remove();
    expect(main.innerHTML).toBe(`<span id="end"></span>`);
  });

  it("mounts and removes portal nodes in an external target", () => {
    document.body.innerHTML = `<main></main><aside id="portal"></aside>`;
    const target = document.querySelector("#portal");
    if (!(target instanceof HTMLElement)) {
      throw new Error("Missing portal target.");
    }
    const nodes = createFragmentNodes(`<dialog open>Menu</dialog><div>Backdrop</div>`);

    const handle = mountPortal(target, nodes);

    expect(handle.target).toBe(target);
    expect(target.innerHTML).toBe(`<dialog open="">Menu</dialog><div>Backdrop</div>`);
    handle.remove();
    expect(target.innerHTML).toBe("");
  });
});
