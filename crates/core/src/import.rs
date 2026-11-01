use crate::{NewSource, Store};
use anyhow::{bail, Context, Result};
use std::io::{Cursor, Read};
pub const MAX_FILE: usize = 20 * 1024 * 1024;

#[derive(Debug, Clone, serde::Deserialize, serde::Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RemoteFile {
    pub id: String,
    pub path: String,
    pub modified_at: String,
}
impl RemoteFile {
    pub fn key(&self, name: &str, subject: &str, origin: &str) -> Result<String> {
        validate_name(name)?;
        let url = url::Url::parse(origin)?;
        let host = url.host_str().unwrap_or("");
        if url.scheme() != "https"
            || !host.ends_with(".sharepoint.com")
            || !url.username().is_empty()
            || url.password().is_some()
            || url.port().is_some()
            || origin.len() > 8192
            || self.path.len() > 1024
            || self.path.contains(['\\', '\0'])
            || self
                .path
                .split('/')
                .any(|part| part.is_empty() || part == "." || part == "..")
            || self.path.rsplit('/').next() != Some(name)
        {
            bail!("Origen o ruta de SharePoint inválido");
        }
        let id = uuid::Uuid::parse_str(&self.id).context("Identificador remoto inválido")?;
        self.modified_time()?;
        Ok(format!("sharepoint:{host}:{id}:{}", subject.trim()))
    }
    fn modified_time(&self) -> Result<i64> {
        Ok(chrono::DateTime::parse_from_rfc3339(&self.modified_at)
            .context("Fecha de versión remota inválida")?
            .timestamp_millis())
    }
}

pub fn validate_name(name: &str) -> Result<()> {
    if name.is_empty()
        || name.len() > 255
        || name.contains(['/', '\\', '\0', ':'])
        || name == "."
        || name == ".."
    {
        bail!("Nombre de archivo inválido");
    }
    Ok(())
}
pub fn parse_bytes(name: &str, bytes: &[u8]) -> Result<Vec<(String, String)>> {
    validate_name(name)?;
    if bytes.len() > MAX_FILE {
        bail!("El límite por archivo es 20 MB");
    }
    let ext = name.rsplit('.').next().unwrap_or("").to_lowercase();
    match ext.as_str() {
        "txt" | "md" | "markdown" => Ok(vec![(
            "Texto".into(),
            String::from_utf8(bytes.to_vec()).context("El texto debe estar codificado en UTF-8")?,
        )]),
        "pdf" => crate::pdf_worker::parse(bytes),
        "docx" | "pptx" => {
            let mut zip = zip::ZipArchive::new(Cursor::new(bytes))
                .context("El documento no es un archivo Office válido")?;
            if zip.len() > 10000 {
                bail!("El documento contiene demasiados elementos");
            }
            let mut sections = Vec::new();
            let mut total = 0u64;
            let mut names = Vec::new();
            for i in 0..zip.len() {
                let f = zip.by_index(i)?;
                total = total.saturating_add(f.size());
                if total > 100 * 1024 * 1024 {
                    bail!("El documento descomprimido supera el límite");
                }
                names.push(f.name().to_owned());
            }
            names.sort_by_key(|s| {
                s.strip_prefix("ppt/slides/slide")
                    .and_then(|s| s.strip_suffix(".xml"))
                    .and_then(|s| s.parse::<u32>().ok())
                    .unwrap_or(0)
            });
            for name in names {
                if !(ext == "docx" && name == "word/document.xml"
                    || ext == "pptx"
                        && name.starts_with("ppt/slides/slide")
                        && name.ends_with(".xml"))
                {
                    continue;
                }
                let mut xml = String::new();
                zip.by_name(&name)?
                    .take(16 * 1024 * 1024)
                    .read_to_string(&mut xml)?;
                let doc = roxmltree::Document::parse(&xml)
                    .context("No se pudo leer el texto del documento")?;
                if ext == "docx" {
                    let mut paragraph = 0;
                    let mut row = 0;
                    // A table row is one piece of evidence: splitting its cells into
                    // paragraphs separates dates from the exam they describe.
                    for node in doc.descendants().filter(|n| n.is_element()) {
                        let kind = node.tag_name().name();
                        if !matches!(kind, "p" | "tr")
                            || node
                                .ancestors()
                                .skip(1)
                                .any(|a| a.is_element() && a.tag_name().name() == "tr")
                        {
                            continue;
                        }
                        let text = if kind == "tr" {
                            node.children()
                                .filter(|n| n.is_element() && n.tag_name().name() == "tc")
                                .map(|cell| {
                                    cell.descendants()
                                        .filter(|n| n.is_element() && n.tag_name().name() == "p")
                                        .map(office_paragraph)
                                        .filter(|t| !t.trim().is_empty())
                                        .collect::<Vec<_>>()
                                        .join(" ")
                                })
                                .collect::<Vec<_>>()
                                .join(" | ")
                        } else {
                            office_paragraph(node)
                        };
                        if text.trim_matches([' ', '|']).is_empty() {
                            continue;
                        }
                        let locator = if kind == "tr" {
                            row += 1;
                            format!("Fila de tabla {row}")
                        } else {
                            paragraph += 1;
                            format!("Párrafo {paragraph}")
                        };
                        sections.push((locator, text));
                    }
                    continue;
                }
                let mut paragraphs = Vec::new();
                for p in doc
                    .descendants()
                    .filter(|n| n.is_element() && n.tag_name().name() == "p")
                {
                    let text = office_paragraph(p);
                    if !text.trim().is_empty() {
                        paragraphs.push(text);
                    }
                }
                let number = name
                    .trim_start_matches("ppt/slides/slide")
                    .trim_end_matches(".xml");
                sections.push((format!("Diapositiva {}", number), paragraphs.join("\n")));
            }
            if sections.is_empty() {
                bail!("El documento no contiene texto extraíble");
            }
            Ok(sections)
        }
        _ => bail!("Formato no compatible. Usá PDF, DOCX, PPTX, TXT o Markdown."),
    }
}
fn office_paragraph(node: roxmltree::Node<'_, '_>) -> String {
    node.descendants()
        .filter(|n| n.is_element() && n.tag_name().name() == "t")
        .filter_map(|n| n.text())
        .collect()
}
pub fn import_bytes(
    store: &Store,
    name: &str,
    bytes: &[u8],
    subject: &str,
    origin: Option<String>,
) -> Result<String> {
    import_document(store, name, bytes, subject, origin, None)
}
pub fn import_remote_bytes(
    store: &Store,
    name: &str,
    bytes: &[u8],
    subject: &str,
    origin: &str,
    remote: &RemoteFile,
) -> Result<String> {
    let key = remote.key(name, subject, origin)?;
    import_document(
        store,
        name,
        bytes,
        subject,
        Some(origin.into()),
        Some((key, &remote.path, remote.modified_time()?)),
    )
}
fn import_document(
    store: &Store,
    name: &str,
    bytes: &[u8],
    subject: &str,
    origin: Option<String>,
    remote: Option<(String, &str, i64)>,
) -> Result<String> {
    let sections = parse_bytes(name, bytes)?;
    let hash = crate::store::digest(bytes);
    let ext = name.rsplit('.').next().unwrap_or("txt").to_lowercase();
    let dir = store.root.join("originals");
    std::fs::create_dir_all(&dir)?;
    std::fs::write(dir.join(format!("{hash}.{ext}")), bytes)?;
    let empty = sections.iter().all(|(_, s)| s.trim().is_empty());
    let subject = if subject.trim().is_empty() {
        "Sin materia"
    } else {
        subject.trim()
    };
    let modified = remote.as_ref().map(|r| r.2);
    let (key, title, _) = remote.unwrap_or_else(|| (format!("file:{hash}:{subject}"), name, 0));
    Ok(store
        .ingest_source_versioned(
            NewSource {
                key,
                title: title.into(),
                subject: subject.into(),
                kind: ext.clone(),
                origin_url: origin,
                author: None,
                published_at: None,
                attachments: vec![],
                sections,
                status: if empty && ext == "pdf" {
                    "needs_ocr"
                } else {
                    "ready"
                }
                .into(),
            },
            modified,
        )?
        .0)
}
