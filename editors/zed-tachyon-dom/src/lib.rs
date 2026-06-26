use std::path::PathBuf;
use zed_extension_api as zed;

struct TachyonDomExtension;

impl zed::Extension for TachyonDomExtension {
    fn new() -> Self {
        Self
    }

    fn language_server_command(
        &mut self,
        _language_server_id: &zed::LanguageServerId,
        _worktree: &zed::Worktree,
    ) -> zed::Result<zed::Command> {
        let extension_root = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
        let repo_root = extension_root
            .parent()
            .and_then(|path| path.parent())
            .ok_or_else(|| "Unable to resolve tachyon-dom repository root.".to_string())?;
        let cli_path = repo_root.join("dist").join("cli.js");

        Ok(zed::Command {
            command: zed::node_binary_path()?,
            args: vec![
                cli_path.to_string_lossy().into_owned(),
                "language-server".to_string(),
                "--stdio".to_string(),
            ],
            env: vec![],
        })
    }
}

zed::register_extension!(TachyonDomExtension);
