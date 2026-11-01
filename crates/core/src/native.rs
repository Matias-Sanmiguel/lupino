use crate::{Capture, Store};
use anyhow::{bail, Context, Result};
use base64::Engine;
use serde_json::{json, Value};
use std::{
    io::{Read, Write},
    path::{Path, PathBuf},
};
pub const MAX_FRAME: u32 = 32 * 1024 * 1024;
pub const HOST_NAME: &str = "app.lupino.capture";
pub fn extension_id() -> String {
    serde_json::from_str::<Value>(include_str!("../../../extension/identity.json")).unwrap()
        ["extensionId"]
        .as_str()
        .unwrap()
        .into()
}
pub fn data_dir() -> Result<PathBuf> {
    if let Some(path) = std::env::var_os("LUPINO_DATA_DIR") {
        return Ok(PathBuf::from(path));
    }
    Ok(directories::ProjectDirs::from("app", "Lupino", "Lupino")
        .context("No se encontró el directorio de datos")?
        .data_local_dir()
        .to_owned())
}
pub fn private_dir(root: &Path) -> Result<()> {
    std::fs::create_dir_all(root)?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(root, std::fs::Permissions::from_mode(0o700))?;
    }
    Ok(())
}
pub fn read_frame(r: &mut impl Read) -> Result<Option<Value>> {
    let mut header = [0u8; 4];
    let n = r.read(&mut header[..1])?;
    if n == 0 {
        return Ok(None);
    }
    r.read_exact(&mut header[1..])
        .context("Cabecera incompleta")?;
    let size = u32::from_ne_bytes(header);
    if size == 0 || size > MAX_FRAME {
        bail!("Mensaje demasiado grande o vacío");
    }
    let mut bytes = vec![0u8; size as usize];
    r.read_exact(&mut bytes)?;
    Ok(Some(serde_json::from_slice(&bytes)?))
}
pub fn write_frame(w: &mut impl Write, v: &Value) -> Result<()> {
    let bytes = serde_json::to_vec(v)?;
    if bytes.len() > 1024 * 1024 {
        bail!("Respuesta demasiado grande");
    }
    w.write_all(&(bytes.len() as u32).to_ne_bytes())?;
    w.write_all(&bytes)?;
    w.flush()?;
    Ok(())
}
pub fn is_teams_url(value: &str) -> bool {
    url::Url::parse(value).is_ok_and(|u| {
        u.scheme() == "https"
            && u.username().is_empty()
            && u.password().is_none()
            && matches!(
                u.host_str(),
                Some("teams.microsoft.com" | "teams.cloud.microsoft")
            )
    })
}
fn safe_url(value: &str) -> bool {
    url::Url::parse(value)
        .is_ok_and(|u| u.scheme() == "https" && u.username().is_empty() && u.password().is_none())
        && value.len() < 8192
}
pub fn validate_capture(c: &Capture) -> Result<()> {
    if c.version != 1
        || !is_teams_url(&c.page_url)
        || !matches!(c.coverage.as_str(), "visible" | "selection" | "observed")
    {
        bail!("Captura de Teams inválida");
    }
    if c.messages.len() > 1000
        || c.subject.len() > 256
        || c.title.len() > 1024
        || c.page_url.len() > 8192
    {
        bail!("La captura supera los límites");
    }
    let mut total = 0usize;
    for msg in &c.messages {
        total += msg.text.len();
        if msg.id.is_empty()
            || msg.id.len() > 1024
            || msg.text.len() > 100_000
            || msg.attachments.len() > 50
            || msg.author.as_ref().is_some_and(|a| a.len() > 512)
            || msg.sent_at.as_ref().is_some_and(|s| s.len() > 100)
        {
            bail!("Mensaje de Teams inválido o demasiado grande");
        }
        if msg.url.as_ref().is_some_and(|u| !safe_url(u))
            || msg
                .attachments
                .iter()
                .any(|a| a.name.len() > 1024 || !safe_url(&a.url))
        {
            bail!("Enlace de origen inválido");
        }
    }
    if total > 2 * 1024 * 1024 {
        bail!("Capturá menos mensajes por vez (máximo 2 MB de texto)");
    }
    Ok(())
}
pub fn validate_payload(v: &Value) -> Result<()> {
    match v["type"].as_str() {
        Some("capture") => validate_capture(&serde_json::from_value(v["capture"].clone())?),
        Some("file") => {
            let name = v["name"].as_str().context("Falta nombre")?;
            crate::import::validate_name(name)?;
            let subject = v["subject"].as_str().unwrap_or("");
            if subject.len() > 256 {
                bail!("Materia demasiado larga");
            }
            if let Some(url) = v["originUrl"].as_str() {
                if !safe_url(url) {
                    bail!("Origen inválido");
                }
            }
            if let Some(remote) = v.get("remote") {
                let remote: crate::import::RemoteFile = serde_json::from_value(remote.clone())?;
                remote.key(
                    name,
                    subject,
                    v["originUrl"].as_str().context("Falta el origen remoto")?,
                )?;
            }
            let data = v["data"].as_str().context("Falta archivo")?;
            if data.len() > 28 * 1024 * 1024 {
                bail!("El archivo supera 20 MB");
            }
            let bytes = base64::engine::general_purpose::STANDARD.decode(data)?;
            if bytes.len() > crate::import::MAX_FILE {
                bail!("El archivo supera 20 MB");
            }
            Ok(())
        }
        _ => bail!("Tipo de mensaje no admitido"),
    }
}
pub fn run_host(origin: &str) -> Result<()> {
    if origin != format!("chrome-extension://{}/", extension_id()) {
        bail!("Extensión no autorizada");
    }
    let root = data_dir()?;
    private_dir(&root)?;
    let inbox = root.join("inbox");
    private_dir(&inbox)?;
    let mut input = std::io::stdin().lock();
    let mut output = std::io::stdout().lock();
    while let Some(value) = read_frame(&mut input)? {
        let response = if value["type"] == "ping" {
            json!({"ok":true,"version":1})
        } else {
            let result = (|| -> Result<()> {
                validate_payload(&value)?;
                if std::fs::read_dir(&inbox)?.count() > 500 {
                    bail!("Abrí Lupino para procesar las capturas pendientes");
                }
                let id = uuid::Uuid::new_v4();
                let temp = inbox.join(format!("{id}.part"));
                std::fs::write(&temp, serde_json::to_vec(&value)?)?;
                std::fs::rename(temp, inbox.join(format!("{id}.json")))?;
                Ok(())
            })();
            match result {
                Ok(()) => json!({"ok":true,"queued":true}),
                Err(e) => json!({"ok":false,"error":e.to_string()}),
            }
        };
        write_frame(&mut output, &response)?;
    }
    Ok(())
}
pub fn process_inbox(store: &Store) -> Result<(usize, Vec<String>)> {
    let inbox = store.root.join("inbox");
    std::fs::create_dir_all(&inbox)?;
    let mut count = 0;
    let mut errors = vec![];
    for entry in std::fs::read_dir(&inbox)?.take(100) {
        let path = entry?.path();
        if path.extension().and_then(|s| s.to_str()) != Some("json") {
            continue;
        }
        let result = (|| -> Result<usize> {
            if path.metadata()?.len() > MAX_FRAME as u64 {
                bail!("Captura demasiado grande");
            }
            let value: Value = serde_json::from_slice(&std::fs::read(&path)?)?;
            validate_payload(&value)?;
            if value["type"] == "capture" {
                store.ingest_capture(serde_json::from_value(value["capture"].clone())?)
            } else {
                let bytes = base64::engine::general_purpose::STANDARD
                    .decode(value["data"].as_str().unwrap())?;
                let name = value["name"].as_str().unwrap();
                let subject = value["subject"].as_str().unwrap_or("");
                if let Some(remote) = value.get("remote") {
                    crate::import::import_remote_bytes(
                        store,
                        name,
                        &bytes,
                        subject,
                        value["originUrl"]
                            .as_str()
                            .context("Falta el origen remoto")?,
                        &serde_json::from_value(remote.clone())?,
                    )?;
                } else {
                    crate::import::import_bytes(
                        store,
                        name,
                        &bytes,
                        subject,
                        value["originUrl"].as_str().map(str::to_owned),
                    )?;
                }
                Ok(1)
            }
        })();
        match result {
            Ok(n) => {
                count += n;
                std::fs::remove_file(&path)?;
            }
            Err(e) => {
                let error = e.to_string();
                std::fs::rename(&path, path.with_extension("failed"))?;
                errors.push(error);
            }
        }
    }
    if !errors.is_empty() {
        store.set_preference("inbox_errors", &serde_json::to_string(&errors)?)?;
    }
    Ok((count, errors))
}
