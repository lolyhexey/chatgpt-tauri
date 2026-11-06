use serde::{Deserialize, Serialize};
use std::sync::Mutex;

pub struct AppState {
    pub token: Mutex<Option<String>>,
    pub cwd: String,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct Message {
    pub id: String,
    pub role: String,
    pub content: String,
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
