use crate::api_helpers::{self, BASE_URL};
use crate::pow;
use crate::types::*;
use reqwest::Client;
use serde_json::{json, Value};
use std::collections::HashMap;
use uuid::Uuid;

pub struct ChatGptClient {
    pub token: String,
    pub device_id: String,
    pub client: Client,
    pub conversation_id: Option<String>,
    pub parent_message_id: String,
    pub model: String,
    pub enable_mcp: bool,
    pub temp_chat: bool,
    pub reasoning_effort: Option<String>,
    pub actual_model: Option<String>,
}

#[derive(Debug)]
pub struct Requirements {
    pub token: String,
    pub pow_seed: Option<String>,
    pub pow_difficulty: Option<String>,
}

impl ChatGptClient {
    pub fn new(token: String) -> Self {
        Self {
            token,
            device_id: api_helpers::new_device_id(),
            client: Client::builder()
                .use_rustls_tls()
                .build()
                .expect("failed to build HTTP client"),
            conversation_id: None,
            parent_message_id: Uuid::new_v4().to_string(),
            model: "auto".into(),
            enable_mcp: true,
            temp_chat: false,
            reasoning_effort: None,
            actual_model: None,
        }
    }

    fn headers(&self) -> reqwest::header::HeaderMap {
        api_helpers::base_headers(&self.token, &self.device_id)
    }

    pub async fn get_requirements(&self) -> Result<Requirements, String> {
        let url_prepare = format!("{BASE_URL}/backend-api/sentinel/chat-requirements/prepare");
        let body = json!({ "p": pow::make_app_attest() });

        let resp = self
            .client
            .post(&url_prepare)
            .headers(self.headers())
            .json(&body)
            .send()
            .await
            .map_err(|e| format!("Prepare request failed: {e}"))?;

        let status = resp.status();
        if status.as_u16() == 401 {
            return Err("Authentication failed (401). Token may have expired.".into());
        }
        if status.as_u16() == 403 {
            return Err("Access denied (403). Check account access.".into());
        }
        if !status.is_success() {
            return Err(format!("Prepare failed (HTTP {status})."));
        }

        let prep_data: Value = resp.json().await.map_err(|e| format!("Invalid prepare response: {e}"))?;

        if let Some(token) = prep_data.get("token").and_then(|t| t.as_str()) {
            return Ok(Requirements {
                token: token.to_string(),
                pow_seed: prep_data
                    .pointer("/proofofwork/seed")
                    .and_then(|s| s.as_str())
                    .map(String::from),
                pow_difficulty: prep_data
                    .pointer("/proofofwork/difficulty")
                    .and_then(|s| s.as_str())
                    .map(String::from),
            });
        }

        let prepare_token = prep_data
            .get("prepare_token")
            .and_then(|t| t.as_str())
            .ok_or("No prepare_token in response")?;

        let url_finalize = format!("{BASE_URL}/backend-api/sentinel/chat-requirements/finalize");
        let fin_body = json!({ "prepare_token": prepare_token });

        let fin_resp = self
            .client
            .post(&url_finalize)
            .headers(self.headers())
            .json(&fin_body)
            .send()
            .await
            .map_err(|e| format!("Finalize request failed: {e}"))?;

        if !fin_resp.status().is_success() {
            return Err(format!("Finalize failed (HTTP {}).", fin_resp.status()));
        }

        let fin_data: Value = fin_resp
            .json()
            .await
            .map_err(|e| format!("Invalid finalize response: {e}"))?;

        let token = fin_data
            .get("token")
            .and_then(|t| t.as_str())
            .ok_or("No token in finalize response")?
            .to_string();

        let pow_seed = fin_data
            .pointer("/proofofwork/seed")
            .and_then(|s| s.as_str())
            .map(String::from)
            .or_else(|| {
                prep_data
                    .pointer("/proofofwork/seed")
                    .and_then(|s| s.as_str())
                    .map(String::from)
            });

        let pow_difficulty = fin_data
            .pointer("/proofofwork/difficulty")
            .and_then(|s| s.as_str())
            .map(String::from)
            .or_else(|| {
                prep_data
                    .pointer("/proofofwork/difficulty")
                    .and_then(|s| s.as_str())
                    .map(String::from)
            });

        Ok(Requirements {
            token,
            pow_seed,
            pow_difficulty,
        })
    }

    /// Upload a file the way chatgpt.com does: create the file entry, PUT the bytes to the
    /// returned blob URL, then wait for process_upload_stream to report completion.
    pub async fn upload_file(&self, name: &str, bytes: Vec<u8>) -> Result<UploadedFile, String> {
        let mime = mime_for(name);
        let dims = if is_supported_image(&mime) { imagesize::blob_size(&bytes).ok() } else { None };
        let is_image = dims.is_some();
        let use_case = if is_image { "multimodal" } else { "my_files" };
        let size = bytes.len() as u64;

        let create = self
            .client
            .post(format!("{BASE_URL}/backend-api/files"))
            .headers(self.headers())
            .json(&json!({
                "file_name": name,
                "file_size": size,
                "use_case": use_case,
                "mime_type": mime,
                "timezone_offset_min": 0,
                "reset_rate_limits": false,
                "supports_direct_azure_multipart": false,
                "store_in_library": false,
            }))
            .send()
            .await
            .map_err(|e| format!("Upload request failed: {e}"))?;
        let status = create.status();
        let created: Value = create.json().await.map_err(|e| format!("Invalid upload response (HTTP {status}): {e}"))?;
        if !status.is_success() || created["status"] == "error" {
            let code = created["error_code"].as_str().or_else(|| created["detail"].as_str()).unwrap_or("unknown error");
            return Err(format!("ChatGPT rejected the file (HTTP {status}): {code}"));
        }
        let file_id = created["file_id"].as_str().ok_or("Upload response has no file_id")?.to_string();
        let upload_url = created["upload_url"].as_str().ok_or("Upload response has no upload_url")?.to_string();
        if upload_url.contains("/estuary/") {
            return Err("This account uses an upload route that is not supported yet".into());
        }

        let mut put = self
            .client
            .put(&upload_url)
            .header("Content-Type", &mime)
            .header("x-ms-blob-type", "BlockBlob")
            .header("x-ms-version", "2020-04-08")
            .header("x-ms-blob-content-type", &mime);
        if let Some(extra) = created["upload_headers"].as_object() {
            for (k, v) in extra {
                if let Some(v) = v.as_str() {
                    put = put.header(k.as_str(), v);
                }
            }
        }
        let put = put.body(bytes).send().await.map_err(|e| format!("File transfer failed: {e}"))?;
        if !put.status().is_success() {
            return Err(format!("File transfer failed (HTTP {})", put.status()));
        }

        let mut processing = self
            .client
            .post(format!("{BASE_URL}/backend-api/files/process_upload_stream"))
            .headers(self.headers())
            .json(&json!({
                "file_id": file_id,
                "file_name": name,
                "use_case": use_case,
                "mime_type": mime,
                "index_for_retrieval": !is_image,
                "metadata": { "store_in_library": false },
            }))
            .send()
            .await
            .map_err(|e| format!("Upload processing failed: {e}"))?;
        if !processing.status().is_success() {
            let status = processing.status();
            let body = processing.text().await.unwrap_or_default();
            return Err(format!("Upload processing failed (HTTP {status}): {}", &body[..body.len().min(200)]));
        }

        // The server may hold the stream open after completion, so stop at the completion event.
        let deadline = tokio::time::Instant::now() + std::time::Duration::from_secs(180);
        let mut buffer = String::new();
        loop {
            let chunk = tokio::time::timeout_at(deadline, processing.chunk())
                .await
                .map_err(|_| "Timed out waiting for ChatGPT to process the file".to_string())?
                .map_err(|e| format!("Upload processing stream failed: {e}"))?;
            let Some(chunk) = chunk else { break };
            buffer.push_str(&String::from_utf8_lossy(&chunk));
            while let Some(nl) = buffer.find('\n') {
                let line: String = buffer.drain(..=nl).collect();
                match parse_processing_event(&line) {
                    ProcessingEvent::Completed => return Ok(self.uploaded(file_id, name, mime, size, dims)),
                    ProcessingEvent::Failed(reason) => return Err(format!("ChatGPT could not process the file: {reason}")),
                    ProcessingEvent::Other => {}
                }
            }
        }
        match parse_processing_event(&buffer) {
            ProcessingEvent::Failed(reason) => Err(format!("ChatGPT could not process the file: {reason}")),
            _ => Ok(self.uploaded(file_id, name, mime, size, dims)),
        }
    }

    fn uploaded(&self, id: String, name: &str, mime: String, size: u64, dims: Option<imagesize::ImageSize>) -> UploadedFile {
        UploadedFile {
            id,
            name: name.to_string(),
            mime_type: mime,
            size,
            width: dims.map(|d| d.width as u32),
            height: dims.map(|d| d.height as u32),
            is_image: dims.is_some(),
        }
    }

    #[cfg(test)]
    pub async fn send_message(
        &mut self,
        text: &str,
        attachments: &[UploadedFile],
    ) -> Result<Vec<StreamEvent>, String> {
        self.send_message_streaming(text, attachments, |_| {}).await
    }

    /// Sends a message and calls `on_event` for each delta as the SSE stream arrives.
    pub async fn send_message_streaming<F: FnMut(&StreamEvent)>(
        &mut self,
        text: &str,
        attachments: &[UploadedFile],
        mut on_event: F,
    ) -> Result<Vec<StreamEvent>, String> {
        let reqs = self.get_requirements().await?;

        let mut headers = self.headers();
        headers.insert(
            "openai-sentinel-chat-requirements-token",
            reqs.token.parse().map_err(|_| "Invalid requirements token")?,
        );
        headers.insert("Accept", "text/event-stream".parse().unwrap());

        if let (Some(seed), Some(diff)) = (&reqs.pow_seed, &reqs.pow_difficulty) {
            let pow_token = pow::solve_pow(seed, diff)?;
            headers.insert(
                "openai-sentinel-proof-token",
                pow_token.parse().map_err(|_| "Invalid PoW token")?,
            );
        }

        let message_id = Uuid::new_v4().to_string();
        let (content, metadata) = message_content(text, attachments);

        let mut body = json!({
            "action": "next",
            "messages": [{
                "id": message_id,
                "author": { "role": "user" },
                "content": content,
                "metadata": metadata
            }],
            "model": self.model,
            "parent_message_id": self.parent_message_id,
            "timezone_offset_min": 0,
            "history_and_training_disabled": self.temp_chat,
            "conversation_mode": { "kind": "primary_assistant" },
            "force_paragen": false,
            "force_paragen_model_slug": "",
            "force_nulligen": false,
            "force_rate_limit": false,
            "websocket_request_id": Uuid::new_v4().to_string(),
        });

        if let Some(conv_id) = &self.conversation_id {
            body["conversation_id"] = json!(conv_id);
        }

        if let Some(effort) = &self.reasoning_effort {
            body["system_hints"] = json!([format!("reasoning_effort:{effort}")]);
        }

        if !self.enable_mcp {
            body["messages"][0]["metadata"]["disable_tool_ids"] = json!([
                "web", "code_interpreter", "browser", "retrieval", "analysis",
                "advanced_data_analysis", "code", "dalle_agent", "api_tool", "dynamic_tool_call"
            ]);
        }

        let url = format!("{BASE_URL}/backend-api/f/conversation");

        let mut resp = self
            .client
            .post(&url)
            .headers(headers)
            .json(&body)
            .send()
            .await
            .map_err(|e| format!("Send message failed: {e}"))?;

        if !resp.status().is_success() {
            let status = resp.status();
            let body_text = resp.text().await.unwrap_or_default();
            let cut = body_text.char_indices().nth(300).map(|(i, _)| i).unwrap_or(body_text.len());
            return Err(format!("API error (HTTP {status}): {}", &body_text[..cut]));
        }

        let mut parser = SseParser::default();
        let mut events = Vec::new();
        // Bytes, not String: a chunk boundary can split a multi-byte (e.g. Thai) character.
        let mut pending: Vec<u8> = Vec::new();
        while let Some(chunk) = resp.chunk().await.map_err(|e| format!("Stream read error: {e}"))? {
            pending.extend_from_slice(&chunk);
            while let Some(nl) = pending.iter().position(|&b| b == b'\n') {
                let line: Vec<u8> = pending.drain(..=nl).collect();
                let line = String::from_utf8_lossy(&line);
                for ev in parser.feed(line.trim_end_matches(['\r', '\n']), self) {
                    on_event(&ev);
                    events.push(ev);
                }
            }
        }
        if !pending.is_empty() {
            let line = String::from_utf8_lossy(&pending).to_string();
            for ev in parser.feed(line.trim_end(), self) {
                on_event(&ev);
                events.push(ev);
            }
        }
        if let Some(done) = parser.finish(self) {
            on_event(&done);
            events.push(done);
        }
        Ok(events)
    }

    pub async fn list_conversations(
        &self,
        offset: u32,
        limit: u32,
    ) -> Result<ConversationList, String> {
        let url = format!(
            "{BASE_URL}/backend-api/conversations?offset={offset}&limit={limit}&order=updated"
        );
        let resp = self
            .client
            .get(&url)
            .headers(self.headers())
            .send()
            .await
            .map_err(|e| format!("List conversations failed: {e}"))?;

        if resp.status().as_u16() == 401 {
            return Err("Authentication failed (401).".into());
        }
        if !resp.status().is_success() {
            return Err(format!("List failed (HTTP {}).", resp.status()));
        }

        let data: Value = resp.json().await.map_err(|e| format!("Invalid response: {e}"))?;
        let items = data
            .get("items")
            .and_then(|v| v.as_array())
            .map(|arr| {
                arr.iter()
                    .map(|c| ConversationSummary {
                        id: c["id"].as_str().unwrap_or("").to_string(),
                        title: c["title"].as_str().unwrap_or("Untitled").to_string(),
                        model: c["default_model_slug"]
                            .as_str()
                            .or_else(|| c["current_node_model_slug"].as_str())
                            .unwrap_or("")
                            .to_string(),
                        updated: c["update_time"].as_f64(),
                    })
                    .collect()
            })
            .unwrap_or_default();

        let total = data["total"].as_u64().unwrap_or(0) as u32;

        Ok(ConversationList {
            has_more: offset + limit < total,
            items,
            total,
        })
    }

    pub async fn get_conversation(&self, id: &str) -> Result<Conversation, String> {
        let url = format!("{BASE_URL}/backend-api/conversation/{id}");
        let resp = self
            .client
            .get(&url)
            .headers(self.headers())
            .send()
            .await
            .map_err(|e| format!("Get conversation failed: {e}"))?;

        if resp.status().as_u16() == 404 {
            return Err("Conversation not found.".into());
        }
        if !resp.status().is_success() {
            return Err(format!("Get failed (HTTP {}).", resp.status()));
        }

        let data: Value = resp.json().await.map_err(|e| format!("Invalid response: {e}"))?;
        let mapping = data.get("mapping").and_then(|m| m.as_object());
        let current_node = data["current_node"].as_str().unwrap_or("").to_string();

        let mut messages = Vec::new();
        if let Some(map) = mapping {
            let mut chain = Vec::new();
            let mut node_id = Some(current_node.as_str());
            while let Some(nid) = node_id {
                if nid.is_empty() {
                    break;
                }
                chain.push(nid.to_string());
                node_id = map
                    .get(nid)
                    .and_then(|n| n["parent"].as_str());
            }
            chain.reverse();

            // Search results gathered since the last user message, for the reply that cites them.
            let mut turn_sources: Vec<Source> = Vec::new();
            for nid in &chain {
                if let Some(node) = map.get(nid.as_str()) {
                    let msg = &node["message"];
                    let role = msg["author"]["role"].as_str().unwrap_or("");
                    for s in search_sources(msg) {
                        if !turn_sources.iter().any(|t| t.id == s.id) {
                            turn_sources.push(s);
                        }
                    }
                    if role == "user" {
                        turn_sources.clear();
                    }
                    if role != "user" && !is_user_visible(msg) {
                        continue;
                    }
                    let parts = msg["content"]["parts"]
                        .as_array()
                        .map(|arr| {
                            arr.iter()
                                .filter_map(|p| p.as_str())
                                .collect::<Vec<_>>()
                                .join("")
                        })
                        .unwrap_or_default();
                    let attachments: Vec<AttachmentInfo> = msg["metadata"]["attachments"]
                        .as_array()
                        .map(|arr| {
                            arr.iter()
                                .map(|a| AttachmentInfo {
                                    name: a["name"].as_str().unwrap_or("file").to_string(),
                                    mime_type: a["mime_type"].as_str().unwrap_or("").to_string(),
                                })
                                .collect()
                        })
                        .unwrap_or_default();
                    if !parts.is_empty() || !attachments.is_empty() {
                        messages.push(Message {
                            id: msg["id"].as_str().unwrap_or("").to_string(),
                            role: role.to_string(),
                            content: parts,
                            attachments,
                            sources: if role == "assistant" { turn_sources.clone() } else { Vec::new() },
                            images: if role == "assistant" { genui_images(msg) } else { Vec::new() },
                        });
                    }
                }
            }
        }

        Ok(Conversation {
            id: data["conversation_id"]
                .as_str()
                .unwrap_or(id)
                .to_string(),
            title: data["title"].as_str().unwrap_or("Untitled").to_string(),
            model: data["default_model_slug"]
                .as_str()
                .unwrap_or("")
                .to_string(),
            messages,
            current_node,
        })
    }

    pub async fn delete_conversation(&self, id: &str) -> Result<(), String> {
        let url = format!("{BASE_URL}/backend-api/conversation/{id}");
        let resp = self
            .client
            .patch(&url)
            .headers(self.headers())
            .json(&json!({ "is_visible": false }))
            .send()
            .await
            .map_err(|e| format!("Delete failed: {e}"))?;

        if !resp.status().is_success() {
            return Err(format!("Delete failed (HTTP {}).", resp.status()));
        }
        Ok(())
    }

    pub async fn delete_all_conversations(&self) -> Result<(), String> {
        let url = format!("{BASE_URL}/backend-api/conversations");
        let resp = self
            .client
            .patch(&url)
            .headers(self.headers())
            .json(&json!({ "is_visible": false }))
            .send()
            .await
            .map_err(|e| format!("Bulk delete failed: {e}"))?;

        if !resp.status().is_success() {
            return Err(format!("Bulk delete failed (HTTP {}).", resp.status()));
        }
        Ok(())
    }
}

pub fn mime_for(name: &str) -> String {
    let ext = name.rsplit('.').next().unwrap_or("").to_ascii_lowercase();
    match ext.as_str() {
        "png" => "image/png",
        "jpg" | "jpeg" => "image/jpeg",
        "gif" => "image/gif",
        "webp" => "image/webp",
        "pdf" => "application/pdf",
        "txt" | "log" => "text/plain",
        "md" => "text/markdown",
        "csv" => "text/csv",
        "json" => "application/json",
        "html" | "htm" => "text/html",
        "xml" => "application/xml",
        "js" | "mjs" | "cjs" => "text/javascript",
        "ts" | "tsx" | "jsx" | "rs" | "py" | "java" | "kt" | "go" | "c" | "h" | "cpp" | "hpp" | "cs" | "sh" | "ps1" | "toml" | "yaml" | "yml" | "ini" | "sql" | "smali" => "text/plain",
        "docx" => "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        "xlsx" => "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        "pptx" => "application/vnd.openxmlformats-officedocument.presentationml.presentation",
        "zip" => "application/zip",
        _ => "application/octet-stream",
    }
    .to_string()
}

fn is_supported_image(mime: &str) -> bool {
    matches!(mime, "image/png" | "image/jpeg" | "image/gif" | "image/webp")
}

fn asset_pointer(file_id: &str) -> String {
    if file_id.starts_with("file_") {
        format!("sediment://{file_id}")
    } else {
        format!("file-service://{file_id}")
    }
}

/// Message content + metadata in the shape chatgpt.com sends: images become
/// image_asset_pointer parts of a multimodal_text message; every file is listed in
/// metadata.attachments.
pub fn message_content(text: &str, attachments: &[UploadedFile]) -> (Value, Value) {
    if attachments.is_empty() {
        return (json!({ "content_type": "text", "parts": [text] }), json!({}));
    }
    let mut parts: Vec<Value> = attachments
        .iter()
        .filter(|a| a.is_image)
        .map(|a| {
            json!({
                "content_type": "image_asset_pointer",
                "asset_pointer": asset_pointer(&a.id),
                "size_bytes": a.size,
                "width": a.width,
                "height": a.height,
            })
        })
        .collect();
    let content = if parts.is_empty() {
        json!({ "content_type": "text", "parts": [text] })
    } else {
        parts.push(json!(text));
        json!({ "content_type": "multimodal_text", "parts": parts })
    };
    let list: Vec<Value> = attachments
        .iter()
        .map(|a| {
            let mut entry = json!({
                "id": a.id,
                "name": a.name,
                "mime_type": a.mime_type,
                "size": a.size,
                "source": "local",
            });
            if a.is_image {
                entry["width"] = json!(a.width);
                entry["height"] = json!(a.height);
            }
            entry
        })
        .collect();
    (content, json!({ "attachments": list }))
}

#[derive(Debug, PartialEq)]
enum ProcessingEvent {
    Completed,
    Failed(String),
    Other,
}

fn parse_processing_event(line: &str) -> ProcessingEvent {
    let line = line.trim();
    let data = line.strip_prefix("data:").map(str::trim).unwrap_or(line);
    let Ok(v) = serde_json::from_str::<Value>(data) else { return ProcessingEvent::Other };
    let event = v["event"].as_str().unwrap_or("");
    if event.ends_with(".completed") && event.contains("processing") {
        return ProcessingEvent::Completed;
    }
    if event.ends_with(".error") || event.ends_with(".failed") {
        let reason = v.pointer("/extra/error_code").and_then(|c| c.as_str()).unwrap_or(event);
        return ProcessingEvent::Failed(reason.to_string());
    }
    ProcessingEvent::Other
}

pub fn parse_sse_line(line: &str) -> Option<(String, Value)> {
    let data_str = line.strip_prefix("data: ")?;
    if data_str == "[DONE]" {
        return None;
    }
    let data: Value = serde_json::from_str(data_str).ok()?;
    let msg = data.get("message")?;
    let msg_id = msg.get("id")?.as_str()?.to_string();
    let role = msg.pointer("/author/role")?.as_str()?;
    if role != "assistant" && role != "tool" {
        return None;
    }
    Some((msg_id, data))
}

fn http_url(v: &Value) -> Option<String> {
    v.as_str().filter(|u| u.starts_with("https://") || u.starts_with("http://")).map(str::to_string)
}

/// Images chatgpt.com resolved for the reply's <AsyncImage/> components
/// (metadata.model_dil_v2.appData.opGenui.componentResults), matched to tags by query.
fn genui_images(msg: &Value) -> Vec<GenImage> {
    let Some(results) = msg.pointer("/metadata/model_dil_v2/appData/opGenui/componentResults").and_then(|r| r.as_object()) else {
        return Vec::new();
    };
    let mut out: Vec<GenImage> = Vec::new();
    for result in results.values() {
        if result["status"].as_str() != Some("resolved") {
            continue;
        }
        let Some(img) = result.pointer("/state/images/0") else { continue };
        let Some(query) = img["image_search_query"].as_str().filter(|q| !q.is_empty()) else { continue };
        let Some(url) = http_url(&img["content_url"]).or_else(|| http_url(&img["thumbnail_url"])) else { continue };
        if out.iter().any(|o| o.query == query) {
            continue;
        }
        let source_url = http_url(&img["url"]).unwrap_or_default();
        let source_host = source_url
            .split("://").nth(1).unwrap_or("")
            .split(['/', '?', '#']).next().unwrap_or("")
            .trim_start_matches("www.")
            .to_string();
        out.push(GenImage {
            query: query.to_string(),
            thumbnail: http_url(&img["thumbnail_url"]).unwrap_or_else(|| url.clone()),
            url,
            source_url,
            source_host,
            title: truncate_chars(img["title"].as_str().unwrap_or(""), 200),
            show_url: img["show_url"].as_bool().unwrap_or(false),
        });
    }
    out
}

/// Search results carried by a message, with the ids replies use to cite them.
fn search_sources(msg: &Value) -> Vec<Source> {
    let groups = msg.pointer("/metadata/search_result_groups").and_then(|g| g.as_array());
    let Some(groups) = groups else { return Vec::new() };
    let mut out = Vec::new();
    for group in groups {
        let domain = group["domain"].as_str().unwrap_or("");
        for e in group["entries"].as_array().into_iter().flatten() {
            let r = &e["ref_id"];
            let (Some(turn), Some(kind), Some(index)) = (r["turn_index"].as_u64(), r["ref_type"].as_str(), r["ref_index"].as_u64()) else {
                continue;
            };
            let url = e["url"].as_str().unwrap_or("");
            if !(url.starts_with("https://") || url.starts_with("http://")) {
                continue;
            }
            let attribution = e["attribution"].as_str().filter(|a| !a.is_empty()).unwrap_or(domain);
            out.push(Source {
                id: format!("turn{turn}{kind}{index}"),
                url: url.to_string(),
                title: truncate_chars(e["title"].as_str().unwrap_or(""), 200),
                attribution: attribution.to_string(),
                name: e["source_name"].as_str().unwrap_or("").to_string(),
            });
        }
    }
    out
}

fn truncate_chars(s: &str, max: usize) -> String {
    match s.char_indices().nth(max) {
        Some((i, _)) => format!("{}…", &s[..i]),
        None => s.to_string(),
    }
}

fn friendly_tool(recipient: &str) -> String {
    let r = recipient.to_ascii_lowercase();
    if r.starts_with("web") || r.contains("search") && !r.contains("file") {
        "Searching the web".into()
    } else if r.starts_with("container") || r.starts_with("python") {
        "Running code".into()
    } else if r.contains("file") || r.contains("browser") {
        "Reading files".into()
    } else if r.starts_with("api_tool") || r.contains("mcp") || r.contains("connector") {
        "Using a connector".into()
    } else if r.contains("image") || r.contains("dalle") {
        "Creating an image".into()
    } else {
        format!("Using {recipient}")
    }
}

/// What a tool call is doing, for display: search queries, a command, or the raw request.
fn tool_call_detail(msg: &Value) -> String {
    let content = &msg["content"];
    let raw = content["text"].as_str().map(str::to_string).unwrap_or_else(|| {
        content["parts"].as_array().map(|p| p.iter().filter_map(|x| x.as_str()).collect::<Vec<_>>().join("")).unwrap_or_default()
    });
    if let Ok(v) = serde_json::from_str::<Value>(&raw) {
        let queries: Vec<String> = ["search_query", "queries", "query"]
            .iter()
            .filter_map(|k| v.get(*k))
            .flat_map(|q| match q {
                Value::Array(items) => items
                    .iter()
                    .filter_map(|i| i.get("q").or(Some(i)).and_then(|s| s.as_str()).map(str::to_string))
                    .collect::<Vec<_>>(),
                Value::String(s) => vec![s.clone()],
                _ => vec![],
            })
            .collect();
        if !queries.is_empty() {
            return truncate_chars(&queries.join(" · "), 300);
        }
        if let Some(path) = v.get("path").and_then(|p| p.as_str()) {
            let name = path.rsplit('/').next().unwrap_or(path);
            let args = v.get("args").map(|a| a.to_string()).unwrap_or_default();
            return truncate_chars(&format!("{name} {args}").trim().to_string(), 300);
        }
        return truncate_chars(&v.to_string(), 300);
    }
    truncate_chars(raw.trim(), 300)
}

/// Classify a non-reply message as a progress step: (kind, title, detail, tool).
fn activity_step(msg: &Value) -> Option<(String, String, String, String)> {
    let role = msg.pointer("/author/role").and_then(|r| r.as_str()).unwrap_or("");
    let recipient = msg["recipient"].as_str().unwrap_or("all");
    let content_type = msg["content"]["content_type"].as_str().unwrap_or("text");
    let title = msg.pointer("/metadata/reasoning_title").and_then(|t| t.as_str()).unwrap_or("").to_string();
    if msg.pointer("/metadata/is_visually_hidden_from_conversation").and_then(|h| h.as_bool()) == Some(true) {
        return None;
    }

    if role == "assistant" && recipient != "all" {
        let title = if title.is_empty() { friendly_tool(recipient) } else { title };
        return Some(("tool_call".into(), title, tool_call_detail(msg), recipient.to_string()));
    }
    if role == "tool" {
        let tool = msg.pointer("/author/name").and_then(|n| n.as_str()).unwrap_or("").to_string();
        // The web search request itself streams empty; its queries arrive on a tool message.
        let queries: Vec<&str> = msg.pointer("/metadata/search_model_queries/queries")
            .and_then(|q| q.as_array())
            .map(|q| q.iter().filter_map(|x| x.as_str()).collect())
            .unwrap_or_default();
        if !queries.is_empty() {
            return Some(("tool_query".into(), title, truncate_chars(&queries.join("\n"), 400), tool));
        }
        let groups = msg.pointer("/metadata/search_result_groups").and_then(|g| g.as_array()).cloned().unwrap_or_default();
        let sources: usize = groups.iter().map(|g| g["entries"].as_array().map_or(0, |e| e.len())).sum();
        let detail = if sources > 0 {
            let mut domains: Vec<&str> = Vec::new();
            for d in groups.iter().filter_map(|g| g["domain"].as_str()) {
                if !domains.contains(&d) {
                    domains.push(d);
                }
            }
            let shown = domains.iter().take(8).copied().collect::<Vec<_>>().join(", ");
            let more = if domains.len() > 8 { format!(" +{}", domains.len() - 8) } else { String::new() };
            format!("{sources} sources: {shown}{more}")
        } else {
            let content = &msg["content"];
            let out = content["text"].as_str().map(str::to_string).unwrap_or_else(|| {
                content["parts"].as_array()
                    .map(|p| p.iter().filter_map(|x| x.as_str()).collect::<Vec<_>>().join(""))
                    .unwrap_or_default()
            });
            truncate_chars(out.trim(), 400)
        };
        return Some(("tool_result".into(), title, detail, tool));
    }
    if role == "assistant" && content_type == "thoughts" {
        let thoughts = msg["content"]["thoughts"].as_array().cloned().unwrap_or_default();
        let latest = thoughts.iter().rev()
            .filter_map(|x| x["summary"].as_str())
            .find(|s| !s.trim().is_empty())
            .unwrap_or("")
            .to_string();
        let detail: Vec<String> = thoughts.iter().flat_map(|x| {
            [x["summary"].as_str(), x["content"].as_str()].into_iter().flatten()
                .map(str::trim).filter(|s| !s.is_empty()).map(str::to_string).collect::<Vec<_>>()
        }).collect();
        return Some(("thought".into(), latest, truncate_chars(&detail.join("\n"), 1500), String::new()));
    }
    if role == "assistant" && content_type == "reasoning_recap" {
        let recap = msg["content"]["content"].as_str().map(str::to_string).or_else(|| {
            msg.pointer("/metadata/finished_duration_sec").and_then(|s| s.as_f64()).map(|s| format!("Thought for {}s", s.round() as u64))
        });
        return Some(("recap".into(), recap.unwrap_or_default(), String::new(), String::new()));
    }
    None
}

fn is_user_visible(msg: &Value) -> bool {
    msg.pointer("/author/role").and_then(|r| r.as_str()) == Some("assistant")
        && msg["recipient"].as_str().unwrap_or("all") == "all"
}

/// Turns SSE lines into deltas as they arrive. The server sends full message snapshots,
/// so each delta is the new suffix of that message's text.
#[derive(Default)]
struct SseParser {
    msg_texts: HashMap<String, String>,
    last_message_id: Option<String>,
    step_sigs: HashMap<String, String>,
    image_queries: std::collections::HashSet<String>,
}

impl SseParser {
    /// Events for one SSE line: at most one text/step event, plus any newly resolved images.
    fn feed(&mut self, line: &str, client: &mut ChatGptClient) -> Vec<StreamEvent> {
        let Some((msg_id, data)) = parse_sse_line(line) else { return Vec::new() };
        let mut out: Vec<StreamEvent> = self.feed_message(msg_id, &data, client).into_iter().collect();
        if is_user_visible(&data["message"]) {
            let fresh: Vec<GenImage> = genui_images(&data["message"])
                .into_iter()
                .filter(|img| self.image_queries.insert(img.query.clone()))
                .collect();
            if !fresh.is_empty() {
                out.push(StreamEvent::Images { images: fresh });
            }
        }
        out
    }

    fn feed_message(&mut self, msg_id: String, data: &Value, client: &mut ChatGptClient) -> Option<StreamEvent> {
        let msg = &data["message"];
        if let Some(conv_id) = data.get("conversation_id").and_then(|c| c.as_str()) {
            client.conversation_id = Some(conv_id.to_string());
        }
        // Tool calls, tool output and thinking are shown as progress steps, never as reply text.
        if let Some((kind, title, detail, tool)) = activity_step(msg) {
            let sources = search_sources(msg);
            let sig = format!("{kind}\u{1}{title}\u{1}{detail}\u{1}{tool}\u{1}{}", sources.len());
            if self.step_sigs.get(&msg_id) == Some(&sig) {
                return None;
            }
            self.step_sigs.insert(msg_id.clone(), sig);
            return Some(StreamEvent::Step { id: msg_id, kind, title, detail, tool, sources });
        }
        if !is_user_visible(msg) {
            return None;
        }
        let parts = msg["content"]["parts"]
            .as_array()
            .map(|arr| arr.iter().filter_map(|p| p.as_str()).collect::<Vec<_>>().join(""))
            .unwrap_or_default();

        let prev = self.msg_texts.get(&msg_id).map(String::as_str).unwrap_or("");
        if parts.len() <= prev.len() || !parts.starts_with(prev) {
            return None;
        }
        let delta = parts[prev.len()..].to_string();
        self.msg_texts.insert(msg_id.clone(), parts);
        self.last_message_id = Some(msg_id);
        if let Some(model) = msg.pointer("/metadata/model_slug").and_then(|m| m.as_str()) {
            client.actual_model = Some(model.to_string());
        }
        Some(StreamEvent::Text { delta })
    }

    fn finish(self, client: &mut ChatGptClient) -> Option<StreamEvent> {
        let mid = self.last_message_id?;
        client.parent_message_id = mid.clone();
        Some(StreamEvent::Done {
            conversation_id: client.conversation_id.clone().unwrap_or_default(),
            message_id: mid,
            model: client.actual_model.clone().unwrap_or_default(),
        })
    }
}

#[cfg(test)]
fn parse_sse_stream(text: &str, client: &mut ChatGptClient) -> Vec<StreamEvent> {
    let mut parser = SseParser::default();
    let mut events: Vec<StreamEvent> = text.lines().flat_map(|l| parser.feed(l, client)).collect();
    events.extend(parser.finish(client));
    events
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parse_sse_line_extracts_text() {
        let line = r#"data: {"message":{"id":"m1","author":{"role":"assistant"},"content":{"parts":["hello"],"content_type":"text"}},"conversation_id":"c1"}"#;
        let (id, _data) = parse_sse_line(line).unwrap();
        assert_eq!(id, "m1");
    }

    #[test]
    fn parse_sse_line_skips_malformed() {
        assert!(parse_sse_line("data: {invalid}").is_none());
        assert!(parse_sse_line("not a data line").is_none());
        assert!(parse_sse_line("data: [DONE]").is_none());
    }

    #[test]
    fn parse_sse_line_skips_system_role() {
        let line = r#"data: {"message":{"id":"m1","author":{"role":"system"},"content":{"parts":["hi"],"content_type":"text"}}}"#;
        assert!(parse_sse_line(line).is_none());
    }

    #[test]
    fn stream_hides_tool_messages() {
        let mut client = ChatGptClient::new("t".into());
        let sse = [
            r#"data: {"message":{"id":"t1","author":{"role":"tool"},"recipient":"all","content":{"content_type":"text","parts":["[L1] file dump"]}},"conversation_id":"c1"}"#,
            r#"data: {"message":{"id":"a0","author":{"role":"assistant"},"recipient":"file_search","content":{"content_type":"code","parts":["search('x')"]}},"conversation_id":"c1"}"#,
            r#"data: {"message":{"id":"a1","author":{"role":"assistant"},"recipient":"all","content":{"content_type":"text","parts":["PELICAN-42"]}},"conversation_id":"c1"}"#,
        ]
        .join("\n");
        let events = parse_sse_stream(&sse, &mut client);
        let text: String = events.iter().filter_map(|e| match e { StreamEvent::Text { delta } => Some(delta.as_str()), _ => None }).collect();
        assert_eq!(text, "PELICAN-42");
        assert_eq!(client.conversation_id.as_deref(), Some("c1"));
        assert_eq!(client.parent_message_id, "a1");
    }

    #[test]
    fn stream_reports_activity_steps() {
        let mut client = ChatGptClient::new("t".into());
        let sse = [
            r#"data: {"message":{"id":"a0","author":{"role":"assistant"},"recipient":"web.run","content":{"content_type":"code","text":"{\"search_query\":[{\"q\":\"ECU คืออะไร\"}]}"},"metadata":{}}}"#,
            r#"data: {"message":{"id":"a0","author":{"role":"assistant"},"recipient":"web.run","content":{"content_type":"code","text":"{\"search_query\":[{\"q\":\"ECU คืออะไร\"}]}"},"metadata":{}}}"#,
            r#"data: {"message":{"id":"tq","author":{"role":"tool","name":"web.run"},"recipient":"all","content":{"content_type":"text","parts":[""]},"metadata":{"reasoning_title":"Searching the web","search_model_queries":{"queries":["ECU types","ECU tuning"]}}}}"#,
            r#"data: {"message":{"id":"t0","author":{"role":"tool","name":"web.run"},"recipient":"all","content":{"content_type":"text","parts":[""]},"metadata":{"reasoning_title":"Searching 2 websites","search_result_groups":[{"domain":"bosch.com","entries":[{},{}]},{"domain":"wikipedia.org","entries":[{}]},{"domain":"bosch.com","entries":[]}]}}}"#,
            r#"data: {"message":{"id":"th","author":{"role":"assistant"},"recipient":"all","content":{"content_type":"thoughts","thoughts":[{"summary":"Comparing ECU types","content":"Engine vs transmission units"}]}}}"#,
            r#"data: {"message":{"id":"rc","author":{"role":"assistant"},"recipient":"all","content":{"content_type":"reasoning_recap","content":"Thought for 9s"}}}"#,
            r#"data: {"message":{"id":"hd","author":{"role":"assistant"},"recipient":"bio","content":{"content_type":"text","parts":["x"]},"metadata":{"is_visually_hidden_from_conversation":true}}}"#,
            r#"data: {"message":{"id":"a1","author":{"role":"assistant"},"recipient":"all","content":{"content_type":"text","parts":["ECU คือ"]}}}"#,
        ]
        .join("\n");
        let events = parse_sse_stream(&sse, &mut client);
        let steps: Vec<(String, String, String, String)> = events.iter().filter_map(|e| match e {
            StreamEvent::Step { kind, title, detail, tool, .. } => Some((kind.clone(), title.clone(), detail.clone(), tool.clone())),
            _ => None,
        }).collect();
        assert_eq!(steps, vec![
            ("tool_call".into(), "Searching the web".into(), "ECU คืออะไร".into(), "web.run".into()),
            ("tool_query".into(), "Searching the web".into(), "ECU types\nECU tuning".into(), "web.run".into()),
            ("tool_result".into(), "Searching 2 websites".into(), "3 sources: bosch.com, wikipedia.org".into(), "web.run".into()),
            ("thought".into(), "Comparing ECU types".into(), "Comparing ECU types\nEngine vs transmission units".into(), String::new()),
            ("recap".into(), "Thought for 9s".into(), String::new(), String::new()),
        ]);
        let text: String = events.iter().filter_map(|e| match e { StreamEvent::Text { delta } => Some(delta.as_str()), _ => None }).collect();
        assert_eq!(text, "ECU คือ");
    }

    #[test]
    fn genui_images_match_queries() {
        let msg: Value = serde_json::from_str(r#"{"metadata":{"model_dil_v2":{"appData":{"opGenui":{"componentResults":{
            "a":{"status":"resolved","state":{"images":[{"image_search_query":"X logo","content_url":"https://images.openai.com/c1","thumbnail_url":"https://images.openai.com/t1","url":"https://www.x.com/i/1?ref=a","title":"X","show_url":true}]}},
            "b":{"status":"pending","state":{"images":[{"image_search_query":"pending one","content_url":"https://images.openai.com/c2"}]}},
            "c":{"status":"resolved","state":{"images":[{"image_search_query":"bad","content_url":"javascript:alert(1)"}]}}
        }}}}}}"#).unwrap();
        let images = genui_images(&msg);
        assert_eq!(images.len(), 1, "only resolved images with http urls");
        assert_eq!(images[0].query, "X logo");
        assert_eq!(images[0].url, "https://images.openai.com/c1");
        assert_eq!(images[0].source_host, "x.com");
        assert!(images[0].show_url);
    }

    #[test]
    fn search_sources_use_cite_ids() {
        let msg: Value = serde_json::from_str(r#"{"metadata":{"search_result_groups":[
            {"domain":"x.com","entries":[
                {"url":"https://help.x.com/a","title":"Help","attribution":"x.com","ref_id":{"turn_index":640725,"ref_type":"search","ref_index":12}},
                {"url":"javascript:alert(1)","title":"bad","ref_id":{"turn_index":640725,"ref_type":"search","ref_index":13}},
                {"url":"https://y.org/b","title":"","ref_id":{"turn_index":640725,"ref_type":"search","ref_index":5}}
            ]}]}}"#).unwrap();
        let sources = search_sources(&msg);
        assert_eq!(sources.len(), 2, "non-http urls are dropped");
        assert_eq!(sources[0].id, "turn640725search12");
        assert_eq!(sources[0].attribution, "x.com");
        assert_eq!(sources[1].id, "turn640725search5");
        assert_eq!(sources[1].attribution, "x.com", "falls back to the group domain");
    }

    #[test]
    fn stream_deltas_thai_and_rewrites() {
        let mut client = ChatGptClient::new("t".into());
        let line = |text: &str| {
            format!(r#"data: {{"message":{{"id":"a","author":{{"role":"assistant"}},"recipient":"all","content":{{"content_type":"text","parts":["{text}"]}}}}}}"#)
        };
        let mut parser = SseParser::default();
        let delta = |evs: Vec<StreamEvent>| evs.into_iter().find_map(|e| match e { StreamEvent::Text { delta } => Some(delta), _ => None });
        assert_eq!(delta(parser.feed(&line("ab"), &mut client)).as_deref(), Some("ab"));
        // Not a prefix of the previous text: slicing at the old byte length would split a Thai char.
        assert_eq!(delta(parser.feed(&line("สวัสดีครับ"), &mut client)), None);
        assert_eq!(delta(parser.feed(&line("abสวัส"), &mut client)).as_deref(), Some("สวัส"));
        assert_eq!(delta(parser.feed(&line("abสวัสดี"), &mut client)).as_deref(), Some("ดี"));
    }

    fn image_file() -> UploadedFile {
        UploadedFile { id: "file_abc".into(), name: "a.png".into(), mime_type: "image/png".into(), size: 10, width: Some(2), height: Some(3), is_image: true }
    }

    fn pdf_file() -> UploadedFile {
        UploadedFile { id: "file-xyz".into(), name: "r.pdf".into(), mime_type: "application/pdf".into(), size: 20, width: None, height: None, is_image: false }
    }

    #[test]
    fn message_content_plain_text() {
        let (content, meta) = message_content("hi", &[]);
        assert_eq!(content["content_type"], "text");
        assert_eq!(content["parts"][0], "hi");
        assert_eq!(meta, json!({}));
    }

    #[test]
    fn message_content_image_is_multimodal() {
        let (content, meta) = message_content("look", &[image_file()]);
        assert_eq!(content["content_type"], "multimodal_text");
        assert_eq!(content["parts"][0]["content_type"], "image_asset_pointer");
        assert_eq!(content["parts"][0]["asset_pointer"], "sediment://file_abc");
        assert_eq!(content["parts"][0]["width"], 2);
        assert_eq!(content["parts"][1], "look");
        assert_eq!(meta["attachments"][0]["id"], "file_abc");
        assert_eq!(meta["attachments"][0]["height"], 3);
    }

    #[test]
    fn message_content_document_stays_text() {
        let (content, meta) = message_content("read this", &[pdf_file()]);
        assert_eq!(content["content_type"], "text");
        assert_eq!(meta["attachments"][0]["mime_type"], "application/pdf");
        assert!(meta["attachments"][0].get("width").is_none());
        assert_eq!(asset_pointer("file-xyz"), "file-service://file-xyz");
    }

    #[test]
    fn processing_events_parse() {
        assert_eq!(parse_processing_event(r#"{"event":"file.processing.completed","file_id":"x"}"#), ProcessingEvent::Completed);
        assert_eq!(parse_processing_event(r#"data: {"event":"file.processing.completed"}"#), ProcessingEvent::Completed);
        assert_eq!(
            parse_processing_event(r#"{"event":"file.processing.error","extra":{"error_code":"file_too_large"}}"#),
            ProcessingEvent::Failed("file_too_large".into())
        );
        assert_eq!(parse_processing_event(r#"{"event":"file.processing.progress","progress":40}"#), ProcessingEvent::Other);
        assert_eq!(parse_processing_event("not json"), ProcessingEvent::Other);
    }

    #[test]
    fn mime_detection() {
        assert_eq!(mime_for("Shot.PNG"), "image/png");
        assert_eq!(mime_for("report.pdf"), "application/pdf");
        assert_eq!(mime_for("noext"), "application/octet-stream");
    }

    /// Hits chatgpt.com with the saved token: uploads a 5x5 red PNG and asks about it in a
    /// temporary chat. Run with `cargo test live_upload -- --ignored --nocapture`.
    #[tokio::test]
    #[ignore]
    async fn live_upload_and_ask() {
        use base64::Engine;
        let token = crate::auth::load_token().expect("saved token");
        let mut client = ChatGptClient::new(token);
        client.temp_chat = true;
        let png = base64::engine::general_purpose::STANDARD
            .decode("iVBORw0KGgoAAAANSUhEUgAAAAUAAAAFCAYAAACNbyblAAAAHElEQVQI12P4//8/w38GIAXDIBKE0DHxgljNBAAO9TXL0Y4OHwAAAABJRU5ErkJggg==")
            .unwrap();
        let file = client.upload_file("red.png", png).await.expect("upload");
        println!("uploaded: {file:?}");
        assert!(file.is_image);
        let events = client
            .send_message("What single color fills this image? Answer with one word.", &[file])
            .await
            .expect("send");
        let reply: String = events.iter().filter_map(|e| match e { StreamEvent::Text { delta } => Some(delta.as_str()), _ => None }).collect();
        println!("reply: {reply}");
        assert!(!reply.is_empty());
    }

    /// Checks deltas arrive incrementally (temporary chat).
    /// Run with `cargo test live_streaming -- --ignored --nocapture`.
    #[tokio::test]
    #[ignore]
    async fn live_streaming() {
        let token = crate::auth::load_token().expect("saved token");
        let mut client = ChatGptClient::new(token);
        client.temp_chat = true;
        let start = std::time::Instant::now();
        let mut arrivals = Vec::new();
        client
            .send_message_streaming("Count from 1 to 30, one number per line, nothing else.", &[], |ev| {
                if let StreamEvent::Text { delta } = ev {
                    arrivals.push((start.elapsed().as_millis(), delta.len()));
                }
            })
            .await
            .expect("send");
        println!("text deltas: {}", arrivals.len());
        println!("first at {} ms, last at {} ms", arrivals.first().unwrap().0, arrivals.last().unwrap().0);
        assert!(arrivals.len() > 3, "expected several deltas, got {}", arrivals.len());
    }

    /// A question that needs a web search should report activity steps before the answer.
    /// Run with `cargo test live_steps -- --ignored --nocapture`.
    #[tokio::test]
    #[ignore]
    async fn live_steps() {
        let token = crate::auth::load_token().expect("saved token");
        let mut client = ChatGptClient::new(token);
        client.temp_chat = true;
        let mut steps = Vec::new();
        let mut text_len = 0;
        client
            .send_message_streaming("Search the web: what is today's top headline on bbc.com? One sentence.", &[], |ev| match ev {
                StreamEvent::Step { kind, title, detail, tool, .. } => {
                    println!("STEP {kind} | {title} | {} | {tool}", detail.chars().take(80).collect::<String>());
                    steps.push(kind.clone());
                }
                StreamEvent::Text { delta } => text_len += delta.len(),
                _ => {}
            })
            .await
            .expect("send");
        println!("steps: {}, reply bytes: {text_len}", steps.len());
        assert!(steps.iter().any(|k| k == "tool_call"), "expected a tool call step, got {steps:?}");
        assert!(text_len > 0);
    }

    /// Like live_upload_and_ask, but for a document (my_files + retrieval indexing).
    #[tokio::test]
    #[ignore]
    async fn live_upload_document() {
        let token = crate::auth::load_token().expect("saved token");
        let mut client = ChatGptClient::new(token);
        client.temp_chat = true;
        let doc = b"Project notes.\nThe code word for this test is PELICAN-42.\n".to_vec();
        let file = client.upload_file("notes.txt", doc).await.expect("upload");
        println!("uploaded: {file:?}");
        assert!(!file.is_image);
        let events = client
            .send_message("What is the code word in the attached file? Reply with only the code word.", &[file])
            .await
            .expect("send");
        let reply: String = events.iter().filter_map(|e| match e { StreamEvent::Text { delta } => Some(delta.as_str()), _ => None }).collect();
        println!("reply: {reply}");
        assert!(reply.contains("PELICAN"));
    }
}
