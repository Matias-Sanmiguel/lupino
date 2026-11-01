use lupino_core::{Capture, CapturedMessage, Store};
use tempfile::tempdir;

fn capture(text: &str) -> Capture {
    Capture {
        version: 1,
        page_url: "https://teams.microsoft.com/v2/".into(),
        subject: "Álgebra".into(),
        title: "General".into(),
        captured_at: "2026-11-01T12:00:00Z".into(),
        coverage: "visible".into(),
        messages: vec![CapturedMessage {
            id: "m1".into(),
            text: text.into(),
            author: Some("Profesora".into()),
            sent_at: Some("2026-11-01T10:00:00Z".into()),
            url: None,
            attachments: vec![],
        }],
    }
}

#[test]
fn capture_is_idempotent_and_preserves_old_evidence_after_edit() {
    let dir = tempdir().unwrap();
    let store = Store::open(dir.path()).unwrap();
    store
        .ingest_capture(capture("Parcial de matrices el 12/11/2026"))
        .unwrap();
    let old = store.search("matrices", None).unwrap();
    assert_eq!(old.len(), 1);
    store
        .ingest_capture(capture("Parcial de matrices el 12/11/2026"))
        .unwrap();
    assert_eq!(store.sources().unwrap().len(), 1);
    store
        .ingest_capture(capture("Parcial de determinantes el 19/11/2026"))
        .unwrap();
    assert!(store.search("matrices", None).unwrap().is_empty());
    assert!(store
        .read_chunk(&old[0].id)
        .unwrap()
        .text
        .contains("12/11/2026"));
    assert_eq!(
        store
            .search("determinantes", Some("Otra materia"))
            .unwrap()
            .len(),
        0
    );
    assert!(store.search("\" OR * ; DROP TABLE sources;", None).is_ok());
}

#[test]
fn rejects_non_teams_origins_and_does_not_treat_partial_capture_as_deletion() {
    let dir = tempdir().unwrap();
    let store = Store::open(dir.path()).unwrap();
    let mut bad = capture("hola");
    bad.page_url = "https://teams.microsoft.com.evil.test/".into();
    assert!(store.ingest_capture(bad).is_err());
    store.ingest_capture(capture("Mensaje útil")).unwrap();
    let mut empty = capture("");
    empty.messages.clear();
    store.ingest_capture(empty).unwrap();
    assert_eq!(store.sources().unwrap().len(), 1);
}

#[test]
fn calendar_requires_evidence_and_keeps_uncertain_dates_pending() {
    let dir = tempdir().unwrap();
    let store = Store::open(dir.path()).unwrap();
    store
        .ingest_capture(capture("El parcial es el 12/11, horario a confirmar."))
        .unwrap();
    let events = store.events().unwrap();
    assert_eq!(events.len(), 1);
    assert_eq!(events[0].status, "pending");
    assert!(events[0].all_day);
    assert!(events[0].evidence.contains("12/11"));
}

#[test]
fn calendar_handles_written_and_relative_dates_with_original_context() {
    let dir = tempdir().unwrap();
    let store = Store::open(dir.path()).unwrap();
    store
        .ingest_capture(capture(
            "El final es el 18 de diciembre de 2026 a las 14:30. La entrega es mañana.",
        ))
        .unwrap();
    let events = store.events().unwrap();
    assert_eq!(events.len(), 2);
    let relative = events.iter().find(|e| e.kind == "entrega").unwrap();
    assert_eq!(relative.date, "2026-11-02");
    assert_eq!(relative.status, "pending");
    let explicit = events.iter().find(|e| e.kind == "final").unwrap();
    assert_eq!(explicit.date, "2026-12-18");
    assert_eq!(explicit.time.as_deref(), Some("14:30"));
}

#[test]
fn source_changes_preserve_manual_dates_and_retire_stale_auto_confirmations() {
    let dir = tempdir().unwrap();
    let store = Store::open(dir.path()).unwrap();
    store
        .ingest_capture(capture("Parcial el 12/11/2026"))
        .unwrap();
    let mut manual = store.events().unwrap().remove(0);
    manual.date = "2026-11-13".into();
    manual.manually_edited = true;
    store.save_event(manual).unwrap();
    store
        .ingest_capture(capture("Parcial el 19/11/2026"))
        .unwrap();
    let events = store.events().unwrap();
    assert_eq!(events.len(), 2);
    assert!(events
        .iter()
        .any(|e| e.date == "2026-11-13" && e.manually_edited));
    assert!(events
        .iter()
        .any(|e| e.date == "2026-11-19" && e.status == "pending"));
    let mut another = capture("Entrega el 21/11/2026");
    another.messages[0].id = "m2".into();
    store.ingest_capture(another.clone()).unwrap();
    another.messages[0].text = "La entrega está suspendida, luego avisamos la fecha".into();
    store.ingest_capture(another).unwrap();
    let stale = store
        .events()
        .unwrap()
        .into_iter()
        .find(|e| e.date == "2026-11-21")
        .unwrap();
    assert_eq!(stale.status, "pending");
    assert!(stale.note.contains("cambió"));
}

#[test]
fn document_scope_filters_before_result_limit() {
    let dir = tempdir().unwrap();
    let store = Store::open(dir.path()).unwrap();
    for n in 0..20 {
        let mut c = capture("Matrices y determinantes");
        c.messages[0].id = format!("m{n}");
        store.ingest_capture(c).unwrap();
    }
    let target = store.sources().unwrap().pop().unwrap();
    let result = store.search_in("matrices", None, Some(&target.id)).unwrap();
    assert_eq!(result.len(), 1);
    assert_eq!(result[0].source_id, target.id);
}

#[test]
fn failed_calendar_write_does_not_commit_half_an_import() {
    let dir = tempdir().unwrap();
    let store = Store::open(dir.path()).unwrap();
    let connection = rusqlite::Connection::open(dir.path().join("lupino.sqlite")).unwrap();
    connection.execute_batch("CREATE TRIGGER fail_event BEFORE INSERT ON events BEGIN SELECT RAISE(ABORT,'simulated interrupted import'); END;").unwrap();
    assert!(store
        .ingest_capture(capture("Parcial el 12/11/2026"))
        .is_err());
    assert!(store.sources().unwrap().is_empty());
    connection
        .execute_batch("DROP TRIGGER fail_event;")
        .unwrap();
    store
        .ingest_capture(capture("Parcial el 12/11/2026"))
        .unwrap();
    assert_eq!(store.events().unwrap().len(), 1);
}

#[test]
fn renamed_channels_and_tracking_parameters_do_not_duplicate_messages() {
    let dir = tempdir().unwrap();
    let store = Store::open(dir.path()).unwrap();
    let mut c = capture("Parcial el 12/11/2026");
    store.ingest_capture(c.clone()).unwrap();
    c.title = "Canal renombrado".into();
    c.page_url = "https://teams.microsoft.com/v2/?client=desktop#thread".into();
    c.messages[0].text = "Parcial el 19/11/2026".into();
    store.ingest_capture(c).unwrap();
    assert_eq!(store.sources().unwrap().len(), 1);
    let events = store.events().unwrap();
    assert_eq!(events.len(), 1);
    assert_eq!(events[0].date, "2026-11-19");
    assert_eq!(events[0].status, "pending");
}
#[test]
fn unresolved_reschedules_stay_pending_after_unrelated_edits() {
    let dir = tempdir().unwrap();
    let store = Store::open(dir.path()).unwrap();
    for text in [
        "Parcial el 12/11/2026",
        "Parcial el 19/11/2026",
        "Parcial el 19/11/2026. Aula 2",
    ] {
        store.ingest_capture(capture(text)).unwrap();
    }
    let e = store.events().unwrap().remove(0);
    assert_eq!(e.status, "pending");
    assert!(e.note.contains("anterior"));
}
#[test]
fn repeated_manual_conflicts_update_one_proposal() {
    let dir = tempdir().unwrap();
    let store = Store::open(dir.path()).unwrap();
    store
        .ingest_capture(capture("Parcial el 12/11/2026"))
        .unwrap();
    let mut e = store.events().unwrap().remove(0);
    e.date = "2026-11-13".into();
    e.manually_edited = true;
    store.save_event(e).unwrap();
    for text in ["Parcial el 19/11/2026", "Parcial el 19/11/2026. Aula 2"] {
        store.ingest_capture(capture(text)).unwrap();
    }
    let events = store.events().unwrap();
    assert_eq!(events.len(), 2);
    assert_eq!(events.iter().filter(|e| e.date == "2026-11-19").count(), 1);
}
#[test]
fn multiple_dates_and_negation_never_auto_confirm() {
    let dir = tempdir().unwrap();
    let store = Store::open(dir.path()).unwrap();
    store
        .ingest_capture(capture("El parcial del 10/11/2026 se pasa al 17/11/2026"))
        .unwrap();
    assert_eq!(store.events().unwrap().len(), 2);
    assert!(store
        .events()
        .unwrap()
        .iter()
        .all(|e| e.status == "pending"));
    store
        .ingest_capture(capture("No hay parcial el 17/11/2026"))
        .unwrap();
    assert!(store
        .events()
        .unwrap()
        .iter()
        .all(|e| e.status != "confirmed"));
}
