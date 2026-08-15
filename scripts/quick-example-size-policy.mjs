export const checkQuickExampleSizes = (sizes) => {
  if (sizes.actualMinified !== sizes.expectedMinified) {
    return { ok: false, reason: "minified baseline" };
  }
  if (sizes.actualMinified > sizes.maxMinified || sizes.actualBrotli > sizes.maxBrotli) {
    return { ok: false, reason: "absolute budget" };
  }
  const tolerance = Math.max(16, Math.ceil(sizes.expectedBrotli * 0.01));
  if (Math.abs(sizes.actualBrotli - sizes.expectedBrotli) > tolerance) {
    return { ok: false, reason: "Brotli baseline", tolerance };
  }
  return { ok: true, tolerance };
};
