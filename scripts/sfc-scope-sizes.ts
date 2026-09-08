import { brotliCompressSync } from "node:zlib";
import { build } from "esbuild";
import { compileTachyonSfc, templateScopeIdentifiers, transformSfcScript } from "../src/compiler/sfc";
import { generateClientModule } from "../src/compiler";
import { sfcScopeCases, sfcScopeSource } from "../tests/fixtures/sfc-scope/cases";

const results = [];
for (const fixture of sfcScopeCases) {
  const compiled = compileTachyonSfc(sfcScopeSource(fixture));
  if (!compiled.ok) throw new Error(compiled.error.message);
  for (const narrow of [false, true]) {
    const script = transformSfcScript(
      compiled.value.descriptor.script,
      narrow
        ? {
            templateIdentifiers: templateScopeIdentifiers(compiled.value.template),
          }
        : {},
    );
    if (!script.ok) throw new Error(script.error.message);
    const contents =
      script.value.code +
      generateClientModule(compiled.value.template, {
        reactive: true,
        instrumentBindings: false,
        defaultScopeName: script.value.defaultScopeName,
      });
    const bundle = await build({
      stdin: { contents, resolveDir: process.cwd(), loader: "js" },
      bundle: true,
      minify: true,
      write: false,
      format: "esm",
      platform: "browser",
      define: { __TACHYON_PRODUCTION__: "true" },
      tsconfigRaw: {},
    });
    const bytes = bundle.outputFiles[0]!.contents;
    results.push({
      fixture: fixture.name,
      mode: narrow ? "narrow" : "full",
      exposed: script.value.exposedBindings.length,
      externalScopeExposed: script.value.setupBindings.length,
      narrowed: script.value.exposedBindings.length < script.value.setupBindings.length,
      minified: bytes.length,
      brotli: brotliCompressSync(bytes).length,
    });
  }
}
process.stdout.write(JSON.stringify(results, null, 2) + "\n");
