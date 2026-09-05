import { createLazyHydrationBoundary, scheduleHydration } from "../../dist/index.js";

const root = document.querySelector("#generated-lazy");
const hydrationChunks = {
  "generated-panel": () => import("./generated-lazy-chunk.js"),
};

window.runGeneratedLazyHydration = async () => {
  if (!(root instanceof HTMLElement)) throw new Error("Missing generated lazy root.");
  const before = root.innerHTML;
  const boundary = createLazyHydrationBoundary(root, "generated-panel", hydrationChunks["generated-panel"]);
  if (!boundary.ok) throw new Error(boundary.error.message);
  const interactionCleanup = scheduleHydration(boundary.value, {
    strategy: "interaction",
    interaction: "click",
    replayInteraction: true,
  });
  const button = root.querySelector("button");
  button?.click();
  const during = root.innerHTML;
  await boundary.value.hydrate();
  await new Promise((resolve) => setTimeout(resolve, 0));
  const form = root.querySelector("form");
  const result = {
    before,
    during,
    unchangedBeforeHydration: before === during,
    opened: root.querySelector("section")?.getAttribute("data-opened") === "true",
    submits: Number(form?.getAttribute("data-submits") ?? "0"),
    hydrated: boundary.value.hydrated(),
  };
  interactionCleanup();
  boundary.value.dispose();
  return result;
};
