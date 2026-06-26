import { readFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";

const extensionRoot = path.join(process.cwd(), "editors", "zed-tachyon-dom");

describe("Zed Tachyon DOM extension", () => {
  it("declares a local Tachyon DOM language and language server", async () => {
    const manifest = await readFile(path.join(extensionRoot, "extension.toml"), "utf8");
    const languageConfig = await readFile(path.join(extensionRoot, "languages", "tachyon-dom", "config.toml"), "utf8");

    expect(manifest).toContain('id = "tachyon-dom"');
    expect(manifest).toContain('languages = ["languages/tachyon-dom"]');
    expect(manifest).toContain("[grammars.html]");
    expect(manifest).toContain("[language_servers.tachyon-dom]");
    expect(manifest).toContain('language = "Tachyon DOM"');

    expect(languageConfig).toContain('name = "Tachyon DOM"');
    expect(languageConfig).toContain('grammar = "html"');
    expect(languageConfig).toContain('path_suffixes = ["td", "tachyon", "tachyon.html"]');
  });

  it("starts the repo-local language server through Zed's Node runtime", async () => {
    const rustSource = await readFile(path.join(extensionRoot, "src", "lib.rs"), "utf8");

    expect(rustSource).toContain("zed::node_binary_path()?");
    expect(rustSource).toContain('repo_root.join("dist").join("cli.js")');
    expect(rustSource).toContain('"language-server"');
    expect(rustSource).toContain('"--stdio"');
    expect(rustSource).toContain("zed::register_extension!(TachyonDomExtension);");
  });
});
