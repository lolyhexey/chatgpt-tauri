use serde::{Deserialize, Serialize};

#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct Message {
    pub id: String,
    pub role: String,
    pub content: String,
    #[serde(default)]
    pub attachments: Vec<AttachmentInfo>,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct AttachmentInfo {
    pub name: String,
    pub mime_type: String,
}

/// A file uploaded to ChatGPT, ready to be referenced from a message.
#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct UploadedFile {
    pub id: String,
    pub name: String,
    pub mime_type: String,
    pub size: u64,
    pub width: Option<u32>,
    pub height: Option<u32>,
    pub is_image: bool,
}

#[derive(Serialize, Clone, Debug)]
pub struct UploadResult {
    pub file: UploadedFile,
    /// data: URL thumbnail source for small images; the UI never sends it back.
    pub preview: Option<String>,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct ConversationSummary {
    pub id: String,
    pub title: String,
    pub model: String,
    pub updated: Option<f64>,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct ConversationList {
    pub items: Vec<ConversationSummary>,
    pub total: u32,
    pub has_more: bool,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct Conversation {
    pub id: String,
    pub title: String,
    pub messages: Vec<Message>,
    pub current_node: String,
    pub model: String,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(tag = "type")]
pub enum StreamEvent {
    #[serde(rename = "text")]
    Text { delta: String },
    #[serde(rename = "thinking")]
    Thinking { delta: String },
    #[serde(rename = "reasoning")]
    Reasoning { delta: String },
    #[serde(rename = "done")]
    Done {
        conversation_id: String,
        message_id: String,
        model: String,
    },
}
