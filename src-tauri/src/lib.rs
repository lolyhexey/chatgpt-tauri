mod agents;
mod api;
mod api_helpers;
mod auth;
mod pow;
mod tools;
mod types;

use api::ChatGptClient;
use serde::{Deserialize, Serialize};
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

#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct ChatResponse {
    pub events: Vec<StreamEvent>,
    pub tool_calls: Vec<tools::ToolCall>,
    pub tool_results: Vec<tools::ToolResult>,
    pub full_text: String,
}

async fn chat_with_tools(client: &mut ChatGptClient, initial_text: &str, cwd: &str, is_first: bool) -> Result<ChatResponse, String> {
    let message = if is_first {
        format!("{}\n\n{}", tools::build_system_prompt(cwd), initial_text)
    } else {
        initial_text.to_string()
    };

    let events = client.send_message(&message).await?;
    let full_text: String = events.iter().filter_map(|e| match e {
        StreamEvent::Text { delta } => Some(delta.as_str()),
        _ => None,
    }).collect();

    let mut all_events = events;
    let mut all_tool_calls = Vec::new();
    let mut all_tool_results = Vec::new();
    let mut response_text = full_text.clone();

    let max_rounds = 50;
    for _ in 0..max_rounds {
        let Some(tool_call) = tools::parse_tool_call(&response_text) else { break };

        if tool_call.name == "spawn_agents" {
            let subtasks_val = tool_call.args.get("subtasks").cloned().unwrap_or_default();
            let subtasks: Vec<agents::Subtask> = serde_json::from_value(subtasks_val).unwrap_or_default();
            if subtasks.is_empty() {
                let result = tools::ToolResult { result: None, error: Some("subtasks must be non-empty".into()) };
                all_tool_calls.push(tool_call.clone());
                all_tool_results.push(result.clone());
                let msg = format!("Tool \"spawn_agents\" returned:\n```\nERROR: {}\n```\nFix the arguments.", result.error.as_deref().unwrap_or(""));
                let events = client.send_message(&msg).await?;
                response_text = events.iter().filter_map(|e| match e { StreamEvent::Text { delta } => Some(delta.as_str()), _ => None }).collect();
                all_events.extend(events);
                continue;
            }

            all_tool_calls.push(tool_call);
            let runner = agents::AgentRunner::new(client.token.clone(), client.model.clone(), cwd.to_string());
            let results = runner.run(subtasks).await;

            let summary: String = results.iter().enumerate().map(|(i, r)| {
                let status = if let Some(e) = &r.error { format!("FAILED: {e}") } else { "OK".into() };
                let text = if r.result.len() > 2000 { &r.result[..2000] } else { &r.result };
                format!("Agent #{} [{}]: {}\nFiles: {}\n{}", i + 1, status, r.task, r.files.join(", "), text)
            }).collect::<Vec<_>>().join("\n\n---\n\n");

            let ok = results.iter().filter(|r| r.error.is_none()).count();
            all_tool_results.push(tools::ToolResult { result: Some(format!("{ok}/{} agents completed", results.len())), error: None });

            let msg = format!("Tool \"spawn_agents\" returned ({ok}/{} succeeded):\n```\n{summary}\n```\nReview results. Use tools to verify. Fix issues.", results.len());
            let events = client.send_message(&msg).await?;
            response_text = events.iter().filter_map(|e| match e { StreamEvent::Text { delta } => Some(delta.as_str()), _ => None }).collect();
            all_events.extend(events);
        } else {
            let result = tools::execute_tool(&tool_call.name, &tool_call.args, cwd).await;
            all_tool_calls.push(tool_call.clone());
            all_tool_results.push(result.clone());

            let output = if let Some(e) = &result.error { format!("ERROR: {e}") } else { result.result.clone().unwrap_or_default() };
            let msg = format!("Tool \"{}\" returned:\n```\n{output}\n```\nContinue with the user's request.", tool_call.name);
            let events = client.send_message(&msg).await?;
            response_text = events.iter().filter_map(|e| match e { StreamEvent::Text { delta } => Some(delta.as_str()), _ => None }).collect();
            all_events.extend(events);
        }
    }

    Ok(ChatResponse {
        events: all_events,
        tool_calls: all_tool_calls,
        tool_results: all_tool_results,
        full_text: response_text,
    })
}

#[tauri::command]
async fn send_message(
    text: String,
    is_first: bool,
    state: tauri::State<'_, AppState>,
    _app: tauri::AppHandle,
) -> Result<ChatResponse, String> {
    let mut client = make_client(&state)?;
    let cwd = state.cwd.clone();
    let response = chat_with_tools(&mut client, &text, &cwd, is_first).await?;

    if let Some(conv_id) = &client.conversation_id {
        *state.conversation_id.lock().unwrap() = Some(conv_id.clone());
    }
    *state.parent_message_id.lock().unwrap() = client.parent_message_id.clone();

    Ok(response)
}

#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct GoalResponse {
    pub iterations: u32,
    pub total_calls: u32,
    pub complete: bool,
    pub responses: Vec<ChatResponse>,
}

#[tauri::command]
async fn start_goal(
    task: String,
    state: tauri::State<'_, AppState>,
) -> Result<GoalResponse, String> {
    let mut client = make_client(&state)?;
    let cwd = state.cwd.clone();
    let max_iterations = 20u32;
    let max_total_calls = 200u32;
    let mut total_calls = 0u32;
    let mut responses = Vec::new();

    for i in 0..max_iterations {
        if total_calls >= max_total_calls { break; }

        let prompt = if i == 0 {
            format!("{}\n\n[GOAL] Work autonomously to complete this goal. Use tools to investigate, implement, and verify. Use spawn_agents for parallel work.\n\nGoal: {task}\n\nWhen FULLY COMPLETE and VERIFIED, end your response with: [GOAL_COMPLETE]", tools::build_system_prompt(&cwd))
        } else {
            format!("Goal not yet complete. Continue working on: \"{task}\"\n\nKeep going. When done and verified, end with: [GOAL_COMPLETE]")
        };

        let response = chat_with_tools(&mut client, &prompt, &cwd, false).await?;
        total_calls += 1 + response.tool_calls.len() as u32;
        let is_complete = response.full_text.contains("[GOAL_COMPLETE]");
        responses.push(response);

        if is_complete { break; }
    }

    if let Some(conv_id) = &client.conversation_id {
        *state.conversation_id.lock().unwrap() = Some(conv_id.clone());
    }
    *state.parent_message_id.lock().unwrap() = client.parent_message_id.clone();

    let complete = responses.last().map(|r| r.full_text.contains("[GOAL_COMPLETE]")).unwrap_or(false);

    Ok(GoalResponse {
        iterations: responses.len() as u32,
        total_calls,
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
            start_goal,
            open_file_path,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
