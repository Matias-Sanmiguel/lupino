use anyhow::{Context, Result};
use lupino_core::native;
use serde_json::json;
use std::path::{Path, PathBuf};

pub fn register_host(root: &Path) -> Result<String> {
    let executable = std::env::current_exe()?;
    let manifest = json!({"name":native::HOST_NAME,"description":"Lupino Teams capture","path":executable,"type":"stdio","allowed_origins":[format!("chrome-extension://{}/",native::extension_id())]});
    let file = root.join("native-host.json");
    std::fs::write(&file, serde_json::to_vec_pretty(&manifest)?)?;
    #[cfg(target_os = "windows")]
    {
        use winreg::{enums::HKEY_CURRENT_USER, RegKey};
        for browser in [
            "Google\\Chrome",
            "Chromium",
            "Microsoft\\Edge",
            "BraveSoftware\\Brave-Browser",
        ] {
            let key = RegKey::predef(HKEY_CURRENT_USER)
                .create_subkey(format!(
                    "Software\\{browser}\\NativeMessagingHosts\\{}",
                    native::HOST_NAME
                ))?
                .0;
            key.set_value("", &file.to_string_lossy().as_ref())?;
        }
    }
    #[cfg(not(target_os = "windows"))]
    {
        let base = directories_home()?;
        #[cfg(target_os = "linux")]
        let paths = [
            base.join(".config/google-chrome/NativeMessagingHosts"),
            base.join(".config/chromium/NativeMessagingHosts"),
            base.join(".config/microsoft-edge/NativeMessagingHosts"),
            base.join(".config/BraveSoftware/Brave-Browser/NativeMessagingHosts"),
        ];
        #[cfg(target_os = "macos")]
        let paths = [
            base.join("Library/Application Support/Google/Chrome/NativeMessagingHosts"),
            base.join("Library/Application Support/Chromium/NativeMessagingHosts"),
            base.join("Library/Application Support/Microsoft Edge/NativeMessagingHosts"),
            base.join(
                "Library/Application Support/BraveSoftware/Brave-Browser/NativeMessagingHosts",
            ),
        ];
        for dir in paths {
            std::fs::create_dir_all(&dir)?;
            std::fs::copy(&file, dir.join(format!("{}.json", native::HOST_NAME)))?;
        }
    }
    Ok(format!(
        "Extensión vinculada. ID: {}. Si movés el ejecutable, volvé a vincularla.",
        native::extension_id()
    ))
}
#[cfg(not(target_os = "windows"))]
fn directories_home() -> Result<PathBuf> {
    std::env::var_os("HOME")
        .map(PathBuf::from)
        .context("No se encontró el directorio de usuario")
}
