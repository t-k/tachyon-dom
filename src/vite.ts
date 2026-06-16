import type { Plugin } from "vite";
import { generateClientModule, generateServerModule, generateServerStreamModule } from "./compiler/index";
import { diagnoseTemplate, formatDiagnostic } from "./diagnostics";
import { appendInlineSourceMap, createSourceMap } from "./source-map";

export type TachyonDomViteOptions = {
  include?: RegExp;
  target?: "client" | "server" | "stream";
  reactive?: boolean;
};

const codeForTarget = (
  target: NonNullable<TachyonDomViteOptions["target"]>,
  template: Parameters<typeof generateClientModule>[0],
  reactive: boolean,
): string => {
  if (target === "server") {
    return generateServerModule(template);
  }
  if (target === "stream") {
    return generateServerStreamModule(template);
  }
  return generateClientModule(template, { reactive });
};

export const tachyonDom = (options: TachyonDomViteOptions = {}): Plugin => {
  const include = options.include ?? /\.tachyon\.html$/;
  const target = options.target ?? "client";
  return {
    name: "tachyon-dom",
    enforce: "pre",
    transform(source, id) {
      if (!include.test(id)) {
        return null;
      }
      const result = diagnoseTemplate(source);
      if (!result.ok) {
        this.error(formatDiagnostic(result.error, id));
      }
      const code = codeForTarget(target, result.value, options.reactive === true);
      return {
        code: appendInlineSourceMap(code, createSourceMap(source, id, `${id}.js`)),
        map: null,
      };
    },
  };
};

export default tachyonDom;
