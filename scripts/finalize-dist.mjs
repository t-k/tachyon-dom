import { copyFile, mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { join, relative, sep } from "node:path";
import { transform } from "esbuild";

await mkdir("dist", { recursive: true });
await copyFile("src/tachyon-html.d.ts", "dist/tachyon-html.d.ts");

const entries = await readdir("dist", { recursive: true, withFileTypes: true });
// Keep browser runtime inputs byte-for-byte as emitted by TypeScript. Reprinting
// them can change the compressed size of bundles even with identical behavior.
const toolingFiles = new Set([
  "cli.js",
  "code-preview.js",
  "compiler.js",
  "language-server.js",
  "optional-peer.js",
  "package-integrity.js",
  "template-language.js",
  "template-typecheck.js",
  "vite.js",
]);
const modules = entries.filter((entry) => {
  const relativePath = relative("dist", join(entry.parentPath, entry.name));
  return (
    entry.isFile() &&
    entry.name.endsWith(".js") &&
    (toolingFiles.has(relativePath) || relativePath.startsWith(`compiler${sep}`))
  );
});

await Promise.all(
  modules.map(async (entry) => {
    const file = join(entry.parentPath, entry.name);
    const input = await readFile(file, "utf8");
    const { code } = await transform(input, {
      sourcefile: file,
      target: "es2022",
      legalComments: "inline",
      minifyWhitespace: true,
      treeShaking: false,
    });
    await writeFile(file, code);
  }),
);
