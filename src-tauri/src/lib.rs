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
    /// Stop switches for replies in progress, by the UI's stream id.
    pub stops: Mutex<std::collections::HashMap<String, tokio::sync::watch::Sender<bool>>>,
}

/// A stop switch for one send; Stop flips it and the reply loop ends.
fn register_stop(state: &AppState, stream_id: &str) -> tokio::sync::watch::Receiver<bool> {
    let (tx, rx) = tokio::sync::watch::channel(false);
    state.stops.lock().unwrap().insert(stream_id.to_string(), tx);
    rx
}

fn unregister_stop(state: &AppState, stream_id: Option<&str>) {
    if let Some(id) = stream_id {
        state.stops.lock().unwrap().remove(id);
    }
}

/// Stop a reply like chatgpt.com's Stop button: tell the server (stop_conversation), then stop
/// reading. Text that already arrived stays.
#[tauri::command]
async fn stop_generation(
    stream_id: String,
    conversation_id: Option<String>,
    state: tauri::State<'_, AppState>,
) -> Result<(), String> {
    if let Some(conv) = conversation_id.filter(|c| !c.is_empty() && c.chars().all(|ch| ch.is_ascii_alphanumeric() || ch == '-')) {
        if let Err(e) = make_client(&state)?.stop_conversation(&conv).await {
            eprintln!("stop_conversation: {e}");
        }
    }
    if let Some(tx) = state.stops.lock().unwrap().get(&stream_id) {
        let _ = tx.send(true);
    }
    Ok(())
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
    /// The reply as stored on the server, when the stream carried more than one reply message
    /// (their pieces can interleave); the UI renders this instead of the streamed text.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub stored: Option<Message>,
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
    api::join_reply(events).0
}

/// The last turn's reply as the server stored it: every assistant message after the last user
/// message, text joined like separate paragraphs, sources and images merged.
fn stored_reply(conv: &Conversation) -> Option<Message> {
    let start = conv.messages.iter().rposition(|m| m.role == "user")? + 1;
    let replies: Vec<&Message> = conv.messages[start..].iter().filter(|m| m.role == "assistant").collect();
    let last = replies.last()?;
    let mut merged = Message {
        id: last.id.clone(),
        role: "assistant".into(),
        content: replies.iter().map(|m| m.content.trim()).filter(|t| !t.is_empty()).collect::<Vec<_>>().join("\n\n"),
        attachments: Vec::new(),
        sources: Vec::new(),
        images: Vec::new(),
        generated: Vec::new(),
        ..Default::default()
    };
    for m in &replies {
        merged.sources.extend(m.sources.iter().cloned());
        merged.images.extend(m.images.iter().cloned());
        merged.generated.extend(m.generated.iter().cloned());
    }
    Some(merged)
}

#[tauri::command]
async fn send_message(
    text: String,
    attachments: Option<Vec<UploadedFile>>,
    stream_id: Option<String>,
    system_hints: Option<Vec<String>>,
    model: Option<String>,
    thinking_effort: Option<String>,
    conversation_id: Option<String>,
    parent_message_id: Option<String>,
    state: tauri::State<'_, AppState>,
    app: tauri::AppHandle,
) -> Result<ChatResponse, String> {
    let mut client = make_client(&state)?;
    client.set_thread(conversation_id, parent_message_id);
    client.system_hints = system_hints.unwrap_or_default();
    client.set_model_choice(model, thinking_effort);
    client.cancel = stream_id.as_deref().map(|id| register_stop(&state, id));
    let attachments = attachments.unwrap_or_default();
    let result = client
        .send_message_streaming(&text, &attachments, |ev| emit_live(&app, stream_id.as_deref(), ev))
        .await;
    unregister_stop(&state, stream_id.as_deref());
    let events = result?;

    if let Some(conv_id) = &client.conversation_id {
        *state.conversation_id.lock().unwrap() = Some(conv_id.clone());
    }
    *state.parent_message_id.lock().unwrap() = client.parent_message_id.clone();

    let (full_text, reply_messages) = api::join_reply(&events);
    // One reply message streams cleanly. With several, fetch the stored reply so the final
    // text matches chatgpt.com exactly (costs one request, only in this case).
    let mut stored = None;
    if reply_messages > 1 {
        if let Some(conv_id) = client.conversation_id.clone() {
            match client.get_conversation(&conv_id).await {
                Ok(conv) => stored = stored_reply(&conv),
                Err(e) => eprintln!("could not load stored reply: {e}"),
            }
        }
    }
    let full_text = stored.as_ref().map(|m| m.content.clone()).unwrap_or(full_text);
    Ok(ChatResponse { events, full_text, stored })
}

#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct GoalResponse {
    pub iterations: u32,
    pub complete: bool,
    pub responses: Vec<ChatResponse>,
    /// The judge's last decision; None when the run was stopped before one.
    pub verdict: Option<GoalVerdict>,
}

#[derive(Serialize, Clone)]
struct GoalRound<'a> {
    stream_id: &'a str,
    round: u32,
}

/// A judge's decision after a round, like Claude Code's /goal evaluator: "met", "not_met",
/// "impossible", or "error" when the check itself failed.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
pub struct GoalVerdict {
    pub verdict: String,
    pub reason: String,
}

#[derive(Serialize, Clone)]
struct GoalCheck<'a> {
    stream_id: &'a str,
    round: u32,
    verdict: &'a GoalVerdict,
}

const GOAL_MAX_ROUNDS: u32 = 20;
/// Stop a goal run after this many rounds in a row where the worker used no tool at all
/// (only wrote text), like Claude Code's /goal stall stop: if it isn't acting, more rounds
/// won't help, and each one spends a message. Reset as soon as a round uses a tool.
const GOAL_MAX_STALLS: u32 = 3;

/// Did this round actually use a tool (a connector/python/web call, a tool result, a web
/// query, or an image it made), rather than only writing text and thinking? The live stream
/// already tags each of these as a Step with a known kind, so we read the events we have.
fn round_acted(events: &[StreamEvent]) -> bool {
    events.iter().any(|e| match e {
        StreamEvent::Step { kind, .. } => matches!(kind.as_str(), "tool_call" | "tool_result" | "tool_query"),
        StreamEvent::Generated { .. } | StreamEvent::Images { .. } => true,
        _ => false,
    })
}

/// The judge's answer: the first {...} in its reply, with "verdict" one of the three words.
/// Anything else counts as not met (so a garbled answer never ends the goal early).
fn parse_verdict(text: &str) -> GoalVerdict {
    let json = text.find('{').and_then(|a| text.rfind('}').filter(|b| *b > a).map(|b| &text[a..=b]));
    let v: serde_json::Value = json.and_then(|j| serde_json::from_str(j).ok()).unwrap_or_default();
    let verdict = v["verdict"].as_str().map(|s| s.trim().to_ascii_lowercase()).unwrap_or_default();
    let verdict = match verdict.as_str() {
        "met" | "impossible" => verdict,
        _ => "not_met".to_string(),
    };
    let reason: String = v["reason"].as_str().unwrap_or("").trim().chars().take(300).collect();
    GoalVerdict { verdict, reason }
}

fn judge_prompt(task: &str, reply: &str) -> String {
    let reply: String = if reply.chars().count() > 12_000 {
        let tail: Vec<char> = reply.chars().rev().take(12_000).collect();
        format!("…{}", tail.into_iter().rev().collect::<String>())
    } else {
        reply.to_string()
    };
    format!(
        "You check whether an autonomous agent has achieved a goal. You see only the goal and the agent's latest reply; judge from what the reply shows (an unsupported claim of success is not verification).\n\n\
         Goal:\n\"\"\"\n{task}\n\"\"\"\n\nAgent's latest reply:\n\"\"\"\n{reply}\n\"\"\"\n\n\
         Answer with only one line of JSON: {{\"verdict\": \"met\" | \"not_met\" | \"impossible\", \"reason\": \"one short sentence\"}}\n\
         - met: the reply shows the goal is fully done and verified.\n\
         - impossible: the goal cannot be achieved by further work from the agent (e.g. it asks for something nobody can currently do, or only the user can unblock it).\n\
         - not_met: otherwise; the agent can still make progress."
    )
}

/// Ask a separate ChatGPT conversation (temporary: not saved, not in the chat list; no tools)
/// whether the goal is met. Uses the same model as the run.
async fn judge_goal(task: &str, reply: &str, model: &str, state: &AppState, stop: Option<&tokio::sync::watch::Receiver<bool>>) -> GoalVerdict {
    let mut judge = match make_client(state) {
        Ok(c) => c,
        Err(e) => return GoalVerdict { verdict: "error".into(), reason: e },
    };
    judge.set_thread(None, None);
    judge.model = model.to_string();
    judge.temp_chat = true;
    judge.enable_mcp = false;
    judge.cancel = stop.cloned();
    match judge.send_message_streaming(&judge_prompt(task, reply), &[], |_| {}).await {
        Ok(events) => parse_verdict(&reply_text(&events)),
        Err(e) => GoalVerdict { verdict: "error".into(), reason: e.chars().take(300).collect() },
    }
}

/// Goal mode: keep asking ChatGPT to continue until it reports the goal done.
/// The work itself happens through the account's own connectors (MCP); this app runs nothing locally.
#[tauri::command]
async fn start_goal(
    task: String,
    stream_id: Option<String>,
    model: Option<String>,
    thinking_effort: Option<String>,
    conversation_id: Option<String>,
    parent_message_id: Option<String>,
    state: tauri::State<'_, AppState>,
    app: tauri::AppHandle,
) -> Result<GoalResponse, String> {
    let mut client = make_client(&state)?;
    client.set_thread(conversation_id, parent_message_id);
    client.set_model_choice(model, thinking_effort);
    let stop = stream_id.as_deref().map(|id| register_stop(&state, id));
    client.cancel = stop.clone();
    let mut responses = Vec::new();
    let mut verdict = None;
    let result = goal_rounds(&task, &mut client, &mut responses, &mut verdict, stop.as_ref(), stream_id.as_deref(), &state, &app).await;
    unregister_stop(&state, stream_id.as_deref());
    result?;

    if let Some(conv_id) = &client.conversation_id {
        *state.conversation_id.lock().unwrap() = Some(conv_id.clone());
    }
    *state.parent_message_id.lock().unwrap() = client.parent_message_id.clone();

    let complete = verdict.as_ref().is_some_and(|v: &GoalVerdict| v.verdict == "met");

    Ok(GoalResponse {
        iterations: responses.len() as u32,
        complete,
        responses,
        verdict,
    })
}

/// Goal rounds until the judge says the goal is met or impossible, the round limit, or Stop.
/// The worker never decides it's done itself (a reply that merely mentions being done, or a
/// marker, can't end the run); after each round a separate check reads the reply, like
/// Claude Code's /goal, and its reason is fed into the next round.
#[allow(clippy::too_many_arguments)]
async fn goal_rounds(
    task: &str,
    client: &mut ChatGptClient,
    responses: &mut Vec<ChatResponse>,
    verdict: &mut Option<GoalVerdict>,
    stop: Option<&tokio::sync::watch::Receiver<bool>>,
    stream_id: Option<&str>,
    state: &AppState,
    app: &tauri::AppHandle,
) -> Result<(), String> {
    use tauri::Emitter;
    let stopped = || stop.is_some_and(|rx| *rx.borrow());
    let mut stalls = 0u32;
    for round in 0..GOAL_MAX_ROUNDS {
        if stopped() {
            break;
        }
        let prompt = match (round, verdict.as_ref()) {
            (0, _) => format!("Work on this goal autonomously until it is done. Use your connected tools to investigate, make the changes, and verify the result.\n\nGoal: {task}"),
            (_, Some(v)) if !v.reason.is_empty() => format!("Continue working on the goal: \"{task}\"\n\nA check of your last reply found it is not done yet: {}", v.reason),
            _ => format!("Continue working on the goal: \"{task}\""),
        };

        if let Some(id) = stream_id {
            let _ = app.emit("goal-round", GoalRound { stream_id: id, round: round + 1 });
        }
        let events = client
            .send_message_streaming(&prompt, &[], |ev| emit_live(app, stream_id, ev))
            .await?;
        let full_text = reply_text(&events);
        // A round that used no tool, only text, is a stall; tool use resets the streak.
        if round_acted(&events) { stalls = 0; } else { stalls += 1; }
        // Keep the conversation pointer current so a failed later round still resumes here.
        if let Some(conv_id) = &client.conversation_id {
            *state.conversation_id.lock().unwrap() = Some(conv_id.clone());
        }
        *state.parent_message_id.lock().unwrap() = client.parent_message_id.clone();
        if stopped() {
            responses.push(ChatResponse { events, full_text, stored: None });
            break;
        }
        let v = judge_goal(task, &full_text, &client.model, state, stop).await;
        responses.push(ChatResponse { events, full_text, stored: None });
        if stopped() {
            break;
        }
        if let Some(id) = stream_id {
            let _ = app.emit("goal-check", GoalCheck { stream_id: id, round: round + 1, verdict: &v });
        }
        let done = v.verdict != "not_met";
        *verdict = Some(v);
        if done {
            break;
        }
        // Not done, and the worker has only written text for a few rounds running: it isn't
        // making progress the check can see, so stop instead of spending the rest of the rounds.
        if stalls >= GOAL_MAX_STALLS {
            *verdict = Some(GoalVerdict {
                verdict: "stalled".into(),
                reason: format!("the agent used no tools for {stalls} rounds in a row"),
            });
            break;
        }
    }
    Ok(())
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

/// "IS_STREAMING" while a reply is being written in this chat (also by chatgpt.com), else
/// e.g. "COMPLETE".
#[tauri::command]
async fn stream_status_cmd(id: String, state: tauri::State<'_, AppState>) -> Result<String, String> {
    if id.is_empty() || id.len() > 100 || !id.chars().all(|c| c.is_ascii_alphanumeric() || c == '-') {
        return Err("Invalid conversation id.".into());
    }
    make_client(&state)?.stream_status(&id).await
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

/// An image ChatGPT created, as a data: URL the webview can show. Its file link needs the
/// account's authorization, which the webview doesn't have.
#[tauri::command]
async fn generated_image(file_id: String, state: tauri::State<'_, AppState>) -> Result<String, String> {
    use base64::Engine;
    let (bytes, mime) = make_client(&state)?.fetch_image_file(&file_id).await?;
    Ok(format!("data:{mime};base64,{}", base64::engine::general_purpose::STANDARD.encode(bytes)))
}

/// Save an image ChatGPT created to the Downloads folder (viewer "Download").
#[tauri::command]
async fn save_generated_image(file_id: String, name: String, state: tauri::State<'_, AppState>) -> Result<String, String> {
    let (bytes, mime) = make_client(&state)?.fetch_image_file(&file_id).await?;
    save_to_downloads(&bytes, image_ext(&mime).ok_or("Not an image.")?, &name)
}

fn image_ext(mime: &str) -> Option<&'static str> {
    match mime {
        t if t.starts_with("image/png") => Some("png"),
        t if t.starts_with("image/webp") => Some("webp"),
        t if t.starts_with("image/gif") => Some("gif"),
        t if t.starts_with("image/jpeg") => Some("jpg"),
        _ => None,
    }
}

fn save_to_downloads(bytes: &[u8], ext: &str, name: &str) -> Result<String, String> {
    let dir = dirs::download_dir().ok_or("No Downloads folder found.")?;
    let path = unique_path(&dir, &safe_stem(name), ext);
    std::fs::write(&path, bytes).map_err(|e| format!("Could not save: {e}"))?;
    Ok(path.to_string_lossy().to_string())
}

/// Voice mode: trade the webview's WebRTC offer for the server's answer (needs the token,
/// which the webview doesn't have).
#[tauri::command]
async fn voice_connect(sdp: String, settings: Option<api::VoiceSettings>, state: tauri::State<'_, AppState>) -> Result<String, String> {
    make_client(&state)?.voice_connect(&sdp, &settings.unwrap_or_default()).await
}

/// Model families for the composer's model/effort picker.
#[tauri::command]
async fn models_cmd(state: tauri::State<'_, AppState>) -> Result<api::ModelList, String> {
    make_client(&state)?.list_models().await
}

/// The composer's "@" menu entries for this account.
#[tauri::command]
async fn system_hints_cmd(state: tauri::State<'_, AppState>) -> Result<Vec<api::SystemHint>, String> {
    make_client(&state)?.list_system_hints().await
}

#[tauri::command]
async fn voices_cmd(state: tauri::State<'_, AppState>, locale: String) -> Result<api::VoiceList, String> {
    make_client(&state)?.list_voices(&locale).await
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
    let ctype = resp.headers().get(reqwest::header::CONTENT_TYPE).and_then(|v| v.to_str().ok()).unwrap_or("").to_string();
    let ext = image_ext(&ctype).ok_or_else(|| format!("Not an image ({ctype})."))?;
    const MAX: usize = 50 * 1024 * 1024;
    let bytes = resp.bytes().await.map_err(|e| format!("Download failed: {e}"))?;
    if bytes.len() > MAX {
        return Err("Image is larger than 50 MB.".into());
    }
    save_to_downloads(&bytes, ext, &name)
}

/// Save a rendered mermaid diagram's SVG (from the frontend) to the Downloads folder, the way
/// chatgpt.com's diagram "Download" does. The markup is produced locally by the mermaid library,
/// so no network fetch is involved.
#[tauri::command]
fn save_svg(name: String, svg: String) -> Result<String, String> {
    const MAX: usize = 10 * 1024 * 1024;
    if svg.len() > MAX {
        return Err("Diagram is too large.".into());
    }
    let head = svg.trim_start();
    if !(head.starts_with("<svg") || head.starts_with("<?xml")) {
        return Err("Not an SVG.".into());
    }
    save_to_downloads(svg.as_bytes(), "svg", &name)
}

#[cfg(test)]
mod goal_tests {
    use super::*;

    #[test]
    fn verdict_comes_from_the_judge_json_only() {
        let v = parse_verdict("{\"verdict\": \"met\", \"reason\": \"All tests pass.\"}");
        assert_eq!((v.verdict.as_str(), v.reason.as_str()), ("met", "All tests pass."));
        // JSON wrapped in prose or a code fence still counts.
        assert_eq!(parse_verdict("```json\n{\"verdict\":\"IMPOSSIBLE\",\"reason\":\"Open problem.\"}\n```").verdict, "impossible");
        assert_eq!(parse_verdict("{\"verdict\":\"not_met\",\"reason\":\"No proof yet.\"}").verdict, "not_met");
        // The reply that ended a run too early: a worker saying it will NOT claim completion.
        assert_eq!(parse_verdict("ผมจะไม่ใส่ [GOAL_COMPLETE] เพราะยังพิสูจน์ไม่ได้").verdict, "not_met");
        // Garbled or unknown answers never end the goal.
        assert_eq!(parse_verdict("met").verdict, "not_met");
        assert_eq!(parse_verdict("{\"verdict\":\"done\"}").verdict, "not_met");
        assert_eq!(parse_verdict("").verdict, "not_met");
    }

    #[test]
    fn judge_prompt_holds_goal_and_the_end_of_a_long_reply() {
        let p = judge_prompt("Fix the build", "short reply");
        assert!(p.contains("Fix the build") && p.contains("short reply") && p.contains("\"verdict\""));
        let long = format!("{}END", "x".repeat(20_000));
        let p = judge_prompt("g", &long);
        assert!(p.contains("…") && p.contains("END") && p.len() < 14_000);
    }

    fn step(kind: &str) -> StreamEvent {
        StreamEvent::Step { id: "m".into(), kind: kind.into(), title: String::new(), detail: String::new(), tool: String::new(), sources: vec![], icon: String::new() }
    }
    fn text(delta: &str) -> StreamEvent {
        StreamEvent::Text { delta: delta.into(), id: "m".into() }
    }

    #[test]
    fn a_round_counts_as_acting_only_when_it_used_a_tool() {
        // A tool/connector call, its result, or a web query all count as acting.
        assert!(round_acted(&[text("thinking out loud"), step("tool_call")]));
        assert!(round_acted(&[step("tool_result")]));
        assert!(round_acted(&[step("tool_query")]));
        // Creating an image is acting too.
        assert!(round_acted(&[StreamEvent::Generated { images: vec![] }]));
        assert!(round_acted(&[StreamEvent::Images { images: vec![] }]));
        // Pure reply text, thinking, and the "Worked for Ns" recap are NOT acting.
        assert!(!round_acted(&[text("a long written answer"), step("thought"), step("recap")]));
        assert!(!round_acted(&[]));
    }
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

    #[test]
    fn save_svg_rejects_non_svg_without_writing() {
        // Guards must fail before any file is written, so these never touch Downloads.
        assert!(save_svg("d".into(), "<html>nope</html>".into()).is_err());
        assert!(save_svg("d".into(), "alert(1)".into()).is_err());
        assert!(save_svg("d".into(), format!("<svg>{}", "x".repeat(11 * 1024 * 1024))).is_err());
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
        stops: Mutex::new(std::collections::HashMap::new()),
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
            stream_status_cmd,
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
            save_svg,
            system_hints_cmd,
            voices_cmd,
            models_cmd,
            stop_generation,
            voice_connect,
            generated_image,
            save_generated_image,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
