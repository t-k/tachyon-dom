export const productionDefines: Readonly<Record<string, string>>;

export type BundleMetafile = {
  inputs?: Record<string, { bytes?: number }>;
  outputs?: Record<
    string,
    {
      bytes?: number;
      inputs?: Record<string, { bytesInOutput: number }>;
    }
  >;
};

export type BundleAttribution = {
  outputs: Array<{
    path: string;
    bytes: number;
    inputs: Array<{ path: string; bytesInOutput: number }>;
  }>;
  inputs: Array<{ path: string; bytesInOutput: number }>;
};

export const attributionForMetafile: (metafile: BundleMetafile) => BundleAttribution;
export const findForbiddenInputs: (inputs: readonly string[], patterns?: readonly RegExp[]) => string[];
export const findUnwantedFeatureInputs: (
  inputs: readonly { path: string; bytesInOutput: number }[],
) => Array<{ path: string; bytesInOutput: number }>;
export const checkBundleBudget: (input: {
  minifiedBytes: number;
  brotliBytes: number;
  budget: { maxMinifiedBytes: number; maxBrotliBytes: number };
}) => { ok: true } | { ok: false; reason: "minified budget" | "Brotli budget" };
export const runClientBundleAttribution: (options?: {
  cwd?: string;
  artifactRoot?: string;
}) => Promise<{ runId: string; artifactPath: string; report: any }>;
