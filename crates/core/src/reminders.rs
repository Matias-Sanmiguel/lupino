use crate::StudyEvent;
use chrono::{DateTime, Local, NaiveDateTime, TimeZone};
use serde::{Deserialize, Serialize};
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct ReminderSettings {
    pub enabled: bool,
    pub before_day: bool,
    pub before_hour: bool,
    pub all_day_time: String,
}
impl Default for ReminderSettings {
    fn default() -> Self {
        Self {
            enabled: true,
            before_day: true,
            before_hour: true,
            all_day_time: "09:00".into(),
        }
    }
}
pub fn reminder_key(
    event: &StudyEvent,
    now: DateTime<Local>,
    settings: &ReminderSettings,
) -> Option<String> {
    if !settings.enabled || event.status != "confirmed" {
        return None;
    }
    let time = event.time.as_deref().unwrap_or(&settings.all_day_time);
    let dt =
        NaiveDateTime::parse_from_str(&format!("{} {time}", event.date), "%Y-%m-%d %H:%M").ok()?;
    let due = Local.from_local_datetime(&dt).single()?;
    let seconds = (due - now).num_seconds();
    let bucket = if (0..=3600).contains(&seconds) && settings.before_hour {
        "hour"
    } else if (3601..=86400).contains(&seconds) && settings.before_day {
        "day"
    } else {
        return None;
    };
    Some(format!("{}:{}:{}:{bucket}", event.id, event.date, time))
}
