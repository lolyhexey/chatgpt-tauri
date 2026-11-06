mod api_helpers;
mod auth;
mod pow;
mod types;

use std::sync::Mutex;
use types::AppState;

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
    };

    tauri::Builder::default()
        .manage(state)
        .invoke_handler(tauri::generate_handler![get_token, save_token, clear_token])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
