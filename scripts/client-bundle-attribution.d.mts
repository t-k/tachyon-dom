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
export type ClientBundleBudget = { maxMinifiedBytes: number; maxBrotliBytes: number };
export const checkBundleBudget: (input: {
  minifiedBytes: number;
  brotliBytes: number;
  budget: ClientBundleBudget;
}) => { ok: true } | { ok: false; reason: "invalid budget" | "minified budget" | "Brotli budget" };
export type ClientBundleFixture = {
  name: string;
  source: string;
  generatedSource: string;
  entrySource: string;
  compileOptions?: Record<string, unknown>;
  generateOptions?: Record<string, unknown>;
};
export const variedTemplateSources: readonly string[];
export const createClientBundleFixtures: () => ClientBundleFixture[];
export const validateFixtureBudgets: (
  budgets: Record<string, unknown>,
  fixtures: readonly Pick<ClientBundleFixture, "name">[],
) => { ok: true } | { ok: false; reason: "missing fixture budget" | "invalid fixture budget"; fixtures: string[] };
export const runClientBundleAttribution: (options?: {
  cwd?: string;
  artifactRoot?: string;
  fixtures?: readonly ClientBundleFixture[];
}) => Promise<{ runId: string; artifactPath: string; report: any }>;

export type ClientBundleBuildResult = {
  metafile: BundleMetafile;
  outputFiles?: Array<{ contents: Uint8Array; text: string }>;
};
export const buildClientBundle: (contents: string, options?: { cwd?: string }) => Promise<ClientBundleBuildResult>;
export const summarizeClientBundle: (result: ClientBundleBuildResult) => {
  minifiedBytes: number;
  brotliBytes: number;
  outputs: Array<{ path: string; bytes: number; brotliBytes: number; sha256: string; metafileBytes?: number }>;
  inputs: Array<{ path: string; bytesInOutput: number; sourceBytes?: number }>;
  metafileAttribution: BundleAttribution;
};
