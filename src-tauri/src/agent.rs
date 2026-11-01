use crate::state::AppState;
use anyhow::{bail, Context, Result};
use lupino_core::{ChatMessage, Evidence, StudyEvent};
use serde_json::{json, Value};
use std::{
    io::{BufRead, BufReader, Write},
    path::PathBuf,
    process::{Command, Stdio},
    sync::{Arc, Mutex},
};
use tauri::{Emitter, Manager};
use tauri_plugin_opener::OpenerExt;

fn resources(app: &tauri::AppHandle) -> Result<(PathBuf, PathBuf, Option<PathBuf>)> {
    if cfg!(debug_assertions) {
        let root = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .parent()
            .unwrap()
            .to_owned();
        return Ok((
            PathBuf::from("node"),
            root.join("dist/agent/index.js"),
            Some(root.join("node_modules/@openai/codex/bin/codex.js")),
        ));
    }
    let root = app.path().resource_dir()?.join("resources");
    Ok((
        root.join(if cfg!(windows) {
            "runtime/node.exe"
        } else {
            "runtime/node"
        }),
        root.join("agent/index.js"),
        Some(root.join("codex/node_modules/@openai/codex/bin/codex.js")),
    ))
}
pub fn run(
    app: &tauri::AppHandle,
    run_id: &str,
    request: Value,
    subject: Option<String>,
    conversation: Option<String>,
) -> Result<Value> {
    let state = app.state::<AppState>();
    let provider = request["provider"].as_str().context("Falta proveedor")?;
    if !["chatgpt", "claude", "cursor"].contains(&provider) {
        bail!("Proveedor no admitido");
    }
    if request["action"] == "chat" {
        if !state.workers.contains(run_id) {
            bail!("Consulta cancelada");
        }
    } else if !state.workers.reserve(run_id) {
        bail!("La operación ya está en curso");
    }
    struct Cleanup<'a> {
        state: &'a AppState,
        id: &'a str,
    }
    impl Drop for Cleanup<'_> {
        fn drop(&mut self) {
            self.state.workers.remove(self.id);
        }
    }
    let _cleanup = Cleanup {
        state: &state,
        id: run_id,
    };
    let (node, entry, codex) = resources(app)?;
    if !entry.exists() {
        bail!("Falta el bridge de IA. Ejecutá npm run build:agent o reinstalá Lupino.");
    }
    let workspace = state.root.join("agent-workspace");
    lupino_core::native::private_dir(&workspace)?;
    let mut cmd = Command::new(node);
    cmd.arg(entry)
        .current_dir(&workspace)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .env_clear();
    for name in [
        "PATH",
        "HOME",
        "USERPROFILE",
        "APPDATA",
        "LOCALAPPDATA",
        "SystemRoot",
        "WINDIR",
        "TEMP",
        "TMP",
        "TMPDIR",
        "XDG_RUNTIME_DIR",
        "DBUS_SESSION_BUS_ADDRESS",
        "DISPLAY",
        "WAYLAND_DISPLAY",
        "LANG",
        "SSL_CERT_FILE",
        "SSL_CERT_DIR",
    ] {
        if let Some(value) = std::env::var_os(name) {
            cmd.env(name, value);
        }
    }
    cmd.env("LUPINO_AGENT_WORKSPACE", &workspace)
        .env("CODEX_HOME", state.root.join("codex"))
        .env("CLAUDE_CONFIG_DIR", state.root.join("claude"));
    if let Some(entry) = codex {
        cmd.env("LUPINO_CODEX_ENTRY", entry);
    }
    if let Some(key) = state.secret(provider) {
        cmd.env(
            if provider == "claude" {
                "ANTHROPIC_API_KEY"
            } else {
                "CURSOR_API_KEY"
            },
            key,
        );
    }
    #[cfg(unix)]
    {
        use std::os::unix::process::CommandExt;
        cmd.process_group(0);
    }
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(0x08000000);
    }
    let mut child = cmd.spawn().context("No se pudo iniciar el runtime de IA")?;
    let mut stdin = child
        .stdin
        .take()
        .context("No se pudo abrir el canal de IA")?;
    let stdout = child
        .stdout
        .take()
        .context("No se pudo leer el canal de IA")?;
    let child = Arc::new(Mutex::new(child));
    if !state.workers.attach(run_id, child.clone()) {
        stop_child(&child);
        bail!("Consulta cancelada");
    }
    let result = (|| -> Result<Value> {
        let mut evidence: Vec<Evidence> = request["context"]
            .as_array()
            .map(|items| {
                items
                    .iter()
                    .filter_map(|i| serde_json::from_value(i.clone()).ok())
                    .collect()
            })
            .unwrap_or_default();
        writeln!(stdin, "{}", request)?;
        let mut terminal = None;
        let mut credential_note = String::new();
        for line in BufReader::new(stdout).lines() {
            let line = line?;
            if line.len() > 2_000_000 {
                bail!("Respuesta de IA demasiado grande");
            }
            let mut v: Value = serde_json::from_str(&line)
                .context("El proveedor devolvió una respuesta inválida")?;
            match v["type"].as_str() {
                Some("tool_call") => {
                    let value = tool(
                        &state,
                        v["name"].as_str().unwrap_or(""),
                        &v["args"],
                        subject.as_deref(),
                        request["sourceId"].as_str(),
                        &mut evidence,
                    );
                    let reply = match value {
                        Ok(result) => {
                            json!({"type":"tool_result","id":v["id"],"result":result,"citationCount":evidence.len()})
                        }
                        Err(e) => json!({"type":"tool_result","id":v["id"],"error":e.to_string()}),
                    };
                    writeln!(stdin, "{reply}")?;
                }
                Some("credential") => {
                    let note = state.save_secret(
                        provider,
                        v["value"].as_str().context("Credencial inválida")?,
                    )?;
                    credential_note = note;
                }
                Some("auth") => {
                    let url = v["url"].as_str().context("URL de acceso inválida")?;
                    // Authorization URLs originate only from the provider's official SDK/runtime.
                    let host = url::Url::parse(url)?;
                    if host.scheme() != "https"
                        || !matches!(
                            host.host_str(),
                            Some(
                                "auth.openai.com"
                                    | "chatgpt.com"
                                    | "cursor.com"
                                    | "www.cursor.com"
                                    | "auth.cursor.com"
                            )
                        )
                    {
                        bail!("El proveedor devolvió un dominio de acceso inesperado");
                    }
                    app.opener().open_url(url, None::<&str>)?;
                    let _=app.emit("agent-event",json!({"runId":run_id,"type":"status","message":"Completá el acceso en el navegador."}));
                }
                Some("result") => {
                    if !credential_note.is_empty() {
                        v["data"] =
                            crate::state::provider_result(v["data"].clone(), &credential_note);
                    }
                    v["evidence"] = serde_json::to_value(&evidence)?;
                    if let (Some(cid), Some(text)) = (conversation.as_deref(), v["text"].as_str()) {
                        state.store()?.add_message(
                            cid,
                            &ChatMessage {
                                id: uuid::Uuid::new_v4().to_string(),
                                role: "assistant".into(),
                                content: text.into(),
                                provider: provider.into(),
                                created_at: chrono::Utc::now().to_rfc3339(),
                                evidence: evidence.clone(),
                            },
                        )?;
                    }
                    v["runId"] = json!(run_id);
                    v["conversationId"] = json!(conversation);
                    let _ = app.emit("agent-event", &v);
                    terminal = Some(v);
                    break;
                }
                Some("error") => {
                    bail!("{}", v["message"].as_str().unwrap_or("La consulta falló"));
                }
                _ => {
                    v["runId"] = json!(run_id);
                    v["conversationId"] = json!(conversation);
                    let _ = app.emit("agent-event", v);
                }
            }
        }
        terminal.context("El proceso de IA terminó sin completar la operación")
    })();
    // Release every descendant even when the SDK did not close its own workers.
    stop_child(&child);
    state.workers.remove(run_id);
    result
}

pub fn stop_child(child: &Arc<Mutex<std::process::Child>>) {
    if let Ok(mut child) = child.lock() {
        if child.try_wait().ok().flatten().is_none() {
            #[cfg(unix)]
            unsafe {
                libc::kill(-(child.id() as i32), libc::SIGTERM);
            }
            #[cfg(windows)]
            {
                let _ = Command::new("taskkill")
                    .args(["/PID", &child.id().to_string(), "/T", "/F"])
                    .output();
            }
            let _ = child.kill();
        }
        let _ = child.wait();
    }
}
fn with_citation(item: Evidence, evidence: &mut Vec<Evidence>) -> Value {
    let index = if let Some(i) = evidence.iter().position(|e| e.id == item.id) {
        i
    } else {
        evidence.push(item.clone());
        evidence.len() - 1
    };
    let mut value = serde_json::to_value(item).unwrap();
    value["citation"] = json!(index + 1);
    value
}
pub fn tool(
    state: &AppState,
    name: &str,
    args: &Value,
    subject: Option<&str>,
    source_id: Option<&str>,
    evidence: &mut Vec<Evidence>,
) -> Result<Value> {
    let store = state.store()?;
    match name {
        "list_sources" => Ok(json!(store
            .sources()?
            .into_iter()
            .filter(
                |s| subject.is_none_or(|m| m == s.subject) && source_id.is_none_or(|id| id == s.id)
            )
            .take(200)
            .collect::<Vec<_>>())),
        "search_sources" => {
            let query = args["query"].as_str().context("Falta búsqueda")?;
            Ok(json!(store
                .search_in(query, subject, source_id)?
                .into_iter()
                .map(|e| with_citation(e, evidence))
                .collect::<Vec<_>>()))
        }
        "read_source" => {
            let id = args["id"].as_str().context("Falta fuente")?;
            if source_id.is_some_and(|selected| selected != id) {
                bail!("La fuente está fuera del documento seleccionado");
            }
            let source = store.source(id)?;
            if subject.is_some_and(|s| s != source.source.subject) {
                bail!("La fuente no pertenece a la materia seleccionada");
            }
            let offset = args["offset"].as_u64().unwrap_or(0) as usize;
            let total = source.chunks.len();
            Ok(
                json!({"source":source.source,"totalChunks":total,"offset":offset,"chunks":source.chunks.into_iter().skip(offset).take(8).map(|e|with_citation(e,evidence)).collect::<Vec<_>>()}),
            )
        }
        "list_events" => Ok(json!(store
            .events()?
            .into_iter()
            .filter(|e| subject.is_none_or(|s| s == e.subject)
                && source_id.is_none_or(|id| e.source_id.as_deref() == Some(id)))
            .collect::<Vec<_>>())),
        "propose_event" => {
            let chunk_id = args["chunkId"].as_str().context("Falta evidencia")?;
            let chunk = evidence
                .iter()
                .find(|e| e.id == chunk_id)
                .context("Primero hay que leer el fragmento que respalda la fecha")?;
            let quote = args["evidence"].as_str().context("Falta cita")?;
            if quote.is_empty() || !chunk.text.contains(quote) {
                bail!("La cita no aparece en la fuente");
            }
            let date = args["date"].as_str().context("Falta fecha")?;
            let event = StudyEvent {
                id: lupino_core::store::digest(format!("ai:{}:{}:{}", chunk.id, date, quote)),
                title: args["title"].as_str().context("Falta título")?.into(),
                subject: chunk.subject.clone(),
                kind: args["kind"].as_str().context("Falta tipo")?.into(),
                date: date.into(),
                time: args["time"].as_str().map(str::to_owned),
                all_day: args["time"].is_null(),
                status: "pending".into(),
                evidence: quote.into(),
                chunk_id: Some(chunk.id.clone()),
                source_id: Some(chunk.source_id.clone()),
                manually_edited: false,
                note: args["note"]
                    .as_str()
                    .unwrap_or("Propuesta de IA: revisá la fecha.")
                    .into(),
            };
            if store.events()?.iter().any(|old| old.id == event.id) {
                return Ok(json!({"status":"already_exists","id":event.id}));
            }
            let id = store.save_event(event)?;
            let _ = id;
            Ok(json!({"status":"pending","message":"Fecha propuesta, pendiente de revisión."}))
        }
        _ => bail!("Herramienta no autorizada"),
    }
}
