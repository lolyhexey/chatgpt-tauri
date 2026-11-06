use crate::api::ChatGptClient;
use serde::{Deserialize, Serialize};
use std::time::Instant;
use tokio::sync::Semaphore;
use std::sync::Arc;

#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct Subtask {
    pub task: String,
    pub files: Option<Vec<String>>,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct AgentResult {
    pub task: String,
    pub files: Vec<String>,
    pub result: String,
    pub error: Option<String>,
    pub seconds: f64,
}

pub struct AgentRunner {
    pub token: String,
    pub model: String,
    pub cwd: String,
    pub reasoning_effort: Option<String>,
    pub max_concurrency: usize,
}

impl AgentRunner {
    pub fn new(token: String, model: String, cwd: String) -> Self {
        Self {
            token,
            model,
            cwd,
            reasoning_effort: None,
            max_concurrency: 5,
        }
    }

    fn project_context(&self) -> String {
        let tree = scan_dir(&self.cwd, 0, 2, 60);
        format!(
            "Working directory: {}\nPlatform: {}\n\nProject structure:\n{}",
            self.cwd,
            if cfg!(windows) { "Windows" } else { std::env::consts::OS },
            tree.join("\n")
        )
    }

    pub async fn run(&self, subtasks: Vec<Subtask>) -> Vec<AgentResult> {
        let ctx = self.project_context();
        let semaphore = Arc::new(Semaphore::new(self.max_concurrency));
        let mut handles = Vec::new();

        for (i, subtask) in subtasks.iter().enumerate() {
            let token = self.token.clone();
            let model = self.model.clone();
            let effort = self.reasoning_effort.clone();
            let ctx = ctx.clone();
            let task = subtask.task.clone();
            let files = subtask.files.clone().unwrap_or_default();
            let sem = semaphore.clone();

            let handle = tokio::spawn(async move {
                let _permit = sem.acquire().await.unwrap();
                let start = Instant::now();

                let file_list = files.join(", ");
                let briefing = format!(
                    "You are Agent #{} in a parallel team. Work ONLY on your assigned task and files.\n\n{}\n\nYour assigned files: {}\nDO NOT modify files outside your assignment.\n\nTask: {}",
                    i + 1, ctx, if file_list.is_empty() { "(none specified)" } else { &file_list }, task
                );

                let mut client = ChatGptClient::new(token);
                client.model = model;
                client.temp_chat = false;
                client.enable_mcp = true;
                if let Some(effort) = effort {
                    client.reasoning_effort = Some(effort);
                }

                let result = match client.send_message(&briefing).await {
                    Ok(events) => {
                        let text: String = events.iter().filter_map(|e| {
                            match e {
                                crate::types::StreamEvent::Text { delta } => Some(delta.as_str()),
                                _ => None,
                            }
                        }).collect();
                        if text.is_empty() {
                            AgentResult {
                                task: task.clone(),
                                files: files.clone(),
                                result: String::new(),
                                error: Some("Empty response".into()),
                                seconds: start.elapsed().as_secs_f64(),
                            }
                        } else {
                            AgentResult {
                                task: task.clone(),
                                files: files.clone(),
                                result: text,
                                error: None,
                                seconds: start.elapsed().as_secs_f64(),
                            }
                        }
                    }
                    Err(e) => AgentResult {
                        task: task.clone(),
                        files: files.clone(),
                        result: String::new(),
                        error: Some(e),
                        seconds: start.elapsed().as_secs_f64(),
                    },
                };

                // Auto-delete conversation
                if client.conversation_id.is_some() {
                    let id = client.conversation_id.as_ref().unwrap().clone();
                    let _ = client.delete_conversation(&id).await;
                }

                result
            });

            handles.push(handle);
        }

        let mut results = Vec::new();
        for handle in handles {
            match handle.await {
                Ok(result) => results.push(result),
                Err(e) => results.push(AgentResult {
                    task: String::new(),
                    files: Vec::new(),
                    result: String::new(),
                    error: Some(format!("Task panicked: {e}")),
                    seconds: 0.0,
                }),
            }
        }

        results
    }
}

fn scan_dir(dir: &str, depth: usize, max_depth: usize, max_files: usize) -> Vec<String> {
    let mut lines = Vec::new();
    let entries = match std::fs::read_dir(dir) {
        Ok(e) => e,
        Err(_) => return lines,
    };
    for entry in entries.flatten() {
        if lines.len() >= max_files {
            lines.push("  ...".into());
            break;
        }
        let name = entry.file_name().to_string_lossy().to_string();
        if name.starts_with('.') || ["node_modules", "__pycache__", "dist", "build", "target"].contains(&name.as_str()) {
            continue;
        }
        let indent = "  ".repeat(depth);
        if entry.path().is_dir() {
            lines.push(format!("{indent}{name}/"));
            if depth < max_depth {
                lines.extend(scan_dir(
                    &entry.path().to_string_lossy(),
                    depth + 1,
                    max_depth,
                    max_files - lines.len(),
                ));
            }
        } else {
            lines.push(format!("{indent}{name}"));
        }
    }
    lines
}
