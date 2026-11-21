// @vitest-environment node

import { execFile as execFileCallback } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { expect, it } from "vitest";

const execFile = promisify(execFileCallback);
const finalize = fileURLToPath(new URL("../scripts/finalize-dist.mjs", import.meta.url));

const fixture = async (run: (directory: string) => Promise<void>) => {
  const directory = await mkdtemp(join(tmpdir(), "tachyon-dist-"));
  try {
    await mkdir(join(directory, "src"));
    await writeFile(join(directory, "src/tachyon-html.d.ts"), "export {};\n");
    await writeFile(join(directory, "package.json"), '{"type":"module"}\n');
    await run(directory);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
};

const cases = [
  ["Module", "Root", "Plain"],
  ["Module", "Nested", "Multiline"],
  ["Cli", "Root", "Legal"],
  ["Runtime", "Nested", "Legal"],
  ["Runtime", "Root", "Multiline"],
  ["Declaration", "Nested", "Legal"],
  ["Asset", "Root", "Multiline"],
  ["Declaration", "Root", "Plain"],
  ["Module", "Root", "Legal"],
  ["Cli", "Root", "Multiline"],
  ["Asset", "Nested", "Plain"],
  ["Runtime", "Nested", "Plain"],
  ["Asset", "Nested", "Legal"],
  ["Cli", "Root", "Plain"],
  ["Declaration", "Nested", "Multiline"],
] as const;

it.each(cases)("finalizes a %s artifact in %s with %s content", (kind, location, content) =>
  fixture(async (directory) => {
    const nested = location === "Nested";
    const name = {
      Module: nested ? "compiler/module.js" : "compiler.js",
      Cli: "cli.js",
      Runtime: nested ? "runtime/hydrate.js" : "index.js",
      Declaration: nested ? "compiler/module.d.ts" : "compiler.d.ts",
      Asset: nested ? "compiler/asset.json" : "asset.json",
    }[kind];
    const file = join(directory, "dist", name);
    const executable = kind === "Cli";
    const shebang = executable ? "#!/usr/bin/env node\n" : "";
    const legal = content === "Legal" ? "/*! @license Example MIT */\n" : "";
    const value = content === "Multiline" ? "first line\nsecond line" : "hello";
    const definition = `const unused = 1;\nexport function fixture() {\n    // The emitted JS can omit this comment.\n    return \`${value}\`;\n}\n`;
    const body = kind === "Asset" ? `{\n  "value": ${JSON.stringify(value)}\n}\n` : definition;
    const source = shebang + legal + body + (executable ? "console.log(fixture());\n" : "");
    await mkdir(dirname(file), { recursive: true });
    await writeFile(file, source, { mode: executable ? 0o755 : 0o644 });

    await execFile(process.execPath, [finalize], { cwd: directory });

    expect(await readFile(join(directory, "dist/tachyon-html.d.ts"), "utf8")).toBe("export {};\n");
    const result = await readFile(file, "utf8");
    if (kind === "Module" || kind === "Cli") {
      expect(result.length).toBeLessThan(source.length);
      expect(result).toContain("export function fixture(){");
      expect(result).toContain("const unused=1");
      if (legal) expect(result).toContain(legal.trim());
      if (executable) {
        expect(result.startsWith(shebang)).toBe(true);
        if (process.platform !== "win32") expect((await stat(file)).mode & 0o111).toBe(0o111);
        const { stdout } =
          process.platform === "win32" ? await execFile(process.execPath, [file]) : await execFile(file);
        expect(stdout).toBe(value + "\n");
      } else {
        const program = `import { fixture } from ${JSON.stringify(pathToFileURL(file).href)}; console.log(fixture.name); console.log(fixture());`;
        const { stdout } = await execFile(process.execPath, ["--input-type=module", "-e", program]);
        expect(stdout).toBe(`fixture\n${value}\n`);
      }
    } else {
      expect(result).toBe(source);
    }
  }),
);

it("fails the build when emitted JavaScript cannot be parsed", () =>
  fixture(async (directory) => {
    await mkdir(join(directory, "dist"));
    await writeFile(join(directory, "dist/compiler.js"), "export const broken = ;\n");
    await expect(execFile(process.execPath, [finalize], { cwd: directory })).rejects.toThrow(/compiler\.js/);
  }));
