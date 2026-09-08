import { brotliCompressSync } from "node:zlib";
import { build } from "esbuild";
import { compileTachyonSfc, templateScopeIdentifiers, transformSfcScript } from "../src/compiler/sfc";
import { generateClientModule } from "../src/compiler";
import { sfcScopeCases, sfcScopeSource } from "../tests/fixtures/sfc-scope/cases";

// `entry` is what the CLI and Vite emit: the factory always returns the full
// scope. `dual` keeps the narrowed no-input return as well, which only a
// caller of the standalone factory can reach.
const results = [];
for (const fixture of sfcScopeCases) {
  const compiled = compileTachyonSfc(sfcScopeSource(fixture));
  if (!compiled.ok) throw new Error(compiled.error.message);
  const rows = [];
  for (const mode of ["entry", "dual"] as const) {
    const script = transformSfcScript(
      compiled.value.descriptor.script,
      mode === "dual" ? { templateIdentifiers: templateScopeIdentifiers(compiled.value.template) } : {},
    );
    if (!script.ok) throw new Error(script.error.message);
    const clientModule = generateClientModule(compiled.value.template, {
      reactive: true,
      instrumentBindings: false,
      defaultScopeName: script.value.defaultScopeName,
    });
    const bundle = await build({
      stdin: { contents: script.value.code + clientModule, resolveDir: process.cwd(), loader: "js" },
      bundle: true,
      minify: true,
      write: false,
      format: "esm",
      platform: "browser",
      define: { __TACHYON_PRODUCTION__: "true" },
      tsconfigRaw: {},
    });
    const bytes = bundle.outputFiles[0]!.contents;
    rows.push({
      fixture: fixture.name,
      mode,
      emissionPolicy: script.value.scopeEmission,
      factorySupportsNarrowing: script.value.scopeEmission === "dual",
      // The generated entry defaults an omitted scope to `{}`, so the factory never sees `undefined`.
      entryUsesFullScope: /__tachyonCreateScope = \(inputScope = \{\}\)/.test(clientModule),
      exposed: script.value.exposedBindings.length,
      externalScopeExposed: script.value.setupBindings.length,
      minified: bytes.length,
      brotli: brotliCompressSync(bytes).length,
    });
  }
  const [entry, dual] = rows;
  results.push(...rows, {
    fixture: fixture.name,
    mode: "dual-minus-entry",
    minified: dual!.minified - entry!.minified,
    brotli: dual!.brotli - entry!.brotli,
  });
}
process.stdout.write(JSON.stringify(results, null, 2) + "\n");
