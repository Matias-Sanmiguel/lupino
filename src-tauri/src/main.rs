#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]
mod agent;
mod integration;
mod state;
mod workers;
use lupino_core::{import, native, ChatMessage, Evidence, Snapshot, SourceDetail, StudyEvent};
use serde_json::{json, Value};
use state::AppState;
use std::{collections::HashMap, sync::Mutex};
use tauri::{Emitter, Manager, State};
use tauri_plugin_notification::NotificationExt;
type ApiResult<T> = Result<T, String>;
fn err(e: impl std::fmt::Display) -> String {
    e.to_string()
}

#[tauri::command]
fn snapshot(state: State<'_, AppState>) -> ApiResult<Snapshot> {
    let s = state.store().map_err(err)?;
    Ok(Snapshot {
        sources: s.sources().map_err(err)?,
        events: s.events().map_err(err)?,
        conversations: s.conversations().map_err(err)?,
        inbox_errors: s
            .preference("inbox_errors")
            .map_err(err)?
            .and_then(|s| serde_json::from_str(&s).ok())
            .unwrap_or_default(),
    })
}
#[tauri::command]
fn search(
    state: State<'_, AppState>,
    query: String,
    subject: Option<String>,
) -> ApiResult<Vec<Evidence>> {
    state
        .store()
        .map_err(err)?
        .search(&query, subject.as_deref())
        .map_err(err)
}
#[tauri::command]
fn read_source(state: State<'_, AppState>, id: String) -> ApiResult<SourceDetail> {
    state.store().map_err(err)?.source(&id).map_err(err)
}
#[tauri::command]
fn load_conversation(state: State<'_, AppState>, id: String) -> ApiResult<Vec<ChatMessage>> {
    state.store().map_err(err)?.messages(&id).map_err(err)
}
#[tauri::command]
fn save_event(state: State<'_, AppState>, event: StudyEvent) -> ApiResult<String> {
    state.store().map_err(err)?.save_event(event).map_err(err)
}
#[tauri::command]
async fn export_calendar(app: tauri::AppHandle, contents: String) -> ApiResult<Option<String>> {
    if contents.len() > 4 * 1024 * 1024 || !contents.starts_with("BEGIN:VCALENDAR\r\n") {
        return Err("El calendario no es válido o supera el límite de exportación.".into());
    }
    tauri::async_runtime::spawn_blocking(move || {
        use tauri_plugin_dialog::DialogExt;
        let Some(file) = app.dialog().file().add_filter("Calendario", &["ics"])
            .set_file_name("Lupino.ics").blocking_save_file() else { return Ok(None) };
        let path = file.into_path().map_err(err)?;
        std::fs::write(&path, contents).map_err(err)?;
        Ok(Some(path.to_string_lossy().into_owned()))
    }).await.map_err(err)?
}
#[tauri::command]
async fn import_files(
    app: tauri::AppHandle,
    paths: Vec<String>,
    subject: String,
) -> ApiResult<Value> {
    if paths.len() > 50 {
        return Err("Importá hasta 50 archivos por vez.".into());
    }
    tauri::async_runtime::spawn_blocking(move || {
        let state = app.state::<AppState>();
        let store = state.store().map_err(err)?;
        let mut ids = vec![];
        let mut errors = vec![];
        for path in paths {
            let result = (|| -> anyhow::Result<String> {
                let p = std::path::Path::new(&path);
                let meta = p.metadata()?;
                if !meta.is_file() || meta.len() > import::MAX_FILE as u64 {
                    anyhow::bail!("El límite es 20 MB por archivo");
                }
                let name = p
                    .file_name()
                    .and_then(|s| s.to_str())
                    .ok_or_else(|| anyhow::anyhow!("Nombre inválido"))?;
                import::import_bytes(&store, name, &std::fs::read(p)?, &subject, None)
            })();
            match result {
                Ok(id) => ids.push(id),
                Err(e) => errors.push(format!(
                    "{}: {}",
                    std::path::Path::new(&path)
                        .file_name()
                        .unwrap_or_default()
                        .to_string_lossy(),
                    e
                )),
            }
        }
        let _ = app.emit("library-changed", ());
        Ok(json!({"ids":ids,"errors":errors}))
    })
    .await
    .map_err(err)?
}
#[tauri::command]
async fn import_text(
    app: tauri::AppHandle,
    title: String,
    text: String,
    subject: String,
) -> ApiResult<String> {
    if text.len() > 2 * 1024 * 1024 || text.trim().is_empty() {
        return Err("Ingresá un texto de hasta 2 MB.".into());
    }
    tauri::async_runtime::spawn_blocking(move || {
        let state = app.state::<AppState>();
        let store = state.store().map_err(err)?;
        let id = store
            .ingest_source(lupino_core::NewSource {
                key: format!("text:{}:{}", subject, lupino_core::store::digest(&text)),
                title: if title.trim().is_empty() {
                    "Texto importado".into()
                } else {
                    title
                },
                subject: if subject.trim().is_empty() {
                    "Sin materia".into()
                } else {
                    subject
                },
                kind: "texto".into(),
                origin_url: None,
                author: None,
                published_at: None,
                attachments: vec![],
                sections: vec![("Texto".into(), text)],
                status: "ready".into(),
            })
            .map_err(err)?
            .0;
        let _ = app.emit("library-changed", ());
        Ok(id)
    })
    .await
    .map_err(err)?
}
#[tauri::command]
fn register_extension(state: State<'_, AppState>) -> ApiResult<String> {
    integration::register_host(&state.root).map_err(err)
}
#[tauri::command]
fn open_extension_folder(app: tauri::AppHandle) -> ApiResult<String> {
    use tauri_plugin_opener::OpenerExt;
    let source = if cfg!(debug_assertions) {
        std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .parent()
            .unwrap()
            .join("dist/extension")
    } else {
        app.path()
            .resource_dir()
            .map_err(err)?
            .join("resources/extension")
    };
    let destination = app.state::<AppState>().root.join("browser-extension");
    native::private_dir(&destination).map_err(err)?;
    for file in [
        "manifest.json",
        "popup.html",
        "popup.js",
        "content.js",
        "background.js",
    ] {
        std::fs::copy(source.join(file), destination.join(file)).map_err(|e| {
            format!("Falta la extensión compilada. Ejecutá npm run build:extension. {e}")
        })?;
    }
    app.opener()
        .open_path(destination.to_string_lossy(), None::<&str>)
        .map_err(err)?;
    Ok(destination.to_string_lossy().into_owned())
}
#[tauri::command]
async fn providers_status(app: tauri::AppHandle) -> ApiResult<Value> {
    tauri::async_runtime::spawn_blocking(move || {
        let mut values = vec![];
        for (provider, name) in [
            ("chatgpt", "ChatGPT"),
            ("claude", "Claude"),
            ("cursor", "Cursor"),
        ] {
            let id = uuid::Uuid::new_v4().to_string();
            let r = agent::run(
                &app,
                &id,
                json!({"action":"status","provider":provider}),
                None,
                None,
            );
            let mut data = match r {
                Ok(v) => v["data"].clone(),
                Err(e) => json!({"connected":false,"detail":e.to_string(),"models":[]}),
            };
            data["id"] = json!(provider);
            data["name"] = json!(name);
            values.push(data);
        }
        Ok(json!(values))
    })
    .await
    .map_err(err)?
}
#[tauri::command]
async fn provider_action(
    app: tauri::AppHandle,
    provider: String,
    action: String,
    api_key: Option<String>,
) -> ApiResult<Value> {
    if !["chatgpt", "claude", "cursor"].contains(&provider.as_str())
        || !["login", "save_key", "logout", "status"].contains(&action.as_str())
    {
        return Err("Acción inválida".into());
    }
    tauri::async_runtime::spawn_blocking(move||{
        let state=app.state::<AppState>();let mut note=String::new();
        if action=="logout"&&provider!="chatgpt"{state.clear_secret(&provider).map_err(err)?;return Ok(json!({"connected":false,"detail":"Sesión local cerrada. Podés revocar la clave desde el proveedor.","models":[]}));}
        if action=="save_key"{note=state.save_secret(&provider,api_key.as_deref().unwrap_or("")).map_err(err)?;}
        let request=json!({"action":if action=="save_key"{"status"}else{&action},"provider":provider});
        let result=agent::run(&app,&uuid::Uuid::new_v4().to_string(),request,None,None).map_err(err)?;Ok(state::provider_result(result["data"].clone(),&note))
    }).await.map_err(err)?
}
#[tauri::command]
fn chat_start(
    app: tauri::AppHandle,
    run_id: String,
    conversation_id: Option<String>,
    prompt: String,
    provider: String,
    model: Option<String>,
    subject: Option<String>,
    source_id: Option<String>,
) -> ApiResult<Value> {
    if uuid::Uuid::parse_str(&run_id).is_err() || prompt.trim().is_empty() || prompt.len() > 50000 {
        return Err("Consulta inválida o demasiado larga".into());
    }
    let model = model.map(|value| value.trim().to_owned())
        .filter(|value| !value.is_empty() && value.len() <= 200)
        .ok_or_else(|| "Elegí un modelo antes de enviar la consulta.".to_string())?;
    let state = app.state::<AppState>();
    let store = state.store().map_err(err)?;
    if !["chatgpt", "claude", "cursor"].contains(&provider.as_str()) {
        return Err("Proveedor no admitido".into());
    }
    if let Some(id) = &source_id {
        let document = store.source(id).map_err(err)?;
        if subject
            .as_ref()
            .is_some_and(|s| s != &document.source.subject)
        {
            return Err("El documento no pertenece a la materia elegida".into());
        }
    }
    let cid = match conversation_id {
        Some(id) => {
            if !store
                .conversations()
                .map_err(err)?
                .iter()
                .any(|c| c.id == id)
            {
                return Err("Conversación no encontrada".into());
            }
            id
        }
        None => store.create_conversation(&prompt).map_err(err)?,
    };
    let history = store
        .messages(&cid)
        .map_err(err)?
        .into_iter()
        .filter(|m| m.role == "user" || m.role == "assistant")
        .map(|m| json!({"role":m.role,"content":m.content}))
        .collect::<Vec<_>>();
    let context = store
        .search_in(&prompt, subject.as_deref(), source_id.as_deref())
        .map_err(err)?
        .into_iter()
        .enumerate()
        .map(|(i, e)| {
            let mut v = serde_json::to_value(e).unwrap();
            v["citation"] = json!(i + 1);
            v
        })
        .collect::<Vec<_>>();
    store
        .add_message(
            &cid,
            &ChatMessage {
                id: uuid::Uuid::new_v4().to_string(),
                role: "user".into(),
                content: prompt.clone(),
                provider: provider.clone(),
                created_at: chrono::Utc::now().to_rfc3339(),
                evidence: vec![],
            },
        )
        .map_err(err)?;
    if !state.workers.reserve(&run_id) {
        return Err("La consulta ya está en curso".into());
    }
    let conversation = cid.clone();
    let run = run_id.clone();
    std::thread::spawn(move || {
        let result = agent::run(
            &app,
            &run,
            json!({"action":"chat","provider":provider,"model":model,"prompt":prompt,"context":context,"history":history,"sourceId":source_id}),
            subject,
            Some(conversation.clone()),
        );
        if let Err(e) = result {
            let _=app.emit("agent-event",json!({"runId":run,"conversationId":conversation,"type":"error","message":e.to_string()}));
        }
        let _ = app.emit("library-changed", ());
    });
    Ok(json!({"runId":run_id,"conversationId":cid}))
}
#[tauri::command]
fn chat_cancel(state: State<'_, AppState>, run_id: String) -> ApiResult<()> {
    let child = state.workers.remove(&run_id);
    if let Some(child) = child {
        agent::stop_child(&child);
    }
    Ok(())
}

#[tauri::command]
fn reminder_settings(
    state: State<'_, AppState>,
) -> ApiResult<lupino_core::reminders::ReminderSettings> {
    Ok(state
        .store()
        .map_err(err)?
        .preference("reminders")
        .map_err(err)?
        .and_then(|v| serde_json::from_str(&v).ok())
        .unwrap_or_default())
}
#[tauri::command]
fn save_reminder_settings(
    state: State<'_, AppState>,
    settings: lupino_core::reminders::ReminderSettings,
) -> ApiResult<()> {
    chrono::NaiveTime::parse_from_str(&settings.all_day_time, "%H:%M")
        .map_err(|_| "Hora inválida")?;
    state
        .store()
        .map_err(err)?
        .set_preference("reminders", &serde_json::to_string(&settings).map_err(err)?)
        .map_err(err)
}

fn background(app: tauri::AppHandle) {
    std::thread::spawn(move || loop {
        std::thread::sleep(std::time::Duration::from_secs(5));
        let state = app.state::<AppState>();
        let Ok(store) = state.store() else { continue };
        if let Ok((count, errors)) = native::process_inbox(&store) {
            if count > 0 || !errors.is_empty() {
                let _ = app.emit("library-changed", ());
            }
        }
        let settings: lupino_core::reminders::ReminderSettings = store
            .preference("reminders")
            .ok()
            .flatten()
            .and_then(|v| serde_json::from_str(&v).ok())
            .unwrap_or_default();
        if let Ok(events) = store.events() {
            let due: Vec<_> = events
                .into_iter()
                .filter_map(|event| {
                    lupino_core::reminders::reminder_key(&event, chrono::Local::now(), &settings)
                        .map(|key| (event, key))
                })
                .filter(|(_, key)| !store.was_notified(key).unwrap_or(true))
                .collect();
            if !due.is_empty() {
                let title = if due.len() == 1 {
                    due[0].0.title.clone()
                } else {
                    format!("{} fechas próximas", due.len())
                };
                let body = due
                    .iter()
                    .take(5)
                    .map(|(e, _)| {
                        format!(
                            "{} · {}{}",
                            e.subject,
                            e.date,
                            e.time
                                .as_ref()
                                .map(|t| format!(" a las {t}"))
                                .unwrap_or_else(|| " · todo el día".into())
                        )
                    })
                    .collect::<Vec<_>>()
                    .join("\n");
                if app
                    .notification()
                    .builder()
                    .title(title)
                    .body(body)
                    .show()
                    .is_ok()
                {
                    for (_, key) in due {
                        let _ = store.mark_notified(&key);
                    }
                }
            }
        }
    });
}
fn main() {
    if std::env::args().any(|a| a == "--lupino-parse-pdf") {
        if let Err(e) = lupino_core::pdf_worker::run() {
            eprintln!("{e}");
            std::process::exit(1);
        }
        return;
    }
    if let Ok(exe) = std::env::current_exe() {
        lupino_core::pdf_worker::configure(exe);
    }

    if let Some(origin) = std::env::args().find(|a| a.starts_with("chrome-extension://")) {
        if let Err(e) = native::run_host(&origin) {
            eprintln!("Lupino native host: {e}");
            std::process::exit(1);
        }
        return;
    }
    let root = native::data_dir().expect("No se pudo localizar el directorio de datos");
    native::private_dir(&root).expect("No se pudo crear el directorio de datos");
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_notification::init())
        .manage(AppState {
            root,
            workers: workers::Workers::default(),
            secrets: Mutex::new(HashMap::new()),
        })
        .invoke_handler(tauri::generate_handler![
            reminder_settings,
            save_reminder_settings,
            snapshot,
            search,
            read_source,
            load_conversation,
            save_event,
            export_calendar,
            import_files,
            import_text,
            register_extension,
            open_extension_folder,
            providers_status,
            provider_action,
            chat_start,
            chat_cancel
        ])
        .setup(|app| {
            app.state::<AppState>().store()?;
            use tauri::{
                menu::{Menu, MenuItem},
                tray::TrayIconBuilder,
            };
            let show = MenuItem::with_id(app, "show", "Abrir Lupino", true, None::<&str>)?;
            let quit = MenuItem::with_id(app, "quit", "Salir", true, None::<&str>)?;
            let menu = Menu::with_items(app, &[&show, &quit])?;
            let mut tray = TrayIconBuilder::new()
                .menu(&menu)
                .tooltip("Lupino · tu espacio de estudio")
                .on_menu_event(|app, event| match event.id.as_ref() {
                    "show" => {
                        if let Some(w) = app.get_webview_window("main") {
                            let _ = w.show();
                            let _ = w.set_focus();
                        }
                    }
                    "quit" => {
                        for child in app.state::<AppState>().workers.children() {
                            agent::stop_child(&child);
                        }
                        app.exit(0);
                    }
                    _ => {}
                });
            if let Some(icon) = app.default_window_icon() {
                tray = tray.icon(icon.clone());
            }
            tray.build(app)?;
            background(app.handle().clone());
            Ok(())
        })
        .on_window_event(|window, event| {
            if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                api.prevent_close();
                let _ = window.hide();
            }
        })
        .run(tauri::generate_context!())
        .expect("No se pudo iniciar Lupino");
}
