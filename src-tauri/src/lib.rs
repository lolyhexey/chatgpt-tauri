mod api;
mod api_helpers;
mod auth;
mod pow;
mod types;

use api::ChatGptClient;
use serde::{Deserialize, Serialize};
use std::sync::Mutex;
use types::*;

pub struct AppState {
    pub token: Mutex<Option<String>>,
    pub device_id: String,
    pub model: Mutex<String>,
    pub conversation_id: Mutex<Option<String>>,
    pub parent_message_id: Mutex<String>,
}

#[tauri::command]
fn get_token(state: tauri::State<AppState>) -> Option<String> {
    state.token.lock().unwrap().clone()
}

#[tauri::command]
fn save_token(token: String, state: tauri::State<AppState>) -> Result<(), String> {
    auth::save_token(&token)?;
    *state.token.lock().unwrap() = Some(token);
    Ok(())
}

#[tauri::command]
fn clear_token(state: tauri::State<AppState>) -> Result<(), String> {
    auth::clear_token()?;
    *state.token.lock().unwrap() = None;
    Ok(())
}

fn make_client(state: &AppState) -> Result<ChatGptClient, String> {
    let token = state
        .token
        .lock()
        .unwrap()
        .clone()
        .ok_or("No token. Please sign in.")?;
    let mut client = ChatGptClient::new(token);
    client.device_id = state.device_id.clone();
    client.model = state.model.lock().unwrap().clone();
    client.conversation_id = state.conversation_id.lock().unwrap().clone();
    client.parent_message_id = state.parent_message_id.lock().unwrap().clone();
    Ok(client)
}

#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct ChatResponse {
    pub events: Vec<StreamEvent>,
    pub full_text: String,
}

/// Live progress for one send, matched by the frontend on stream_id.
#[derive(Serialize, Clone)]
struct ChatDelta<'a> {
    stream_id: &'a str,
    #[serde(flatten)]
    event: &'a StreamEvent,
}

/// Forward text and activity steps to the UI as they arrive.
fn emit_live(app: &tauri::AppHandle, stream_id: Option<&str>, event: &StreamEvent) {
    use tauri::Emitter;
    if matches!(event, StreamEvent::Done { .. }) {
        return;
    }
    if let Some(id) = stream_id {
        let _ = app.emit("chat-delta", ChatDelta { stream_id: id, event });
    }
}

fn reply_text(events: &[StreamEvent]) -> String {
    events.iter().filter_map(|e| match e {
        StreamEvent::Text { delta } => Some(delta.as_str()),
        _ => None,
    }).collect()
}

#[tauri::command]
async fn send_message(
    text: String,
    attachments: Option<Vec<UploadedFile>>,
    stream_id: Option<String>,
    system_hints: Option<Vec<String>>,
    state: tauri::State<'_, AppState>,
    app: tauri::AppHandle,
) -> Result<ChatResponse, String> {
    let mut client = make_client(&state)?;
    client.system_hints = system_hints.unwrap_or_default();
    let attachments = attachments.unwrap_or_default();
    let events = client
        .send_message_streaming(&text, &attachments, |ev| emit_live(&app, stream_id.as_deref(), ev))
        .await?;

    if let Some(conv_id) = &client.conversation_id {
        *state.conversation_id.lock().unwrap() = Some(conv_id.clone());
    }
    *state.parent_message_id.lock().unwrap() = client.parent_message_id.clone();

    let full_text = reply_text(&events);
    Ok(ChatResponse { events, full_text })
}

#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct GoalResponse {
    pub iterations: u32,
    pub complete: bool,
    pub responses: Vec<ChatResponse>,
}

#[derive(Serialize, Clone)]
struct GoalRound<'a> {
    stream_id: &'a str,
    round: u32,
}

const GOAL_DONE: &str = "[GOAL_COMPLETE]";
const GOAL_MAX_ROUNDS: u32 = 20;

/// Goal mode: keep asking ChatGPT to continue until it reports the goal done.
/// The work itself happens through the account's own connectors (MCP); this app runs nothing locally.
#[tauri::command]
async fn start_goal(
    task: String,
    stream_id: Option<String>,
    state: tauri::State<'_, AppState>,
    app: tauri::AppHandle,
) -> Result<GoalResponse, String> {
    use tauri::Emitter;
    let mut client = make_client(&state)?;
    let mut responses = Vec::new();

    for round in 0..GOAL_MAX_ROUNDS {
        let prompt = if round == 0 {
            format!("Work on this goal autonomously until it is done. Use your connected tools to investigate, make the changes, and verify the result.\n\nGoal: {task}\n\nWhen the goal is fully complete and verified, end your reply with {GOAL_DONE}")
        } else {
            format!("The goal is not complete yet. Continue working on: \"{task}\"\n\nWhen it is fully complete and verified, end your reply with {GOAL_DONE}")
        };

        if let Some(id) = &stream_id {
            let _ = app.emit("goal-round", GoalRound { stream_id: id, round: round + 1 });
        }
        let events = client
            .send_message_streaming(&prompt, &[], |ev| emit_live(&app, stream_id.as_deref(), ev))
            .await?;
        let full_text = reply_text(&events);
        let is_complete = full_text.contains(GOAL_DONE);
        // Keep the conversation pointer current so a failed later round still resumes here.
        if let Some(conv_id) = &client.conversation_id {
            *state.conversation_id.lock().unwrap() = Some(conv_id.clone());
        }
        *state.parent_message_id.lock().unwrap() = client.parent_message_id.clone();
        responses.push(ChatResponse { events, full_text });

        if is_complete { break; }
    }

    if let Some(conv_id) = &client.conversation_id {
        *state.conversation_id.lock().unwrap() = Some(conv_id.clone());
    }
    *state.parent_message_id.lock().unwrap() = client.parent_message_id.clone();

    let complete = responses.last().map(|r| r.full_text.contains(GOAL_DONE)).unwrap_or(false);

    Ok(GoalResponse {
        iterations: responses.len() as u32,
        complete,
        responses,
    })
}

#[tauri::command]
async fn list_conversations_cmd(
    offset: u32,
    limit: u32,
    state: tauri::State<'_, AppState>,
) -> Result<ConversationList, String> {
    let client = make_client(&state)?;
    client.list_conversations(offset, limit).await
}

#[tauri::command]
async fn get_conversation_cmd(
    id: String,
    state: tauri::State<'_, AppState>,
) -> Result<Conversation, String> {
    let client = make_client(&state)?;
    client.get_conversation(&id).await
}

#[tauri::command]
async fn delete_conversation_cmd(
    id: String,
    state: tauri::State<'_, AppState>,
) -> Result<(), String> {
    let client = make_client(&state)?;
    client.delete_conversation(&id).await
}

#[tauri::command]
async fn delete_all_cmd(state: tauri::State<'_, AppState>) -> Result<(), String> {
    let client = make_client(&state)?;
    client.delete_all_conversations().await
}

#[tauri::command]
fn new_conversation(state: tauri::State<AppState>) {
    *state.conversation_id.lock().unwrap() = None;
    *state.parent_message_id.lock().unwrap() = uuid::Uuid::new_v4().to_string();
}

#[tauri::command]
fn set_conversation(id: String, parent_id: String, state: tauri::State<AppState>) {
    *state.conversation_id.lock().unwrap() = Some(id);
    *state.parent_message_id.lock().unwrap() = parent_id;
}

#[tauri::command]
fn open_file_path(path: String) -> Result<(), String> {
    let p = std::path::Path::new(&path);
    if !p.exists() {
        return Err(format!("File not found: {path}"));
    }
    #[cfg(target_os = "windows")]
    {
        std::process::Command::new("explorer")
            .arg("/select,")
            .arg(&path)
            .spawn()
            .map_err(|e| e.to_string())?;
    }
    #[cfg(not(target_os = "windows"))]
    {
        std::process::Command::new("xdg-open")
            .arg(p.parent().unwrap_or(p))
            .spawn()
            .map_err(|e| e.to_string())?;
    }
    Ok(())
}

const MAX_UPLOAD_BYTES: u64 = 512 * 1024 * 1024;
const MAX_PREVIEW_BYTES: usize = 6 * 1024 * 1024;

async fn upload(state: &AppState, name: String, bytes: Vec<u8>) -> Result<UploadResult, String> {
    if bytes.is_empty() {
        return Err(format!("{name} is empty"));
    }
    let client = make_client(state)?;
    let file = client.upload_file(&name, bytes.clone()).await?;
    let preview = (file.is_image && bytes.len() <= MAX_PREVIEW_BYTES).then(|| {
        use base64::Engine;
        format!("data:{};base64,{}", file.mime_type, base64::engine::general_purpose::STANDARD.encode(&bytes))
    });
    Ok(UploadResult { file, preview })
}

/// Upload a file dropped onto the window (Tauri gives us its path).
#[tauri::command]
async fn upload_path(path: String, state: tauri::State<'_, AppState>) -> Result<UploadResult, String> {
    let p = std::path::PathBuf::from(&path);
    let meta = tokio::fs::metadata(&p).await.map_err(|e| format!("Cannot read {path}: {e}"))?;
    if !meta.is_file() {
        return Err("Folders can't be attached".into());
    }
    if meta.len() > MAX_UPLOAD_BYTES {
        return Err("File is larger than 512 MB".into());
    }
    let name = p.file_name().map(|n| n.to_string_lossy().to_string()).unwrap_or_else(|| "file".into());
    let bytes = tokio::fs::read(&p).await.map_err(|e| format!("Cannot read {name}: {e}"))?;
    upload(&state, name, bytes).await
}

/// Upload a pasted or picked file whose bytes come from the webview.
#[tauri::command]
async fn upload_bytes(name: String, data_base64: String, state: tauri::State<'_, AppState>) -> Result<UploadResult, String> {
    use base64::Engine;
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(data_base64.as_bytes())
        .map_err(|_| "Invalid file data".to_string())?;
    if bytes.len() as u64 > MAX_UPLOAD_BYTES {
        return Err("File is larger than 512 MB".into());
    }
    upload(&state, name, bytes).await
}

#[tauri::command]
fn copy_text(text: String) -> Result<(), String> {
    let mut clipboard = arboard::Clipboard::new().map_err(|e| e.to_string())?;
    clipboard.set_text(text).map_err(|e| e.to_string())
}

#[tauri::command]
fn open_url(url: String) -> Result<(), String> {
    if !(url.starts_with("https://") || url.starts_with("http://")) {
        return Err("Only http(s) links can be opened".into());
    }
    #[cfg(target_os = "windows")]
    let mut cmd = std::process::Command::new("explorer");
    #[cfg(target_os = "macos")]
    let mut cmd = std::process::Command::new("open");
    #[cfg(all(not(target_os = "windows"), not(target_os = "macos")))]
    let mut cmd = std::process::Command::new("xdg-open");
    cmd.arg(&url).spawn().map_err(|e| e.to_string())?;
    Ok(())
}

/// The composer's "@" menu entries for this account.
#[tauri::command]
async fn system_hints_cmd(state: tauri::State<'_, AppState>) -> Result<Vec<api::SystemHint>, String> {
    make_client(&state)?.list_system_hints().await
}

/// File name stem for a downloaded image: letters, digits, spaces, '-', '_' only.
fn safe_stem(name: &str) -> String {
    let stem: String = name
        .chars()
        .map(|c| if c.is_alphanumeric() || c == '-' || c == '_' || c == ' ' { c } else { ' ' })
        .collect::<String>()
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ");
    let stem: String = stem.chars().take(60).collect();
    if stem.is_empty() { "image".into() } else { stem }
}

/// `dir/stem.ext`, or `dir/stem (n).ext` when that name is taken. Never overwrites.
fn unique_path(dir: &std::path::Path, stem: &str, ext: &str) -> std::path::PathBuf {
    let first = dir.join(format!("{stem}.{ext}"));
    if !first.exists() {
        return first;
    }
    (1..)
        .map(|n| dir.join(format!("{stem} ({n}).{ext}")))
        .find(|p| !p.exists())
        .expect("unbounded range")
}

/// Save an image from a reply (as chatgpt.com's viewer "Download" does) to the Downloads folder.
/// Only ChatGPT's own image host is accepted, so a reply can't make the app fetch other URLs.
#[tauri::command]
async fn download_image(url: String, name: String) -> Result<String, String> {
    let parsed = reqwest::Url::parse(&url).map_err(|e| format!("Bad image link: {e}"))?;
    if parsed.scheme() != "https" || parsed.host_str() != Some("images.openai.com") {
        return Err("Only ChatGPT image links can be downloaded.".into());
    }
    let resp = reqwest::get(parsed).await.map_err(|e| format!("Download failed: {e}"))?;
    if !resp.status().is_success() {
        return Err(format!("Download failed (HTTP {}).", resp.status()));
    }
    let ext = match resp.headers().get(reqwest::header::CONTENT_TYPE).and_then(|v| v.to_str().ok()).unwrap_or("") {
        t if t.starts_with("image/png") => "png",
        t if t.starts_with("image/webp") => "webp",
        t if t.starts_with("image/gif") => "gif",
        t if t.starts_with("image/jpeg") => "jpg",
        t => return Err(format!("Not an image ({t}).")),
    };
    const MAX: usize = 50 * 1024 * 1024;
    let bytes = resp.bytes().await.map_err(|e| format!("Download failed: {e}"))?;
    if bytes.len() > MAX {
        return Err("Image is larger than 50 MB.".into());
    }
    let dir = dirs::download_dir().ok_or("No Downloads folder found.")?;
    let path = unique_path(&dir, &safe_stem(&name), ext);
    std::fs::write(&path, &bytes).map_err(|e| format!("Could not save: {e}"))?;
    Ok(path.to_string_lossy().to_string())
}

#[cfg(test)]
mod download_tests {
    use super::*;

    #[test]
    fn stems_are_safe() {
        assert_eq!(safe_stem("..\\..\\Windows/evil:name?.exe"), "Windows evil name exe");
        assert_eq!(safe_stem("   "), "image");
        assert_eq!(safe_stem("X logo"), "X logo");
    }

    #[test]
    fn unique_path_never_reuses_a_name() {
        let dir = std::env::temp_dir().join(format!("dl-test-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let a = unique_path(&dir, "img", "png");
        std::fs::write(&a, b"1").unwrap();
        let b = unique_path(&dir, "img", "png");
        assert_ne!(a, b);
        assert!(b.ends_with("img (1).png"));
        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[tokio::test]
    async fn rejects_other_hosts() {
        assert!(download_image("https://example.com/a.png".into(), "a".into()).await.is_err());
        assert!(download_image("http://images.openai.com/a.png".into(), "a".into()).await.is_err());
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let token = auth::load_token();

    let state = AppState {
        token: Mutex::new(token),
        device_id: api_helpers::new_device_id(),
        model: Mutex::new("auto".into()),
        conversation_id: Mutex::new(None),
        parent_message_id: Mutex::new(uuid::Uuid::new_v4().to_string()),
    };

    tauri::Builder::default()
        .manage(state)
        .invoke_handler(tauri::generate_handler![
            get_token,
            save_token,
            clear_token,
            send_message,
            list_conversations_cmd,
            get_conversation_cmd,
            delete_conversation_cmd,
            delete_all_cmd,
            new_conversation,
            set_conversation,
            start_goal,
            open_file_path,
            copy_text,
            open_url,
            upload_path,
            upload_bytes,
            download_image,
            system_hints_cmd,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
