mod agents;
mod api;
mod api_helpers;
mod auth;
mod pow;
mod tools;
mod types;

use api::ChatGptClient;
use std::sync::Mutex;
use types::*;

pub struct AppState {
    pub token: Mutex<Option<String>>,
    pub cwd: String,
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

#[tauri::command]
async fn send_message(
    text: String,
    state: tauri::State<'_, AppState>,
    _app: tauri::AppHandle,
) -> Result<Vec<StreamEvent>, String> {
    let mut client = make_client(&state)?;
    let events = client.send_message(&text).await?;

    if let Some(conv_id) = &client.conversation_id {
        *state.conversation_id.lock().unwrap() = Some(conv_id.clone());
    }
    *state.parent_message_id.lock().unwrap() = client.parent_message_id.clone();

    Ok(events)
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

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let token = auth::load_token();
    let cwd = std::env::current_dir()
        .unwrap_or_default()
        .to_string_lossy()
        .to_string();

    let state = AppState {
        token: Mutex::new(token),
        cwd,
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
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
