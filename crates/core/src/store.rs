use crate::*;
use anyhow::{bail, Context, Result};
use chrono::Utc;
use rusqlite::{params, Connection, OptionalExtension};
use sha2::{Digest, Sha256};
use std::path::{Path, PathBuf};

pub fn digest(text: impl AsRef<[u8]>) -> String {
    format!("{:x}", Sha256::digest(text.as_ref()))
}
pub struct Store {
    conn: Connection,
    pub root: PathBuf,
}
impl Store {
    pub fn open(root: &Path) -> Result<Self> {
        std::fs::create_dir_all(root)?;
        let conn = Connection::open(root.join("lupino.sqlite"))?;
        conn.busy_timeout(std::time::Duration::from_secs(5))?;
        conn.execute_batch("PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON;
          CREATE TABLE IF NOT EXISTS sources(id TEXT PRIMARY KEY, source_key TEXT UNIQUE NOT NULL, revision_id TEXT NOT NULL, data TEXT NOT NULL);
          CREATE TABLE IF NOT EXISTS revisions(id TEXT PRIMARY KEY, source_id TEXT NOT NULL REFERENCES sources(id), data TEXT NOT NULL);
          CREATE TABLE IF NOT EXISTS chunks(id TEXT PRIMARY KEY, source_id TEXT NOT NULL REFERENCES sources(id), revision_id TEXT NOT NULL REFERENCES revisions(id), locator TEXT NOT NULL, text TEXT NOT NULL);
          CREATE INDEX IF NOT EXISTS chunks_source ON chunks(source_id,revision_id);
          CREATE VIRTUAL TABLE IF NOT EXISTS chunks_fts USING fts5(chunk_id UNINDEXED,text,title,subject,tokenize='unicode61 remove_diacritics 2');
          CREATE TABLE IF NOT EXISTS events(id TEXT PRIMARY KEY,data TEXT NOT NULL);
          CREATE TABLE IF NOT EXISTS conversations(id TEXT PRIMARY KEY,data TEXT NOT NULL);
          CREATE TABLE IF NOT EXISTS messages(id TEXT PRIMARY KEY,conversation_id TEXT NOT NULL REFERENCES conversations(id),data TEXT NOT NULL);
          CREATE TABLE IF NOT EXISTS preferences(key TEXT PRIMARY KEY,value TEXT NOT NULL);
          CREATE TABLE IF NOT EXISTS notified(key TEXT PRIMARY KEY);
          CREATE TABLE IF NOT EXISTS remote_versions(source_id TEXT PRIMARY KEY,modified_at INTEGER NOT NULL);
          PRAGMA user_version=2;")?;
        Ok(Self {
            conn,
            root: root.to_owned(),
        })
    }
    pub fn ingest_capture(&self, capture: Capture) -> Result<usize> {
        crate::native::validate_capture(&capture)?;
        let mut count = 0;
        for msg in capture.messages {
            if msg.text.trim().is_empty() {
                continue;
            }
            let subject = if capture.subject.trim().is_empty() {
                "Sin materia"
            } else {
                capture.subject.trim()
            };
            // Message IDs describe the source; display titles and navigation URLs do not.
            let key = format!("teams:message:{}", msg.id);
            let title: String = msg
                .text
                .lines()
                .next()
                .unwrap_or("Mensaje")
                .chars()
                .take(100)
                .collect();
            let title = if title.trim().is_empty() {
                capture.title.clone()
            } else {
                title
            };
            if self
                .ingest_source(NewSource {
                    key,
                    title,
                    subject: subject.into(),
                    kind: "teams".into(),
                    origin_url: msg.url.or(Some(capture.page_url.clone())),
                    author: msg.author,
                    published_at: msg.sent_at,
                    attachments: msg.attachments,
                    sections: vec![("Mensaje".into(), msg.text)],
                    status: "ready".into(),
                })?
                .1
            {
                count += 1;
            }
        }
        Ok(count)
    }
    pub fn ingest_source(&self, input: NewSource) -> Result<(String, bool)> {
        self.ingest_source_versioned(input, None)
    }
    pub(crate) fn ingest_source_versioned(
        &self,
        input: NewSource,
        modified: Option<i64>,
    ) -> Result<(String, bool)> {
        if input.title.len() > 1024 || input.subject.len() > 256 {
            bail!("Título o materia demasiado largo");
        }
        let id = digest(&input.key);
        let tx = self.conn.unchecked_transaction()?;
        if let Some(modified) = modified {
            let newest: Option<i64> = tx
                .query_row(
                    "SELECT modified_at FROM remote_versions WHERE source_id=?1",
                    [&id],
                    |r| r.get(0),
                )
                .optional()?;
            if newest.is_some_and(|newest| modified < newest) {
                return Ok((id, false));
            }
            tx.execute("INSERT INTO remote_versions VALUES(?1,?2) ON CONFLICT(source_id) DO UPDATE SET modified_at=excluded.modified_at",params![id,modified])?;
        }
        let revision_id = digest(serde_json::to_vec(&(
            &id,
            &input.sections,
            &input.attachments,
            &input.author,
            &input.published_at,
            &input.subject,
            &input.title,
            &input.origin_url,
            &input.kind,
            &input.status,
        ))?);
        let old: Option<String> = self
            .conn
            .query_row("SELECT revision_id FROM sources WHERE id=?1", [&id], |r| {
                r.get(0)
            })
            .optional()?;
        if old.as_deref() == Some(&revision_id) {
            tx.commit()?;
            return Ok((id, false));
        }
        let chunks = split_sections(&input.sections);
        let source = Source {
            id: id.clone(),
            title: input.title,
            subject: input.subject,
            kind: input.kind,
            origin_url: input.origin_url,
            author: input.author,
            published_at: input.published_at,
            updated_at: Utc::now().to_rfc3339(),
            status: input.status,
            revision_id: revision_id.clone(),
            chunk_count: chunks.len() as i64,
            attachments: input.attachments,
        };
        let json = serde_json::to_string(&source)?;
        tx.execute("INSERT INTO sources VALUES(?1,?2,?3,?4) ON CONFLICT(id) DO UPDATE SET revision_id=excluded.revision_id,data=excluded.data",params![id,input.key,revision_id,json])?;
        tx.execute(
            "INSERT OR IGNORE INTO revisions VALUES(?1,?2,?3)",
            params![revision_id, id, json],
        )?;
        for (index, (locator, text)) in chunks.iter().enumerate() {
            let chunk_id = format!("{}:{}", revision_id, index);
            let inserted = tx.execute(
                "INSERT OR IGNORE INTO chunks VALUES(?1,?2,?3,?4,?5)",
                params![chunk_id, id, revision_id, locator, text],
            )?;
            if inserted > 0 {
                tx.execute(
                    "INSERT INTO chunks_fts VALUES(?1,?2,?3,?4)",
                    params![chunk_id, text, source.title, source.subject],
                )?;
            }
        }
        let mut detected_ids = std::collections::HashSet::new();
        for (index, (_, text)) in chunks.iter().enumerate() {
            let evidence = self.read_chunk(&format!("{}:{}", revision_id, index))?;
            for mut event in crate::calendar::detect(text, &source, &evidence) {
                detected_ids.insert(event.id.clone());
                let old_event: Option<StudyEvent> = self
                    .conn
                    .query_row("SELECT data FROM events WHERE id=?1", [&event.id], |r| {
                        r.get::<_, String>(0)
                    })
                    .optional()?
                    .map(|s| serde_json::from_str(&s))
                    .transpose()?;
                if let Some(old) = old_event {
                    if old.manually_edited {
                        if old.date == event.date && old.time == event.time {
                            continue;
                        }
                        event.id = digest(format!(
                            "{}:proposal:{}:{}",
                            event.id,
                            event.date,
                            event.time.as_deref().unwrap_or("")
                        ));
                        let resolved: Option<String> = self
                            .conn
                            .query_row("SELECT data FROM events WHERE id=?1", [&event.id], |r| {
                                r.get(0)
                            })
                            .optional()?;
                        if resolved
                            .and_then(|s| serde_json::from_str::<StudyEvent>(&s).ok())
                            .is_some_and(|e| e.manually_edited)
                        {
                            continue;
                        }
                        event.status = "pending".into();
                        event.note = "La fuente cambió. Conservamos tu fecha anterior; revisá esta propuesta.".into();
                    } else if old.date != event.date || old.time != event.time {
                        event.status = "pending".into();
                        event.note =
                            format!("Fecha anterior: {}. La fuente fue actualizada.", old.date);
                    } else if old.status == "pending" {
                        event.status = old.status;
                        event.note = old.note;
                    }
                }
                self.put_event(&event)?;
            }
        }
        for mut old in self.events()?.into_iter().filter(|e| {
            e.source_id.as_deref() == Some(&id)
                && !e.manually_edited
                && e.status == "confirmed"
                && !detected_ids.contains(&e.id)
        }) {
            old.status = "pending".into();
            old.note="La fuente cambió y ya no respalda automáticamente esta fecha. Revisala antes de activar avisos.".into();
            self.put_event(&old)?;
        }
        tx.commit()?;
        Ok((id, true))
    }
    pub fn sources(&self) -> Result<Vec<Source>> {
        let mut st = self
            .conn
            .prepare("SELECT data FROM sources ORDER BY json_extract(data,'$.updatedAt') DESC")?;
        let rows = st.query_map([], |r| r.get::<_, String>(0))?;
        rows.map(|r| Ok(serde_json::from_str(&r?)?)).collect()
    }
    pub fn source(&self, id: &str) -> Result<SourceDetail> {
        let source: Source = serde_json::from_str(
            &self
                .conn
                .query_row("SELECT data FROM sources WHERE id=?1", [id], |r| {
                    r.get::<_, String>(0)
                })
                .context("Fuente no encontrada")?,
        )?;
        let mut st = self.conn.prepare(
            "SELECT id FROM chunks WHERE source_id=?1 AND revision_id=?2 ORDER BY rowid",
        )?;
        let ids = st
            .query_map(params![id, source.revision_id], |r| r.get::<_, String>(0))?
            .collect::<std::result::Result<Vec<_>, _>>()?;
        Ok(SourceDetail {
            source,
            chunks: ids
                .iter()
                .map(|id| self.read_chunk(id))
                .collect::<Result<_>>()?,
        })
    }
    pub fn read_chunk(&self, id: &str) -> Result<Evidence> {
        let (source_json,locator,text):(String,String,String)=self.conn.query_row("SELECT r.data,c.locator,c.text FROM chunks c JOIN revisions r ON r.id=c.revision_id WHERE c.id=?1",[id],|r|Ok((r.get(0)?,r.get(1)?,r.get(2)?))).context("Fragmento no encontrado")?;
        let source: Source = serde_json::from_str(&source_json)?;
        Ok(Evidence {
            id: id.into(),
            source_id: source.id,
            title: source.title,
            subject: source.subject,
            locator,
            text,
            origin_url: source.origin_url,
        })
    }
    pub fn search(&self, query: &str, subject: Option<&str>) -> Result<Vec<Evidence>> {
        self.search_in(query, subject, None)
    }
    pub fn search_in(
        &self,
        query: &str,
        subject: Option<&str>,
        source_id: Option<&str>,
    ) -> Result<Vec<Evidence>> {
        let stop = [
            "que", "qué", "como", "cómo", "para", "del", "las", "los", "una", "por", "con", "hay",
            "dice", "dijo", "sobre", "cuándo", "cuando", "está", "están", "entra", "qué",
        ];
        let terms: Vec<String> = query
            .split(|c: char| !c.is_alphanumeric())
            .map(str::to_lowercase)
            .filter(|s| s.chars().count() > 2 && !stop.contains(&s.as_str()))
            .take(16)
            .map(|s| format!("\"{}\"", s))
            .collect();
        if terms.is_empty() {
            return Ok(vec![]);
        }
        let mut expression = terms.join(" OR ");
        if let Some(subject) = subject.filter(|s| s.chars().any(char::is_alphanumeric)) {
            expression = format!(
                "({expression}) AND subject:\"{}\"",
                subject.replace('"', "\"\"")
            );
        }
        let mut st=self.conn.prepare("SELECT c.id FROM chunks_fts f JOIN chunks c ON c.id=f.chunk_id JOIN sources s ON s.id=c.source_id WHERE chunks_fts MATCH ?1 AND c.revision_id=s.revision_id AND (?2 IS NULL OR json_extract(s.data,'$.subject')=?2) AND (?3 IS NULL OR s.id=?3) ORDER BY f.rank LIMIT 12")?;
        let ids = st
            .query_map(params![expression, subject, source_id], |r| {
                r.get::<_, String>(0)
            })?
            .collect::<std::result::Result<Vec<_>, _>>()?;
        ids.iter().map(|id| self.read_chunk(id)).collect()
    }
    pub fn events(&self) -> Result<Vec<StudyEvent>> {
        let mut st=self.conn.prepare("SELECT data FROM events ORDER BY json_extract(data,'$.date'),json_extract(data,'$.time')")?;
        let rows = st.query_map([], |r| r.get::<_, String>(0))?;
        rows.map(|r| Ok(serde_json::from_str(&r?)?)).collect()
    }
    fn put_event(&self, event: &StudyEvent) -> Result<()> {
        self.conn.execute(
            "INSERT INTO events VALUES(?1,?2) ON CONFLICT(id) DO UPDATE SET data=excluded.data",
            params![event.id, serde_json::to_string(event)?],
        )?;
        Ok(())
    }
    pub fn save_event(&self, mut event: StudyEvent) -> Result<String> {
        chrono::NaiveDate::parse_from_str(&event.date, "%Y-%m-%d")
            .context("La fecha no es válida")?;
        if event.title.trim().is_empty()
            || event.subject.trim().is_empty()
            || event.title.len() > 500
        {
            bail!("Completá título y materia");
        }
        if !["pending", "confirmed", "done", "dismissed"].contains(&event.status.as_str())
            || !["entrega", "parcial", "final"].contains(&event.kind.as_str())
        {
            bail!("Estado o tipo inválido");
        }
        if let Some(time) = &event.time {
            chrono::NaiveTime::parse_from_str(time, "%H:%M").context("Hora inválida")?;
        }
        if let Some(id) = &event.chunk_id {
            let chunk = self.read_chunk(id)?;
            if !chunk.text.contains(&event.evidence) || event.evidence.is_empty() {
                bail!("La fecha necesita una cita real de la fuente");
            }
            event.source_id = Some(chunk.source_id);
        }
        if event.id.is_empty() {
            event.id = uuid::Uuid::new_v4().to_string();
        }
        event.all_day = event.time.is_none();
        self.put_event(&event)?;
        Ok(event.id)
    }
    pub fn conversations(&self) -> Result<Vec<Conversation>> {
        let mut st = self.conn.prepare(
            "SELECT data FROM conversations ORDER BY json_extract(data,'$.updatedAt') DESC",
        )?;
        let rows = st.query_map([], |r| r.get::<_, String>(0))?;
        rows.map(|r| Ok(serde_json::from_str(&r?)?)).collect()
    }
    pub fn create_conversation(&self, title: &str) -> Result<String> {
        let c = Conversation {
            id: uuid::Uuid::new_v4().to_string(),
            title: title.chars().take(80).collect(),
            updated_at: Utc::now().to_rfc3339(),
        };
        self.conn.execute(
            "INSERT INTO conversations VALUES(?1,?2)",
            params![c.id, serde_json::to_string(&c)?],
        )?;
        Ok(c.id)
    }
    pub fn messages(&self, id: &str) -> Result<Vec<ChatMessage>> {
        let mut st = self
            .conn
            .prepare("SELECT data FROM messages WHERE conversation_id=?1 ORDER BY rowid")?;
        let rows = st.query_map([id], |r| r.get::<_, String>(0))?;
        rows.map(|r| Ok(serde_json::from_str(&r?)?)).collect()
    }
    pub fn add_message(&self, conversation_id: &str, message: &ChatMessage) -> Result<()> {
        self.conn.execute(
            "INSERT INTO messages VALUES(?1,?2,?3)",
            params![message.id, conversation_id, serde_json::to_string(message)?],
        )?;
        self.conn.execute(
            "UPDATE conversations SET data=json_set(data,'$.updatedAt',?1) WHERE id=?2",
            params![Utc::now().to_rfc3339(), conversation_id],
        )?;
        Ok(())
    }
    pub fn preference(&self, key: &str) -> Result<Option<String>> {
        Ok(self
            .conn
            .query_row("SELECT value FROM preferences WHERE key=?1", [key], |r| {
                r.get(0)
            })
            .optional()?)
    }
    pub fn set_preference(&self, key: &str, value: &str) -> Result<()> {
        self.conn.execute("INSERT INTO preferences VALUES(?1,?2) ON CONFLICT(key) DO UPDATE SET value=excluded.value",params![key,value])?;
        Ok(())
    }
    pub fn mark_notified(&self, key: &str) -> Result<bool> {
        Ok(self
            .conn
            .execute("INSERT OR IGNORE INTO notified VALUES(?1)", [key])?
            > 0)
    }
    pub fn was_notified(&self, key: &str) -> Result<bool> {
        Ok(self.conn.query_row(
            "SELECT EXISTS(SELECT 1 FROM notified WHERE key=?1)",
            [key],
            |r| r.get(0),
        )?)
    }
}

fn split_sections(sections: &[(String, String)]) -> Vec<(String, String)> {
    let mut output = Vec::new();
    for (locator, text) in sections {
        let chars: Vec<char> = text.chars().collect();
        for (i, part) in chars.chunks(2200).enumerate() {
            let text: String = part.iter().collect();
            if text.trim().is_empty() {
                continue;
            }
            let label = if chars.len() > 2200 {
                format!("{} · fragmento {}", locator, i + 1)
            } else {
                locator.clone()
            };
            output.push((label, text));
        }
    }
    output
}
