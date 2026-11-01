use chrono::{Local, TimeZone};
use lupino_core::reminders::{reminder_key, ReminderSettings};
use lupino_core::{Store, StudyEvent};
#[test]
fn reminders_respect_preferences_status_and_persistent_deduplication() {
    let settings = ReminderSettings::default();
    let now = Local.with_ymd_and_hms(2026, 11, 1, 8, 30, 0).unwrap();
    let mut event = StudyEvent {
        id: "e".into(),
        title: "Entrega".into(),
        subject: "Álgebra".into(),
        kind: "entrega".into(),
        date: "2026-11-01".into(),
        time: None,
        all_day: true,
        status: "confirmed".into(),
        evidence: "".into(),
        chunk_id: None,
        source_id: None,
        manually_edited: true,
        note: "".into(),
    };
    let key = reminder_key(&event, now, &settings).unwrap();
    let dir = tempfile::tempdir().unwrap();
    let store = Store::open(dir.path()).unwrap();
    assert!(!store.was_notified(&key).unwrap());
    assert!(store.mark_notified(&key).unwrap());
    drop(store);
    assert!(Store::open(dir.path()).unwrap().was_notified(&key).unwrap());
    event.status = "pending".into();
    assert!(reminder_key(&event, now, &settings).is_none());
    event.status = "confirmed".into();
    let disabled = ReminderSettings {
        enabled: false,
        ..settings.clone()
    };
    assert!(reminder_key(&event, now, &disabled).is_none());
    event.date = "2026-11-02".into();
    event.time = Some("08:00".into());
    assert_ne!(reminder_key(&event, now, &settings).unwrap(), key);
    event.date = "2026-10-31".into();
    assert!(reminder_key(&event, now, &settings).is_none());
}
