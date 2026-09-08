import { execFile as execFileCallback } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { brotliCompressSync } from "node:zlib";
import { build, version as esbuildVersion } from "esbuild";
import { compileTemplate, generateClientModule } from "../dist/compiler.js";

const execFile = promisify(execFileCallback);

export const productionDefines = Object.freeze({ __TACHYON_PRODUCTION__: "true" });

export const forbiddenPatterns = [
  /(?:^|[/\\])typescript(?:[/\\]|$)/,
  /(?:^|[/\\])parse5(?:[/\\]|$)/,
  /vscode-languageserver/,
  /[/\\]runtime[/\\]diagnostics\.js$/,
  /[/\\]compiler[/\\]/,
  /[/\\]server[/\\]/,
  /[/\\]app\.js$/,
  /[/\\]html-whitespace\.js$/,
];

const attributionForbiddenFeaturePatterns = [
  /[/\\]runtime[/\\]form\.js$/,
  /[/\\]runtime[/\\]list\.js$/,
  /[/\\]runtime[/\\]list-text\.js$/,
  /[/\\]runtime[/\\]hydrate\.js$/,
  /[/\\]runtime[/\\]component\.js$/,
];

const hashBytes = (value) => createHash("sha256").update(value).digest("hex");
const hashText = (value) => hashBytes(Buffer.from(value, "utf8"));

const runCommand = async (command, args, cwd) => {
  const result = await execFile(command, args, { cwd, encoding: "utf8" });
  return result.stdout.trim();
};

const sha256File = async (path) => hashBytes(await readFile(path));

const readJsonIfPresent = async (path) => {
  try {
    return JSON.parse(await readFile(path, "utf8"));
  } catch (error) {
    if (error?.code === "ENOENT") return {};
    throw error;
  }
};

const safeFixtureName = (name) => name.replace(/[^A-Za-z0-9._-]/g, "-");

export const buildClientBundle = (contents, { cwd = process.cwd() } = {}) =>
  build({
    bundle: true,
    format: "esm",
    logLevel: "silent",
    metafile: true,
    minify: true,
    platform: "browser",
    // Measure the published package, not source aliases used to typecheck the repository before building it.
    tsconfigRaw: {},
    define: productionDefines,
    stdin: { contents, loader: "js", resolveDir: cwd },
    write: false,
  });

export const attributionForMetafile = (metafile) => {
  const outputs = Object.entries(metafile.outputs ?? {}).map(([path, output]) => ({
    path,
    bytes: output.bytes,
    inputs: Object.entries(output.inputs ?? {}).map(([inputPath, input]) => ({
      path: inputPath,
      bytesInOutput: input.bytesInOutput,
    })),
  }));
  const inputTotals = new Map();
  for (const output of outputs) {
    for (const input of output.inputs) {
      inputTotals.set(input.path, (inputTotals.get(input.path) ?? 0) + input.bytesInOutput);
    }
  }
  return {
    outputs,
    inputs: [...inputTotals].map(([path, bytesInOutput]) => ({ path, bytesInOutput })),
  };
};

export const summarizeClientBundle = (result) => {
  const metafileAttribution = attributionForMetafile(result.metafile);
  const outputFiles = result.outputFiles ?? [];
  const metafileOutputs = Object.values(result.metafile.outputs ?? {});
  const outputs = outputFiles.map((output, index) => ({
    path: Object.keys(result.metafile.outputs ?? {})[index] ?? `<output-${index}>`,
    bytes: output.contents.byteLength,
    brotliBytes: brotliCompressSync(output.contents).byteLength,
    sha256: hashBytes(output.contents),
    metafileBytes: metafileOutputs[index]?.bytes,
  }));
  const inputs = metafileAttribution.inputs.map((input) => ({
    ...input,
    sourceBytes: result.metafile.inputs?.[input.path]?.bytes,
  }));
  return {
    minifiedBytes: outputFiles.reduce((total, output) => total + output.contents.byteLength, 0),
    brotliBytes: outputs.reduce((total, output) => total + output.brotliBytes, 0),
    outputs,
    inputs,
    metafileAttribution,
  };
};

export const findForbiddenInputs = (inputs, patterns = forbiddenPatterns) =>
  inputs.filter((input) => patterns.some((pattern) => pattern.test(input)));

export const findUnwantedFeatureInputs = (inputs) =>
  inputs.filter(
    (input) =>
      input.bytesInOutput > 0 && attributionForbiddenFeaturePatterns.some((pattern) => pattern.test(input.path)),
  );

export const checkBundleBudget = ({ minifiedBytes, brotliBytes, budget }) => {
  if (!budget || !Number.isSafeInteger(budget.maxMinifiedBytes) || budget.maxMinifiedBytes <= 0) {
    return { ok: false, reason: "invalid budget" };
  }
  if (!Number.isSafeInteger(budget.maxBrotliBytes) || budget.maxBrotliBytes <= 0) {
    return { ok: false, reason: "invalid budget" };
  }
  if (minifiedBytes > budget.maxMinifiedBytes) return { ok: false, reason: "minified budget" };
  if (brotliBytes > budget.maxBrotliBytes) return { ok: false, reason: "Brotli budget" };
  return { ok: true };
};

const generatedClientSource = (source, options = {}, compileOptions = {}) => {
  const compiled = compileTemplate(source, compileOptions);
  if (!compiled.ok) throw new Error(compiled.error.message);
  return generateClientModule(compiled.value, { instrumentBindings: false, ...options }).replaceAll(
    'from "tachyon-dom/',
    'from "./dist/',
  );
};

const quickTemplateSource = `<main>
  <button on:click={increment}>{count}</button>
  <ul>
    <for each={rows} key={row.id}>
      <li>{row.label}</li>
    </for>
  </ul>
</main>`;

const generatedTemplateFixture = (source, options = {}, compileOptions = {}) =>
  generatedClientSource(source, options, compileOptions);

// A page with one template and a page with many share the runtime once; what the second one adds per
// template is the descriptor and glue code the compiler emits. Measuring both keeps a runtime/generated-code
// trade-off honest: a helper that shrinks one template but grows every descriptor shows up here, not in the
// single-template fixtures.
const pageTemplateSource = (index) =>
  `<section><h2>Panel ${index}</h2><button on:click={toggle}>Toggle</button><if test={open}><ul><for each={rows} key={row.id}><li class:active={row.active}>{row.label}</li></for></ul></if></section>`;

// Templates that differ in their bindings import different helper subsets from the same runtime modules, and the
// compiler may bind one local alias to different exports per template (the conditional preparation variants).
// Each template therefore keeps module-scoped aliases, suffixed per template, and the page merges the resulting
// specifiers per module the way a bundler merges separate template modules.
const templatesPageFixture = (sources) => {
  const specifiersByModule = new Map();
  const modules = [];
  for (const [index, source] of sources.entries()) {
    const generated = generatedTemplateFixture(source, { reactive: true });
    const aliases = new Map();
    const bodyLines = [];
    for (const line of generated.split("\n")) {
      const match = /^import \{ (.*) \} from ("[^"]+");$/.exec(line);
      if (!match) {
        bodyLines.push(line.replace(/^export const /, "const "));
        continue;
      }
      const specifiers = specifiersByModule.get(match[2]) ?? new Set();
      for (const specifier of match[1].split(", ")) {
        const [exported, alias = exported] = specifier.split(" as ");
        const scoped = `${alias}_t${index}`;
        aliases.set(alias, scoped);
        specifiers.add(`${exported} as ${scoped}`);
      }
      specifiersByModule.set(match[2], specifiers);
    }
    const body = bodyLines.join("\n").replace(/\b__tachyon\w+\b/g, (name) => aliases.get(name) ?? name);
    modules.push(`const template${index} = (() => {\n${body}\nreturn { templateHtml, bind };\n})();`);
  }
  const imports = [...specifiersByModule].map(
    ([module, specifiers]) => `import { ${[...specifiers].sort().join(", ")} } from ${module};`,
  );
  const names = sources.map((_, index) => `template${index}`);
  return `${imports.join("\n")}
${modules.join("\n")}
export const templates = [${names.join(", ")}];
export const mount = (root, scope) => templates.map((template) => template.bind(root, scope));
`;
};

const manyTemplatesPageFixture = (count) =>
  templatesPageFixture(Array.from({ length: count }, (_, index) => pageTemplateSource(index)));

// The many-template page repeats one shape, which compresses unusually well. These templates differ in the
// bindings they use (forms, dynamic attributes, nested control flow, refs, richer expressions) so the per-template
// cost they measure is closer to what a real application page pays for its generated descriptors.
export const variedTemplateSources = [
  `<form on:submit={save}><label for="name">Name</label><input id="name" bind:value={draft.name} placeholder={hint}><input type="checkbox" bind:checked={draft.subscribed}><button type="submit" disabled={saving}>{saving ? "Saving" : "Save"}</button></form>`,
  `<nav aria-label={label}><a href={home.href} class:active={route === "home"} title={home.title}>Home</a><a href={docs.href} class:active={route === "docs"} style:color={accent}>Docs</a></nav>`,
  `<ul><for each={groups} key={group.id}><li class:open={group.open}><h3>{group.title} ({group.items.length})</h3><if test={group.open}><ul><for each={group.items} key={item.id}><li class:done={item.done}>{item.label}</li></for></ul></if></li></for></ul>`,
  `<article><header><h2>{post.title}</h2><time datetime={post.publishedAt}>{formatDate(post.publishedAt)}</time></header><if test={post.tags.length > 0}><ul><for each={post.tags} key={tag}><li>{tag}</li></for></ul></if><p>{post.summary ?? "No summary"}</p></article>`,
  `<section><input ref={search.input} bind:value={search.query} on:input={onSearch}><p>{search.results.length} results for \`\${search.query}\`</p><if test={search.loading}><span class="spinner">Loading</span></if></section>`,
  `<table><tbody><for each={rows} key={row.id} index="index"><tr class:odd={index % 2 === 1} on:click={select}><td>{index + 1}</td><td>{row.name}</td><td style:width={row.share + "%"}>{row.share.toFixed(1)}</td></tr></for></tbody></table>`,
  `<dialog open={modal.open}><h2>{modal.title}</h2><p>{modal.message}</p><button on:click={modal.confirm} disabled={!modal.ready}>OK</button><button on:click={modal.cancel}>Cancel</button></dialog>`,
  `<footer><if test={user}><span>{user.name} ({user.role})</span><button on:click={signOut}>Sign out</button></if><if test={!user}><a href={loginHref}>Sign in</a></if><small>{year} {company}</small></footer>`,
];

const variedTemplatesPageFixture = () => templatesPageFixture(variedTemplateSources);

const generatedFixtureOptions = (generateOptions = {}, compileOptions = {}) => ({
  compileOptions,
  generateOptions: { instrumentBindings: false, ...generateOptions },
});

export const createClientBundleFixtures = () => {
  const staticGenerated = generatedTemplateFixture("<main><h1>Static</h1></main>");
  const signalOnlyEntry =
    'import { createSignal } from "tachyon-dom"; export const value = createSignal(1); export const setValue = (next) => value.set(next);';
  const reactiveTextGenerated = generatedTemplateFixture("<p>{message}</p>", { reactive: true });
  const eventGenerated = generatedTemplateFixture("<button on:click={save}>Save</button>");
  const textListGenerated = generatedTemplateFixture(
    "<ul><for each={rows} key={row.id}><li>{row.label}</li></for></ul>",
    { reactive: true },
  );
  const minimalIfGenerated = generatedTemplateFixture("<main><if test={visible}><span>Visible</span></if></main>", {
    reactive: true,
  });
  const compositeGenerated = generatedTemplateFixture(
    quickTemplateSource,
    { reactive: true },
    { whitespace: "condense" },
  );
  const oneTemplatePage = manyTemplatesPageFixture(1);
  const thirtyTemplatePage = manyTemplatesPageFixture(30);
  const variedTemplatePage = variedTemplatesPageFixture();
  return [
    {
      name: "static",
      source: "<main><h1>Static</h1></main>",
      generatedSource: staticGenerated,
      entrySource: staticGenerated,
      ...generatedFixtureOptions(),
    },
    {
      name: "signal-only",
      source: "createSignal()",
      generatedSource: signalOnlyEntry,
      entrySource: signalOnlyEntry,
      compileOptions: undefined,
      generateOptions: undefined,
    },
    {
      name: "reactive-text",
      source: "<p>{message}</p>",
      generatedSource: reactiveTextGenerated,
      entrySource: reactiveTextGenerated,
      ...generatedFixtureOptions({ reactive: true }),
    },
    {
      name: "event-only",
      source: "<button on:click={save}>Save</button>",
      generatedSource: eventGenerated,
      entrySource: eventGenerated,
      ...generatedFixtureOptions(),
    },
    {
      name: "text-only-list",
      source: "<ul><for each={rows} key={row.id}><li>{row.label}</li></for></ul>",
      generatedSource: textListGenerated,
      entrySource: textListGenerated,
      ...generatedFixtureOptions({ reactive: true }),
    },
    {
      name: "minimal-if",
      source: "<main><if test={visible}><span>Visible</span></if></main>",
      generatedSource: minimalIfGenerated,
      entrySource: minimalIfGenerated,
      ...generatedFixtureOptions({ reactive: true }),
    },
    {
      name: "composite-quick-example",
      source: quickTemplateSource,
      generatedSource: compositeGenerated,
      entrySource: `import { createSignal } from "tachyon-dom";
${compositeGenerated}
export const scope = {
  count: createSignal(0),
  rows: createSignal([{ id: 1, label: "Alpha" }, { id: 2, label: "Beta" }]),
};
scope.increment = () => scope.count.update((value) => value + 1);
export const mount = (root) => bind(root, scope);
`,
      ...generatedFixtureOptions({ reactive: true }, { whitespace: "condense" }),
    },
    {
      name: "one-template-page",
      source: pageTemplateSource(0),
      generatedSource: oneTemplatePage,
      entrySource: oneTemplatePage,
      ...generatedFixtureOptions({ reactive: true }),
    },
    {
      name: "thirty-template-page",
      source: `${pageTemplateSource(0)} ... ${pageTemplateSource(29)}`,
      generatedSource: thirtyTemplatePage,
      entrySource: thirtyTemplatePage,
      ...generatedFixtureOptions({ reactive: true }),
    },
    {
      name: "varied-template-page",
      source: variedTemplateSources.join(" ... "),
      generatedSource: variedTemplatePage,
      entrySource: variedTemplatePage,
      ...generatedFixtureOptions({ reactive: true }),
    },
  ];
};

export const validateFixtureBudgets = (budgets, fixtures) => {
  const expectedNames = fixtures.map((fixture) => fixture.name);
  const missing = expectedNames.filter(
    (name) => !budgets || typeof budgets[name] !== "object" || budgets[name] === null,
  );
  if (missing.length > 0) return { ok: false, reason: "missing fixture budget", fixtures: missing };
  const invalid = expectedNames.filter((name) => {
    const budget = budgets[name];
    return (
      !Number.isSafeInteger(budget.maxMinifiedBytes) ||
      budget.maxMinifiedBytes <= 0 ||
      !Number.isSafeInteger(budget.maxBrotliBytes) ||
      budget.maxBrotliBytes <= 0
    );
  });
  if (invalid.length > 0) return { ok: false, reason: "invalid fixture budget", fixtures: invalid };
  return { ok: true };
};

const fixtureBudgetsPath = (cwd) => join(cwd, "scripts", "client-bundle-attribution-budgets.json");

const createRunDirectory = async (artifactRoot) => {
  await mkdir(artifactRoot, { recursive: true });
  for (let attempt = 0; attempt < 10; attempt++) {
    const runId = `client-bundle-${new Date().toISOString().replace(/[^0-9TZ-]/g, "")}-${process.pid}-${randomBytes(4).toString("hex")}`;
    const directory = join(artifactRoot, runId);
    try {
      await mkdir(directory);
      return { runId, directory };
    } catch (error) {
      if (error?.code !== "EEXIST") throw error;
    }
  }
  throw new Error("Could not allocate a unique client bundle artifact directory.");
};

const provenanceFor = async (cwd) => ({
  head: await runCommand("git", ["rev-parse", "HEAD"], cwd),
  lockfileSha256: await sha256File(join(cwd, "pnpm-lock.yaml")),
  node: process.version,
  pnpm: await runCommand("pnpm", ["--version"], cwd),
  esbuild: esbuildVersion,
  zlib: process.versions.zlib,
});

const relativeArtifactPath = (artifactRoot, path) => relative(artifactRoot, path);

const writeFixtureArtifacts = async ({
  artifactRoot,
  runDirectory,
  fixture,
  result,
  summary,
  unwantedFeatureInputs,
}) => {
  const fixtureDirectory = join(runDirectory, "fixtures", safeFixtureName(fixture.name));
  await mkdir(fixtureDirectory, { recursive: true });
  await writeFile(join(fixtureDirectory, "entry.js"), fixture.entrySource);
  await writeFile(join(fixtureDirectory, "generated.js"), fixture.generatedSource);
  await writeFile(join(fixtureDirectory, "metafile.json"), JSON.stringify(result.metafile, null, 2));
  for (const [index, output] of (result.outputFiles ?? []).entries()) {
    await writeFile(join(fixtureDirectory, `output-${index}.js`), output.contents);
    await writeFile(join(fixtureDirectory, `output-${index}.br`), brotliCompressSync(output.contents));
  }
  return {
    name: fixture.name,
    source: fixture.source,
    sourceSha256: hashText(fixture.source),
    entrySourceSha256: hashText(fixture.entrySource),
    generatedSourceSha256: hashText(fixture.generatedSource),
    entrySource: fixture.entrySource,
    generatedSource: fixture.generatedSource,
    compileOptions: fixture.compileOptions ?? null,
    generateOptions: fixture.generateOptions ?? null,
    minifiedBytes: summary.minifiedBytes,
    brotliBytes: summary.brotliBytes,
    outputs: summary.outputs.map((output, index) => ({
      ...output,
      artifactPath: relativeArtifactPath(artifactRoot, join(fixtureDirectory, `output-${index}.js`)),
    })),
    inputs: summary.inputs,
    inputContributions: summary.metafileAttribution,
    distributionInputs: summary.inputs.filter((input) => /dist[/\\]/.test(input.path)),
    ...(fixture.name === "minimal-if"
      ? {
          minimalFeaturePolicy: {
            ok: unwantedFeatureInputs.length === 0,
            unwantedInputs: unwantedFeatureInputs.map((input) => input.path),
          },
        }
      : {}),
    artifactDirectory: relativeArtifactPath(artifactRoot, fixtureDirectory),
  };
};

export const runClientBundleAttribution = async ({
  cwd = process.cwd(),
  artifactRoot = join(cwd, "benchmark", "client-bundle-attribution-results"),
  fixtures = createClientBundleFixtures(),
} = {}) => {
  const resolvedCwd = resolve(cwd);
  const resolvedArtifactRoot = resolve(artifactRoot);
  const { runId, directory: runDirectory } = await createRunDirectory(resolvedArtifactRoot);
  const budgets = await readJsonIfPresent(await fixtureBudgetsPath(resolvedCwd));
  const budgetValidation = validateFixtureBudgets(budgets, fixtures);
  if (!budgetValidation.ok) {
    throw new Error(`${budgetValidation.reason}: ${budgetValidation.fixtures.join(", ")}`);
  }
  const fixtureReports = [];
  const validationFailures = [];
  for (const fixture of fixtures) {
    const result = await buildClientBundle(fixture.entrySource, { cwd: resolvedCwd });
    const summary = summarizeClientBundle(result);
    const inputNames = Object.keys(result.metafile.inputs ?? {});
    const forbiddenInputs = findForbiddenInputs(inputNames);
    if (forbiddenInputs.length > 0) {
      throw new Error(`${fixture.name} fixture includes forbidden dependencies:\n${forbiddenInputs.join("\n")}`);
    }
    if (!summary.inputs.some((input) => /dist[/\\]/.test(input.path) && input.bytesInOutput > 0)) {
      throw new Error(`${fixture.name} fixture did not retain a distribution input in its output.`);
    }
    const unwantedFeatureInputs = fixture.name === "minimal-if" ? findUnwantedFeatureInputs(summary.inputs) : [];
    const budget = budgets[fixture.name];
    const budgetResult = checkBundleBudget({ ...summary, budget });
    if (!budgetResult.ok) {
      validationFailures.push(
        `${fixture.name} fixture exceeds its ${budgetResult.reason}: ${summary.minifiedBytes} minified/${summary.brotliBytes} Brotli bytes.`,
      );
    }
    if (unwantedFeatureInputs.length > 0) {
      validationFailures.push(
        `${fixture.name} fixture includes unwanted feature dependencies: ${unwantedFeatureInputs
          .map((input) => input.path)
          .join(", ")}`,
      );
    }
    fixtureReports.push({
      ...(await writeFixtureArtifacts({
        artifactRoot: resolvedArtifactRoot,
        runDirectory,
        fixture,
        result,
        summary,
        unwantedFeatureInputs,
      })),
      budget,
      budgetResult,
    });
  }
  const report = {
    schemaVersion: 1,
    runId,
    createdAt: new Date().toISOString(),
    provenance: await provenanceFor(resolvedCwd),
    buildOptions: {
      bundle: true,
      format: "esm",
      minify: true,
      platform: "browser",
      define: productionDefines,
      loader: "js",
      write: false,
      metafile: true,
      resolveDir: resolvedCwd,
      brotli: { algorithm: "brotliCompressSync", params: {} },
    },
    validation: { ok: validationFailures.length === 0, failures: validationFailures },
    fixtures: fixtureReports,
  };
  const artifactPath = join(runDirectory, "report.json");
  await writeFile(artifactPath, `${JSON.stringify(report, null, 2)}\n`);
  if (validationFailures.length > 0) {
    throw new Error(`Client bundle attribution validation failed:\n${validationFailures.join("\n")}`);
  }
  return { runId, artifactPath, report };
};

const artifactRootFromArgs = () => {
  const index = process.argv.indexOf("--artifact-root");
  return index >= 0 && process.argv[index + 1]
    ? resolve(process.argv[index + 1])
    : join(process.cwd(), "benchmark", "client-bundle-attribution-results");
};

const isMain = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  try {
    const result = await runClientBundleAttribution({ artifactRoot: artifactRootFromArgs() });
    for (const fixture of result.report.fixtures) {
      console.log(
        `${fixture.name}: ${fixture.minifiedBytes} minified bytes, ${fixture.brotliBytes} Brotli bytes, ${fixture.inputs.length} attributed inputs.`,
      );
    }
    console.log(`Client bundle attribution report: ${result.artifactPath}`);
  } catch (error) {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  }
}
