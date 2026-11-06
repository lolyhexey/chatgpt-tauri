use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::fs;
use std::path::{Path, PathBuf};
use std::time::Duration;
use tokio::process::Command;

#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct ToolCall {
    pub name: String,
    pub args: Value,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct ToolResult {
    pub result: Option<String>,
    pub error: Option<String>,
}

impl ToolResult {
    fn ok(result: String) -> Self {
        Self { result: Some(result), error: None }
    }
    fn err(error: String) -> Self {
        Self { result: None, error: Some(error) }
    }
}

pub fn parse_tool_call(text: &str) -> Option<ToolCall> {
    let start = text.find("```tool")?;
    let after = &text[start + 7..];
    let nl = after.find('\n')?;
    let rest = &after[nl + 1..];
    let end = rest.find("```")?;
    let json_str = rest[..end].trim();

    let val: Value = serde_json::from_str(json_str).ok()?;
    let name = val.get("name")?.as_str()?.to_string();
    let args = val.get("args").cloned().unwrap_or(Value::Object(Default::default()));

    if name.is_empty() {
        return None;
    }

    Some(ToolCall { name, args })
}

pub async fn execute_tool(name: &str, args: &Value, cwd: &str) -> ToolResult {
    match name {
        "read_file" => tool_read_file(args, cwd),
        "write_file" => tool_write_file(args, cwd),
        "edit_file" => tool_edit_file(args, cwd),
        "shell" => tool_shell(args, cwd).await,
        "ls" => tool_ls(args, cwd),
        "grep" => tool_grep(args, cwd),
        "glob" => tool_glob(args, cwd),
        "mkdir" => tool_mkdir(args, cwd),
        "delete" => tool_delete(args, cwd),
        "copy" => tool_copy(args, cwd),
        "spawn_agents" => ToolResult::err("spawn_agents is handled separately".into()),
        _ => ToolResult::err(format!("Unknown tool: {name}")),
    }
}

fn resolve_path(cwd: &str, path: &str) -> PathBuf {
    let p = Path::new(path);
    if p.is_absolute() { p.to_path_buf() } else { Path::new(cwd).join(p) }
}

fn tool_read_file(args: &Value, cwd: &str) -> ToolResult {
    let path = match args.get("path").and_then(|p| p.as_str()) {
        Some(p) => p,
        None => return ToolResult::err("Missing 'path' argument".into()),
    };
    let full = resolve_path(cwd, path);
    if !full.exists() {
        return ToolResult::err(format!("File not found: {path}"));
    }
    let content = match fs::read_to_string(&full) {
        Ok(c) => c,
        Err(e) => return ToolResult::err(format!("Read error: {e}")),
    };
    let lines: Vec<&str> = content.lines().collect();
    let offset = args.get("offset").and_then(|v| v.as_u64()).unwrap_or(0) as usize;
    let limit = args.get("limit").and_then(|v| v.as_u64()).map(|v| v as usize).unwrap_or(lines.len());
    let result: String = lines.iter()
        .skip(offset)
        .take(limit)
        .enumerate()
        .map(|(i, line)| format!("{}\t{}", offset + i + 1, line))
        .collect::<Vec<_>>()
        .join("\n");
    ToolResult::ok(result)
}

fn tool_write_file(args: &Value, cwd: &str) -> ToolResult {
    let path = match args.get("path").and_then(|p| p.as_str()) {
        Some(p) => p,
        None => return ToolResult::err("Missing 'path' argument".into()),
    };
    let content = args.get("content").and_then(|c| c.as_str()).unwrap_or("");
    let full = resolve_path(cwd, path);
    if let Some(parent) = full.parent() {
        let _ = fs::create_dir_all(parent);
    }
    match fs::write(&full, content) {
        Ok(_) => ToolResult::ok(format!("Written {} bytes to {path}", content.len())),
        Err(e) => ToolResult::err(format!("Write error: {e}")),
    }
}

fn tool_edit_file(args: &Value, cwd: &str) -> ToolResult {
    let path = match args.get("path").and_then(|p| p.as_str()) {
        Some(p) => p,
        None => return ToolResult::err("Missing 'path' argument".into()),
    };
    let old_str = args.get("old_str").and_then(|s| s.as_str()).unwrap_or("");
    let new_str = args.get("new_str").and_then(|s| s.as_str()).unwrap_or("");
    let full = resolve_path(cwd, path);
    if !full.exists() {
        return ToolResult::err(format!("File not found: {path}"));
    }
    let source = match fs::read_to_string(&full) {
        Ok(c) => c,
        Err(e) => return ToolResult::err(format!("Read error: {e}")),
    };
    let count = source.matches(old_str).count();
    if count == 0 {
        return ToolResult::err("old_str not found in file".into());
    }
    if count > 1 {
        return ToolResult::err(format!("old_str matches {count} times, must match exactly once"));
    }
    let new_source = source.replacen(old_str, new_str, 1);
    match fs::write(&full, new_source) {
        Ok(_) => ToolResult::ok(format!("Edited {path}")),
        Err(e) => ToolResult::err(format!("Write error: {e}")),
    }
}

async fn tool_shell(args: &Value, cwd: &str) -> ToolResult {
    let command = match args.get("command").and_then(|c| c.as_str()) {
        Some(c) => c,
        None => return ToolResult::err("Missing 'command' argument".into()),
    };
    let dir = args.get("cwd").and_then(|c| c.as_str())
        .map(|c| resolve_path(cwd, c))
        .unwrap_or_else(|| PathBuf::from(cwd));
    let timeout_secs = args.get("timeout").and_then(|t| t.as_u64()).unwrap_or(30).min(300);

    let result = tokio::time::timeout(
        Duration::from_secs(timeout_secs),
        Command::new("cmd")
            .args(["/C", command])
            .current_dir(&dir)
            .output(),
    )
    .await;

    match result {
        Ok(Ok(output)) => {
            let stdout = String::from_utf8_lossy(&output.stdout).to_string();
            let stderr = String::from_utf8_lossy(&output.stderr).to_string();
            if output.status.success() {
                ToolResult::ok(if stdout.trim().is_empty() { "(no output)".into() } else { stdout.trim().to_string() })
            } else {
                let combined = [stdout.trim(), stderr.trim()].iter().filter(|s| !s.is_empty()).cloned().collect::<Vec<_>>().join("\n");
                ToolResult::err(if combined.is_empty() { format!("Exit code: {}", output.status) } else { combined })
            }
        }
        Ok(Err(e)) => ToolResult::err(format!("Command failed: {e}")),
        Err(_) => ToolResult::err(format!("Command timed out after {timeout_secs}s")),
    }
}

fn tool_ls(args: &Value, cwd: &str) -> ToolResult {
    let path = args.get("path").and_then(|p| p.as_str()).unwrap_or(".");
    let full = resolve_path(cwd, path);
    if !full.is_dir() {
        return ToolResult::err(format!("Directory not found: {path}"));
    }
    let entries = match fs::read_dir(&full) {
        Ok(e) => e,
        Err(e) => return ToolResult::err(format!("Read dir error: {e}")),
    };
    let mut lines = vec![full.to_string_lossy().to_string()];
    for entry in entries.flatten() {
        let name = entry.file_name().to_string_lossy().to_string();
        if let Ok(meta) = entry.metadata() {
            if meta.is_dir() {
                lines.push(format!("  dir   {name}/"));
            } else {
                lines.push(format!("  {:>8.1}K  {name}", meta.len() as f64 / 1024.0));
            }
        }
    }
    ToolResult::ok(lines.join("\n"))
}

fn tool_grep(args: &Value, cwd: &str) -> ToolResult {
    let pattern = match args.get("pattern").and_then(|p| p.as_str()) {
        Some(p) => p,
        None => return ToolResult::err("Missing 'pattern' argument".into()),
    };
    let re = match regex::Regex::new(pattern) {
        Ok(r) => r,
        Err(e) => return ToolResult::err(format!("Invalid regex: {e}")),
    };
    let base = args.get("path").and_then(|p| p.as_str()).unwrap_or(".");
    let full = resolve_path(cwd, base);
    let glob_pat = args.get("glob").and_then(|g| g.as_str()).unwrap_or("*");

    let mut hits = Vec::new();
    collect_grep_hits(&full, glob_pat, &re, &mut hits, 80);
    ToolResult::ok(if hits.is_empty() { "(no matches)".into() } else { hits.join("\n") })
}

fn collect_grep_hits(dir: &Path, glob_pat: &str, re: &regex::Regex, hits: &mut Vec<String>, max: usize) {
    let entries = match fs::read_dir(dir) { Ok(e) => e, Err(_) => return };
    for entry in entries.flatten() {
        if hits.len() >= max { return; }
        let path = entry.path();
        let name = entry.file_name().to_string_lossy().to_string();
        if path.is_dir() {
            if !["node_modules", ".git", "target", "dist", "build"].contains(&name.as_str()) {
                collect_grep_hits(&path, glob_pat, re, hits, max);
            }
        } else if glob_matches(&name, glob_pat) {
            if let Ok(content) = fs::read_to_string(&path) {
                for (i, line) in content.lines().enumerate() {
                    if re.is_match(line) {
                        hits.push(format!("{}:{}:{}", path.display(), i + 1, line));
                        if hits.len() >= max { return; }
                    }
                }
            }
        }
    }
}

fn glob_matches(name: &str, pattern: &str) -> bool {
    if pattern == "*" { return true; }
    let re_str = format!("^{}$", pattern.replace('.', "\\.").replace('*', ".*").replace('?', "."));
    regex::Regex::new(&re_str).map(|r| r.is_match(name)).unwrap_or(false)
}

fn tool_glob(args: &Value, cwd: &str) -> ToolResult {
    let pattern = match args.get("pattern").and_then(|p| p.as_str()) {
        Some(p) => p,
        None => return ToolResult::err("Missing 'pattern' argument".into()),
    };
    let base = args.get("path").and_then(|p| p.as_str()).unwrap_or(".");
    let full = resolve_path(cwd, base);
    let mut files = Vec::new();
    collect_glob_files(&full, pattern, &mut files, 50);
    ToolResult::ok(if files.is_empty() { "(no matches)".into() } else { files.join("\n") })
}

fn collect_glob_files(dir: &Path, pattern: &str, files: &mut Vec<String>, max: usize) {
    let entries = match fs::read_dir(dir) { Ok(e) => e, Err(_) => return };
    for entry in entries.flatten() {
        if files.len() >= max { return; }
        let path = entry.path();
        let name = entry.file_name().to_string_lossy().to_string();
        if path.is_dir() {
            if !["node_modules", ".git", "target", "dist", "build"].contains(&name.as_str()) {
                collect_glob_files(&path, pattern, files, max);
            }
        } else if glob_matches(&name, pattern) {
            files.push(path.to_string_lossy().to_string());
        }
    }
}

fn tool_mkdir(args: &Value, cwd: &str) -> ToolResult {
    let path = match args.get("path").and_then(|p| p.as_str()) {
        Some(p) => p,
        None => return ToolResult::err("Missing 'path' argument".into()),
    };
    let full = resolve_path(cwd, path);
    match fs::create_dir_all(&full) {
        Ok(_) => ToolResult::ok(format!("Created {path}")),
        Err(e) => ToolResult::err(format!("Mkdir error: {e}")),
    }
}

fn tool_delete(args: &Value, cwd: &str) -> ToolResult {
    let path = match args.get("path").and_then(|p| p.as_str()) {
        Some(p) => p,
        None => return ToolResult::err("Missing 'path' argument".into()),
    };
    let full = resolve_path(cwd, path);
    if !full.exists() {
        return ToolResult::err(format!("File not found: {path}"));
    }
    match fs::remove_file(&full) {
        Ok(_) => ToolResult::ok(format!("Deleted {path}")),
        Err(e) => ToolResult::err(format!("Delete error: {e}")),
    }
}

fn tool_copy(args: &Value, cwd: &str) -> ToolResult {
    let src = match args.get("src").and_then(|p| p.as_str()) {
        Some(p) => p,
        None => return ToolResult::err("Missing 'src' argument".into()),
    };
    let dst = match args.get("dst").and_then(|p| p.as_str()) {
        Some(p) => p,
        None => return ToolResult::err("Missing 'dst' argument".into()),
    };
    let src_full = resolve_path(cwd, src);
    let dst_full = resolve_path(cwd, dst);
    if !src_full.exists() {
        return ToolResult::err(format!("Source not found: {src}"));
    }
    match fs::copy(&src_full, &dst_full) {
        Ok(_) => ToolResult::ok(format!("Copied {src} -> {dst}")),
        Err(e) => ToolResult::err(format!("Copy error: {e}")),
    }
}

pub fn build_system_prompt(cwd: &str) -> String {
    format!(r#"[SYSTEM] You are ChatGPT UI — an autonomous coding agent on the user's machine.

Working directory: {cwd}
Platform: {platform}

BEHAVIOR:
- You are an agentic coding assistant. Investigate → plan → execute → verify.
- Use tools to read/write files and run commands. Don't describe — do it.
- Keep working until the task is complete. Verify changes after making them.
- For tasks with 2+ independent parts, use spawn_agents to parallelize.
- When finished, provide a concise summary. No tool call when done.

TOOL PROTOCOL — return exactly ONE tool call per response:
```tool
{{"name":"tool_name","args":{{"key":"value"}}}}
```

Available tools:
  read_file(path, offset?, limit?) — Read file contents
  write_file(path, content) — Write/create a file
  edit_file(path, old_str, new_str) — Replace text (must match exactly once)
  shell(command, cwd?, timeout?) — Execute shell command (1-300s timeout)
  ls(path?) — List directory
  grep(pattern, path?, glob?) — Search text in files (regex)
  glob(pattern, path?) — Find files by name pattern
  mkdir(path) — Create directory
  delete(path) — Delete a file
  copy(src, dst) — Copy a file
  spawn_agents(subtasks) — Run 2-10 parallel AI agents

spawn_agents example:
```tool
{{"name":"spawn_agents","args":{{"subtasks":[{{"task":"Create login page","files":["login.html"]}},{{"task":"Create API","files":["api.js"]}}]}}}}
```"#,
    platform = if cfg!(windows) { "Windows" } else { std::env::consts::OS })
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;

    #[test]
    fn parse_tool_call_extracts_json() {
        let text = "some text\n```tool\n{\"name\":\"ls\",\"args\":{}}\n```\nmore text";
        let call = parse_tool_call(text).unwrap();
        assert_eq!(call.name, "ls");
    }

    #[test]
    fn parse_tool_call_returns_none_for_no_match() {
        assert!(parse_tool_call("no tool here").is_none());
        assert!(parse_tool_call("```tool\ninvalid json\n```").is_none());
    }

    #[test]
    fn tool_read_file_works() {
        let dir = std::env::temp_dir().join("chatgpt_test_read");
        let _ = fs::create_dir_all(&dir);
        let file = dir.join("test.txt");
        fs::write(&file, "line1\nline2\nline3").unwrap();

        let args = serde_json::json!({"path": file.to_str().unwrap()});
        let result = tool_read_file(&args, dir.to_str().unwrap());
        assert!(result.result.is_some());
        assert!(result.result.unwrap().contains("line2"));

        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn tool_edit_file_replaces_once() {
        let dir = std::env::temp_dir().join("chatgpt_test_edit");
        let _ = fs::create_dir_all(&dir);
        let file = dir.join("edit.txt");
        fs::write(&file, "hello world").unwrap();

        let args = serde_json::json!({"path": file.to_str().unwrap(), "old_str": "world", "new_str": "rust"});
        let result = tool_edit_file(&args, dir.to_str().unwrap());
        assert!(result.error.is_none());
        assert_eq!(fs::read_to_string(&file).unwrap(), "hello rust");

        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn tool_edit_file_rejects_multiple() {
        let dir = std::env::temp_dir().join("chatgpt_test_edit2");
        let _ = fs::create_dir_all(&dir);
        let file = dir.join("dup.txt");
        fs::write(&file, "aa bb aa").unwrap();

        let args = serde_json::json!({"path": file.to_str().unwrap(), "old_str": "aa", "new_str": "cc"});
        let result = tool_edit_file(&args, dir.to_str().unwrap());
        assert!(result.error.is_some());
        assert!(result.error.unwrap().contains("2 times"));

        let _ = fs::remove_dir_all(&dir);
    }

    #[tokio::test]
    async fn tool_shell_timeout() {
        let args = serde_json::json!({"command": "ping -n 100 127.0.0.1", "timeout": 1});
        let result = tool_shell(&args, ".").await;
        assert!(result.error.is_some());
        assert!(result.error.unwrap().contains("timed out"));
    }
}
