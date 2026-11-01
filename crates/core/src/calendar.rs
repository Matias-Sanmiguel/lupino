use crate::{Evidence, Source, StudyEvent};
use chrono::{Datelike, Duration, NaiveDate, Utc};
use regex::Regex;
use std::sync::LazyLock;

static DATES: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"\b(\d{1,2})[/\-](\d{1,2})(?:[/\-](\d{4}))?\b").unwrap());
static WRITTEN: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"(?i)\b(\d{1,2})\s+de\s+(enero|febrero|marzo|abril|mayo|junio|julio|agosto|septiembre|setiembre|octubre|noviembre|diciembre)(?:\s+(?:de\s+)?(\d{4}))?\b").unwrap()
});
static RELATIVE: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"(?i)\b(pasado mañana|mañana|hoy|(?:el\s+)?pr[oó]ximo\s+(?:lunes|martes|mi[eé]rcoles|jueves|viernes|s[aá]bado|domingo))\b").unwrap()
});
static TIME: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"(?i)(?:a las|hora(?:rio)?\s*:?|a partir de las)\s*(\d{1,2}):(\d{2})").unwrap()
});

pub fn detect(text: &str, source: &Source, chunk: &Evidence) -> Vec<StudyEvent> {
    let published = source
        .published_at
        .as_ref()
        .and_then(|d| chrono::DateTime::parse_from_rfc3339(d).ok())
        .map(|d| d.date_naive());
    let reference = published.unwrap_or_else(|| Utc::now().date_naive());
    let mut dates = Vec::new();
    for cap in DATES.captures_iter(text) {
        let m = cap.get(0).unwrap();
        let year = cap.get(3).and_then(|s| s.as_str().parse::<i32>().ok());
        if let Some(date) = NaiveDate::from_ymd_opt(
            year.unwrap_or(reference.year()),
            cap[2].parse().unwrap_or(0),
            cap[1].parse().unwrap_or(0),
        ) {
            dates.push((m.start(), m.end(), date, year.is_none(), false));
        }
    }
    for cap in WRITTEN.captures_iter(text) {
        let m = cap.get(0).unwrap();
        let year = cap.get(3).and_then(|s| s.as_str().parse::<i32>().ok());
        let month = match cap[2].to_lowercase().as_str() {
            "enero" => 1,
            "febrero" => 2,
            "marzo" => 3,
            "abril" => 4,
            "mayo" => 5,
            "junio" => 6,
            "julio" => 7,
            "agosto" => 8,
            "septiembre" | "setiembre" => 9,
            "octubre" => 10,
            "noviembre" => 11,
            _ => 12,
        };
        if let Some(date) = NaiveDate::from_ymd_opt(
            year.unwrap_or(reference.year()),
            month,
            cap[1].parse().unwrap_or(0),
        ) {
            dates.push((m.start(), m.end(), date, year.is_none(), false));
        }
    }
    // Relative expressions are anchored only to the source publication, never to the capture day.
    if let Some(reference) = published {
        for m in RELATIVE.find_iter(text) {
            let value = m.as_str().to_lowercase();
            let days = match value.as_str() {
                "hoy" => 0,
                "mañana" => 1,
                "pasado mañana" => 2,
                _ => {
                    let weekday = if value.ends_with("lunes") {
                        0
                    } else if value.ends_with("martes") {
                        1
                    } else if value.ends_with("miércoles") || value.ends_with("miercoles") {
                        2
                    } else if value.ends_with("jueves") {
                        3
                    } else if value.ends_with("viernes") {
                        4
                    } else if value.ends_with("sábado") || value.ends_with("sabado") {
                        5
                    } else {
                        6
                    };
                    let delta =
                        (weekday - reference.weekday().num_days_from_monday() as i64 + 7) % 7;
                    if delta == 0 {
                        7
                    } else {
                        delta
                    }
                }
            };
            if let Some(date) = reference.checked_add_signed(Duration::days(days)) {
                dates.push((m.start(), m.end(), date, false, true));
            }
        }
    }
    dates.sort_by_key(|d| d.0);
    let mut out = Vec::new();
    for (index, (from, to, date, no_year, relative)) in dates.iter().copied().enumerate() {
        let start = text[..from]
            .rfind(['.', '\n', '!', '?'])
            .map(|n| n + 1)
            .unwrap_or(0);
        let end = text[to..]
            .find(['.', '\n', '!', '?'])
            .map(|n| to + n)
            .unwrap_or(text.len());
        let evidence = text[start..end].trim().to_string();
        let lower = format!(" {} ", evidence.to_lowercase());
        let multiple = dates
            .iter()
            .filter(|(position, ..)| *position >= start && *position <= end)
            .count()
            > 1;
        let kind = if lower.contains("parcial") {
            "parcial"
        } else if lower.contains("final") {
            "final"
        } else if lower.contains("entrega") || lower.contains("vencim") || lower.contains("vence") {
            "entrega"
        } else {
            continue;
        };
        let time = TIME.captures(&evidence).and_then(|t| {
            let h = t[1].parse::<u32>().ok()?;
            let m = t[2].parse::<u32>().ok()?;
            if h < 24 && m < 60 {
                Some(format!("{h:02}:{m:02}"))
            } else {
                None
            }
        });
        let ambiguous = [
            "confirmar",
            "tentativ",
            "quizás",
            "quizas",
            "podría",
            "suspend",
            "cancel",
            " no ",
            "reprogram",
            "posterg",
        ]
        .iter()
        .any(|s| lower.contains(s));
        let title = match kind {
            "parcial" => "Parcial",
            "final" => "Final",
            _ => "Entrega",
        };
        out.push(StudyEvent {
            id: crate::store::digest(format!("{}:{}:{}", source.id, chunk.locator, index)),
            title: format!("{} · {}", title, source.subject),
            subject: source.subject.clone(),
            kind: kind.into(),
            date: date.to_string(),
            all_day: time.is_none(),
            time,
            status: if no_year || relative || ambiguous || multiple {
                "pending"
            } else {
                "confirmed"
            }
            .into(),
            evidence,
            chunk_id: Some(chunk.id.clone()),
            source_id: Some(source.id.clone()),
            manually_edited: false,
            note: if multiple { "La frase contiene varias fechas. Revisá cuál corresponde al evento antes de confirmar.".into() } else if relative {
                "Fecha relativa calculada desde la publicación original. Revisá la propuesta."
                    .into()
            } else if no_year {
                "La fuente no indica el año. Revisá la fecha propuesta.".into()
            } else {
                String::new()
            },
        });
    }
    out
}
