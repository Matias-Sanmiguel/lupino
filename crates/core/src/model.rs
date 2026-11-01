use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Attachment {
    pub name: String,
    pub url: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CapturedMessage {
    pub id: String,
    pub text: String,
    #[serde(default)]
    pub author: Option<String>,
    #[serde(default)]
    pub sent_at: Option<String>,
    #[serde(default)]
    pub url: Option<String>,
    #[serde(default)]
    pub attachments: Vec<Attachment>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Capture {
    pub version: u32,
    pub page_url: String,
    pub subject: String,
    pub title: String,
    pub captured_at: String,
    pub coverage: String,
    pub messages: Vec<CapturedMessage>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Source {
    pub id: String,
    pub title: String,
    pub subject: String,
    pub kind: String,
    pub origin_url: Option<String>,
    pub author: Option<String>,
    pub published_at: Option<String>,
    pub updated_at: String,
    pub status: String,
    pub revision_id: String,
    pub chunk_count: i64,
    pub attachments: Vec<Attachment>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Evidence {
    pub id: String,
    pub source_id: String,
    pub title: String,
    pub subject: String,
    pub locator: String,
    pub text: String,
    pub origin_url: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SourceDetail {
    pub source: Source,
    pub chunks: Vec<Evidence>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StudyEvent {
    pub id: String,
    pub title: String,
    pub subject: String,
    pub kind: String,
    pub date: String,
    pub time: Option<String>,
    pub all_day: bool,
    pub status: String,
    pub evidence: String,
    pub chunk_id: Option<String>,
    pub source_id: Option<String>,
    pub manually_edited: bool,
    pub note: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ChatMessage {
    pub id: String,
    pub role: String,
    pub content: String,
    pub provider: String,
    pub created_at: String,
    pub evidence: Vec<Evidence>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Conversation {
    pub id: String,
    pub title: String,
    pub updated_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct Snapshot {
    pub sources: Vec<Source>,
    pub events: Vec<StudyEvent>,
    pub conversations: Vec<Conversation>,
    pub inbox_errors: Vec<String>,
}

#[derive(Debug, Clone)]
pub struct NewSource {
    pub key: String,
    pub title: String,
    pub subject: String,
    pub kind: String,
    pub origin_url: Option<String>,
    pub author: Option<String>,
    pub published_at: Option<String>,
    pub attachments: Vec<Attachment>,
    pub sections: Vec<(String, String)>,
    pub status: String,
}
