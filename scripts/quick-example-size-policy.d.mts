export type QuickExampleSizes = {
  expectedMinified: number;
  actualMinified: number;
  expectedBrotli: number;
  actualBrotli: number;
  maxMinified: number;
  maxBrotli: number;
};

export type QuickExampleSizeResult =
  | { ok: true; tolerance: number }
  | { ok: false; reason: "minified baseline" | "absolute budget"; tolerance?: never }
  | { ok: false; reason: "Brotli baseline"; tolerance: number };

export declare const checkQuickExampleSizes: (sizes: QuickExampleSizes) => QuickExampleSizeResult;
