import { createSignal } from "tachyon-dom/runtime/signal";

export const shared = createSignal(0);
export const sharedText = createSignal("");
export const events = { a: 0, b: 0, lazy: 0, ssr: 0 };
export const setShared = (value: number) => {
  shared.set(value);
  sharedText.set(`shared:${value}`);
};
