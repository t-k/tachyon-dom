export type SourceMap = {
  version: 3;
  file?: string;
  sources: string[];
  sourcesContent: string[];
  names: string[];
  mappings: string;
};

export type SourceMapBuildContext = {
  sourcemap?: boolean | undefined;
  productionSourceMap?: boolean | undefined;
  command?: string | undefined;
  mode?: string | undefined;
};

export const createSourceMap = (
  source: string,
  sourceFile = "template.tachyon.html",
  outputFile?: string,
): SourceMap => ({
  version: 3,
  ...(outputFile ? { file: outputFile } : {}),
  sources: [sourceFile],
  sourcesContent: [source],
  names: [],
  mappings: "",
});

export const shouldEmitSourceMap = (context: SourceMapBuildContext = {}): boolean => {
  if (context.productionSourceMap === false && context.command === "build" && context.mode === "production") {
    return false;
  }
  return context.sourcemap !== false;
};

export const appendInlineSourceMap = (code: string, map: SourceMap): string => {
  const encoded = Buffer.from(JSON.stringify(map), "utf8").toString("base64");
  return `${code}\n//# sourceMappingURL=data:application/json;base64,${encoded}\n`;
};
