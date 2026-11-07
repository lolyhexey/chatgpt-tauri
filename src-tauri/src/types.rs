use serde::{Deserialize, Serialize};

#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct Message {
    pub id: String,
    pub role: String,
    pub content: String,
    #[serde(default)]
    pub attachments: Vec<AttachmentInfo>,
    /// Web search results this reply can cite with <Cite refs={["turn…search…"]}/>.
    #[serde(default)]
    pub sources: Vec<Source>,
    /// Images ChatGPT resolved for this reply's <AsyncImage query="…"/> tags.
    #[serde(default)]
    pub images: Vec<GenImage>,
    /// Images ChatGPT created for this reply (Create image tool).
    #[serde(default)]
    pub generated: Vec<GeneratedImage>,
}

/// An image made by ChatGPT's image tool; the UI asks for a signed URL by file id.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
pub struct GeneratedImage {
    pub file_id: String,
    pub width: u32,
    pub height: u32,
    pub title: String,
}

/// An image chatgpt.com found for an <AsyncImage query="…"/> component.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
pub struct GenImage {
    /// The component's query, which is how the reply text refers to it.
    pub query: String,
    pub url: String,
    pub thumbnail: String,
    /// The page the image came from, and its host for the corner label.
    pub source_url: String,
    pub source_host: String,
    pub title: String,
    pub show_url: bool,
}

/// One web search result, keyed the way replies cite it: "turn{turn_index}{ref_type}{ref_index}".
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
pub struct Source {
    pub id: String,
    pub url: String,
    pub title: String,
    pub attribution: String,
    /// Short site name when ChatGPT provides one ("App Store").
    #[serde(default)]
    pub name: String,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct AttachmentInfo {
    pub name: String,
    pub mime_type: String,
    /// File id, so the UI can show an attached image (fetched through Rust with the token).
    #[serde(default)]
    pub id: String,
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
    /// Reply text. `id` is the message it belongs to: a reply can stream in more than one
    /// message at once, and their pieces must not be joined into one string.
    #[serde(rename = "text")]
    Text {
        delta: String,
        #[serde(default)]
        id: String,
    },
    /// An intermediate step ChatGPT shows while working (tool call, tool result,
    /// thinking summary, "Thought for Ns" recap). Re-emitted with the same id as it updates.
    #[serde(rename = "step")]
    Step {
        id: String,
        kind: String,
        title: String,
        detail: String,
        tool: String,
        #[serde(default, skip_serializing_if = "Vec::is_empty")]
        sources: Vec<Source>,
        /// The tool's own icon from metadata.tool_icons: an https image URL (e.g. the Hexey
        /// logo) or a named icon ("globe", "code"); empty when there is none to show.
        #[serde(default)]
        icon: String,
    },
    /// Images resolved for <AsyncImage/> components in the reply.
    #[serde(rename = "images")]
    Images { images: Vec<GenImage> },
    /// The conversation this reply belongs to, as soon as the server names it (new chats get
    /// their id here, long before the reply ends).
    #[serde(rename = "conversation")]
    Conversation { conversation_id: String },
    /// Images created by ChatGPT's image tool, as soon as they arrive.
    #[serde(rename = "generated")]
    Generated { images: Vec<GeneratedImage> },
    #[serde(rename = "done")]
    Done {
        conversation_id: String,
        message_id: String,
        model: String,
    },
}
