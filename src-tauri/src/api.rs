use crate::api_helpers::{self, BASE_URL};
use crate::pow;
use crate::types::*;
use reqwest::Client;
use serde::Serialize;
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
    /// Tools/apps picked with "@" in the composer for the next message, as chatgpt.com sends
    /// them: "search", "picture_v2", "plugin:<app id>", ...
    pub system_hints: Vec<String>,
    /// chatgpt.com's effort slider: None (Instant), "standard" (Medium), "extended" (High).
    pub thinking_effort: Option<String>,
    /// Set to true (via the paired sender) to stop reading the reply; what arrived is kept.
    pub cancel: Option<tokio::sync::watch::Receiver<bool>>,
    /// When set, a message starts or continues a chat inside this project (gizmo "g-p-…").
    pub gizmo_id: Option<String>,
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
            system_hints: Vec::new(),
            thinking_effort: None,
            cancel: None,
            gizmo_id: None,
        }
    }

    /// Tell the server to stop generating, as chatgpt.com's Stop button does
    /// (POST /backend-api/stop_conversation, checked on the web).
    pub async fn stop_conversation(&self, conversation_id: &str) -> Result<(), String> {
        let url = format!("{BASE_URL}/backend-api/stop_conversation");
        let resp = self
            .client
            .post(&url)
            .headers(self.headers())
            .json(&json!({ "conversation_id": conversation_id, "exclude_async_types": [] }))
            .send()
            .await
            .map_err(|e| format!("Stop failed: {e}"))?;
        if !resp.status().is_success() {
            return Err(format!("Stop failed (HTTP {}).", resp.status()));
        }
        Ok(())
    }

    /// Whether a reply is still being written in this chat, possibly by another client such as
    /// chatgpt.com (GET /backend-api/conversation/{id}/stream_status, checked on the web:
    /// "IS_STREAMING" while it runs, "COMPLETE" after).
    pub async fn stream_status(&self, conversation_id: &str) -> Result<String, String> {
        let url = format!("{BASE_URL}/backend-api/conversation/{conversation_id}/stream_status");
        let resp = self
            .client
            .get(&url)
            .headers(self.headers())
            .send()
            .await
            .map_err(|e| format!("Stream status failed: {e}"))?;
        if !resp.status().is_success() {
            return Err(format!("Stream status failed (HTTP {}).", resp.status()));
        }
        let data: Value = resp.json().await.map_err(|e| format!("Invalid response: {e}"))?;
        Ok(parse_stream_status(&data))
    }

    /// Which conversation the next message continues, as the UI says (None = a new chat).
    /// Each send carries its own target, so switching chats mid-reply can't redirect it.
    pub fn set_thread(&mut self, conversation_id: Option<String>, parent_message_id: Option<String>) {
        let id_ok = |s: &String| !s.is_empty() && s.len() <= 100 && s.chars().all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_');
        self.conversation_id = conversation_id.filter(id_ok);
        self.parent_message_id = match (&self.conversation_id, parent_message_id.filter(id_ok)) {
            (Some(_), Some(parent)) => parent,
            _ => Uuid::new_v4().to_string(),
        };
    }

    /// Model and effort as the composer's picker chose them; ignores values that aren't
    /// plain slugs so nothing odd reaches the request.
    pub fn set_model_choice(&mut self, model: Option<String>, effort: Option<String>) {
        let slug_ok = |s: &str| !s.is_empty() && s.len() <= 64 && s.chars().all(|c| c.is_ascii_alphanumeric() || "-_.".contains(c));
        if let Some(m) = model.filter(|m| slug_ok(m)) {
            self.model = m;
        }
        self.thinking_effort = effort.filter(|e| slug_ok(e));
    }

    /// The project (gizmo) a send belongs to, if any; ignores anything that isn't a plain id so
    /// nothing odd reaches the request body.
    pub fn set_gizmo(&mut self, gizmo_id: Option<String>) {
        self.gizmo_id = gizmo_id.filter(|g| {
            !g.is_empty() && g.len() <= 100 && g.chars().all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_')
        });
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
        on_event: F,
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

        // A message inside a project (gizmo "g-p-…"): chatgpt.com sends gizmo_interaction mode
        // plus a top-level gizmo_id so the chat lands in that project.
        if let Some(gid) = &self.gizmo_id {
            body["conversation_mode"] = json!({ "kind": "gizmo_interaction", "gizmo_id": gid });
            body["gizmo_id"] = json!(gid);
        }

        apply_system_hints(&mut body, &self.system_hints, self.reasoning_effort.as_deref());
        if let Some(effort) = &self.thinking_effort {
            body["thinking_effort"] = json!(effort);
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

        let raw_log = last_stream_path().and_then(|p| {
            std::fs::create_dir_all(p.parent()?).ok()?;
            std::fs::File::create(p).ok()
        });
        self.read_reply(&mut resp, raw_log, on_event).await
    }

    /// Read a reply's SSE stream into events (calling `on_event` as each arrives) until it ends
    /// or `self.cancel` flips (Stop), which works even while the server is silent (thinking).
    /// Text that already arrived is kept either way.
    async fn read_reply<F: FnMut(&StreamEvent)>(
        &mut self,
        resp: &mut reqwest::Response,
        mut raw_log: Option<std::fs::File>,
        mut on_event: F,
    ) -> Result<Vec<StreamEvent>, String> {
        let mut parser = SseParser::default();
        let mut events = Vec::new();
        // Bytes, not String: a chunk boundary can split a multi-byte (e.g. Thai) character.
        let mut pending: Vec<u8> = Vec::new();
        let mut cancel = self.cancel.take();
        loop {
            if cancel.as_ref().is_some_and(|rx| *rx.borrow()) {
                break;
            }
            let next = match cancel.as_mut() {
                Some(rx) => tokio::select! {
                    chunk = resp.chunk() => chunk,
                    _ = rx.changed() => continue,
                },
                None => resp.chunk().await,
            };
            let Some(chunk) = next.map_err(|e| format!("Stream read error: {e}"))? else { break };
            pending.extend_from_slice(&chunk);
            while let Some(nl) = pending.iter().position(|&b| b == b'\n') {
                let line: Vec<u8> = pending.drain(..=nl).collect();
                let line = String::from_utf8_lossy(&line);
                if let Some(f) = raw_log.as_mut() {
                    use std::io::Write;
                    let _ = f.write_all(redact_stream_line(&line).as_bytes());
                }
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
        self.cancel = cancel;
        Ok(events)
    }

    /// List chats. With `archived` true, lists archived chats instead of the normal recents.
    pub async fn list_conversations(
        &self,
        offset: u32,
        limit: u32,
        archived: bool,
    ) -> Result<ConversationList, String> {
        let mut url = format!(
            "{BASE_URL}/backend-api/conversations?offset={offset}&limit={limit}&order=updated"
        );
        if archived {
            url.push_str("&is_archived=true");
        }
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
        let items = conversation_items(&data);
        let total = data["total"].as_u64().unwrap_or(0) as u32;

        Ok(ConversationList {
            has_more: offset + limit < total,
            items,
            total,
        })
    }

    /// Signed, cookie-free URL for a file in the account (e.g. an image ChatGPT created).
    pub async fn file_download_url(&self, file_id: &str) -> Result<String, String> {
        if file_id.is_empty() || file_id.len() > 100 || !file_id.chars().all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '-') {
            return Err("Bad file id.".into());
        }
        let url = format!("{BASE_URL}/backend-api/files/download/{file_id}?inline=false");
        let resp = self
            .client
            .get(&url)
            .headers(self.headers())
            .send()
            .await
            .map_err(|e| format!("Image link failed: {e}"))?;
        if !resp.status().is_success() {
            return Err(format!("Image link failed (HTTP {}).", resp.status()));
        }
        let data: Value = resp.json().await.map_err(|e| format!("Invalid response: {e}"))?;
        let link = data["download_url"].as_str().unwrap_or("");
        if !is_chatgpt_file_url(link) {
            return Err("Unexpected image link.".into());
        }
        Ok(link.to_string())
    }

    /// Bytes of a file in the account (e.g. a generated image). The signed link still needs the
    /// account's authorization (403 "File stream access denied" without it), so the webview
    /// can't load it directly; this fetches it with the session headers.
    pub async fn fetch_image_file(&self, file_id: &str) -> Result<(Vec<u8>, String), String> {
        const MAX: usize = 50 * 1024 * 1024;
        let link = self.file_download_url(file_id).await?;
        let resp = self
            .client
            .get(&link)
            .headers(self.headers())
            .send()
            .await
            .map_err(|e| format!("Image download failed: {e}"))?;
        if !resp.status().is_success() {
            return Err(format!("Image download failed (HTTP {}).", resp.status()));
        }
        let ctype = resp
            .headers()
            .get(reqwest::header::CONTENT_TYPE)
            .and_then(|v| v.to_str().ok())
            .unwrap_or("")
            .split(';')
            .next()
            .unwrap_or("")
            .trim()
            .to_string();
        if !is_supported_image(&ctype) {
            return Err(format!("Not an image ({ctype})."));
        }
        let bytes = resp.bytes().await.map_err(|e| format!("Image download failed: {e}"))?;
        if bytes.len() > MAX {
            return Err("Image is larger than 50 MB.".into());
        }
        Ok((bytes.to_vec(), ctype))
    }

    /// Start a voice-mode call: send the WebRTC offer and session settings to
    /// /realtime/wm (as chatgpt.com does, checked live) and return the server's SDP answer.
    /// Media then flows directly between the webview and OpenAI.
    pub async fn voice_connect(&self, offer_sdp: &str, settings: &VoiceSettings) -> Result<String, String> {
        if !offer_sdp.starts_with("v=0") || offer_sdp.len() > 64 * 1024 {
            return Err("Bad voice offer.".into());
        }
        let session_id = Uuid::new_v4().to_string();
        let session = voice_session_json(settings, &session_id);
        let form = reqwest::multipart::Form::new()
            .text("sdp", offer_sdp.to_string())
            .text("session", session.to_string());
        // The shared headers carry Content-Type: application/json; with it the server sees two
        // content types and answers 400. Let the multipart body set its own.
        let mut headers = self.headers();
        headers.remove(reqwest::header::CONTENT_TYPE);
        let resp = self
            .client
            .post(format!("{BASE_URL}/realtime/wm?dcid=0"))
            .headers(headers)
            .multipart(form)
            .send()
            .await
            .map_err(|e| format!("Voice connect failed: {e}"))?;
        let status = resp.status();
        let body = resp.text().await.unwrap_or_default();
        if !status.is_success() {
            return Err(format!("Voice connect failed (HTTP {status}): {}", truncate_chars(&body, 200)));
        }
        if !body.starts_with("v=0") {
            return Err(format!("Voice connect: unexpected reply (HTTP {status})."));
        }
        Ok(body)
    }

    /// Models for the composer's picker (same source chatgpt.com uses).
    pub async fn list_models(&self) -> Result<ModelList, String> {
        let url = format!("{BASE_URL}/backend-api/models?history_and_training_disabled=false");
        let resp = self
            .client
            .get(&url)
            .headers(self.headers())
            .send()
            .await
            .map_err(|e| format!("Loading models failed: {e}"))?;
        if !resp.status().is_success() {
            return Err(format!("Loading models failed (HTTP {}).", resp.status()));
        }
        let data: Value = resp.json().await.map_err(|e| format!("Invalid response: {e}"))?;
        Ok(parse_models(&data))
    }

    /// Entries for the composer's "@" menu (same source chatgpt.com uses).
    pub async fn list_system_hints(&self) -> Result<Vec<SystemHint>, String> {
        let url = format!("{BASE_URL}/backend-api/system_hints?mode=all&exclude_logo=false&suggestions=true");
        let resp = self
            .client
            .get(&url)
            .headers(self.headers())
            .send()
            .await
            .map_err(|e| format!("Loading tools failed: {e}"))?;
        if !resp.status().is_success() {
            return Err(format!("Loading tools failed (HTTP {}).", resp.status()));
        }
        let data: Value = resp.json().await.map_err(|e| format!("Invalid response: {e}"))?;
        Ok(parse_system_hints(&data))
    }

    /// Voices for voice mode, as on chatgpt.com Settings › Voice
    /// (GET /backend-api/settings/voices → {selected, voices:[{voice, name, description, …}]}).
    pub async fn list_voices(&self, locale: &str) -> Result<VoiceList, String> {
        let lang: String = locale.chars().filter(|c| c.is_ascii_alphanumeric() || *c == '-').take(20).collect();
        let lang = if lang.is_empty() { "en-US".to_string() } else { lang };
        let url = format!("{BASE_URL}/backend-api/settings/voices?spoken_language={lang}&voice_mode=wingman");
        let resp = self
            .client
            .get(&url)
            .headers(self.headers())
            .send()
            .await
            .map_err(|e| format!("Loading voices failed: {e}"))?;
        if !resp.status().is_success() {
            return Err(format!("Loading voices failed (HTTP {}).", resp.status()));
        }
        let data: Value = resp.json().await.map_err(|e| format!("Invalid response: {e}"))?;
        Ok(parse_voices(&data))
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
            // Images the image tool made, for the (often text-less) reply that follows them.
            let mut pending_generated: Vec<GeneratedImage> = Vec::new();
            // Thinking, app calls and code runs since the last reply text, for the reply after them.
            let mut pending_activity = ReplyActivity::default();
            // Images or activity with no reply text after them (e.g. a stopped reply, or one
            // still being written elsewhere) still show, as a text-less reply.
            let flush_pending = |messages: &mut Vec<Message>, generated: &mut Vec<GeneratedImage>, activity: &mut ReplyActivity, id: &str| {
                if !generated.is_empty() || !activity.is_empty() {
                    let act = std::mem::take(activity);
                    messages.push(Message {
                        id: id.to_string(),
                        role: "assistant".into(),
                        generated: std::mem::take(generated),
                        recap: act.recap,
                        steps: act.steps,
                        runs: act.runs,
                        ..Default::default()
                    });
                }
            };
            for nid in &chain {
                if let Some(node) = map.get(nid.as_str()) {
                    let msg = &node["message"];
                    let role = msg["author"]["role"].as_str().unwrap_or("");
                    for s in search_sources(msg) {
                        if !turn_sources.iter().any(|t| t.id == s.id) {
                            turn_sources.push(s);
                        }
                    }
                    pending_generated.extend(generated_images(msg));
                    if role == "user" {
                        turn_sources.clear();
                        flush_pending(&mut messages, &mut pending_generated, &mut pending_activity, &format!("{nid}-pending"));
                    } else {
                        collect_activity(msg, &mut pending_activity);
                    }
                    if role != "user" && !is_user_visible(msg) {
                        continue;
                    }
                    let parts = message_text(msg);
                    let attachments: Vec<AttachmentInfo> = msg["metadata"]["attachments"]
                        .as_array()
                        .map(|arr| {
                            arr.iter()
                                .map(|a| AttachmentInfo {
                                    name: a["name"].as_str().unwrap_or("file").to_string(),
                                    mime_type: a["mime_type"].as_str().unwrap_or("").to_string(),
                                    id: a["id"].as_str().unwrap_or("").to_string(),
                                })
                                .collect()
                        })
                        .unwrap_or_default();
                    let generated = if role == "assistant" { std::mem::take(&mut pending_generated) } else { Vec::new() };
                    // Thought and recap messages have no text: their activity waits for the reply.
                    if !parts.is_empty() || !attachments.is_empty() || !generated.is_empty() {
                        let act = if role == "assistant" { std::mem::take(&mut pending_activity) } else { ReplyActivity::default() };
                        messages.push(Message {
                            id: msg["id"].as_str().unwrap_or("").to_string(),
                            role: role.to_string(),
                            content: parts,
                            attachments,
                            sources: if role == "assistant" { turn_sources.clone() } else { Vec::new() },
                            images: if role == "assistant" { genui_images(msg) } else { Vec::new() },
                            generated,
                            recap: act.recap,
                            steps: act.steps,
                            runs: act.runs,
                        });
                    }
                }
            }
            flush_pending(&mut messages, &mut pending_generated, &mut pending_activity, "trailing-pending");
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

    // ---- Projects (gizmo "snorlax", id g-p-…) — verified live, see types::Project ----

    /// The sidebar's Projects list (GET /backend-api/gizmos/snorlax/sidebar).
    pub async fn list_projects(&self) -> Result<ProjectList, String> {
        let url = format!("{BASE_URL}/backend-api/gizmos/snorlax/sidebar");
        let resp = self.client.get(&url).headers(self.headers()).send().await
            .map_err(|e| format!("List projects failed: {e}"))?;
        if resp.status().as_u16() == 401 {
            return Err("Authentication failed (401).".into());
        }
        if !resp.status().is_success() {
            return Err(format!("List projects failed (HTTP {}).", resp.status()));
        }
        let data: Value = resp.json().await.map_err(|e| format!("Invalid response: {e}"))?;
        let items = data["items"].as_array()
            .map(|arr| arr.iter().map(|it| project_from_gizmo(giz_of(it))).collect())
            .unwrap_or_default();
        Ok(ProjectList { items })
    }

    /// Create a project (POST /backend-api/projects). Both fields are required by the server.
    pub async fn create_project(&self, name: &str, instructions: &str) -> Result<Project, String> {
        let url = format!("{BASE_URL}/backend-api/projects");
        let resp = self.client.post(&url).headers(self.headers())
            .json(&json!({ "name": name, "instructions": instructions }))
            .send().await.map_err(|e| format!("Create project failed: {e}"))?;
        if !resp.status().is_success() {
            return Err(format!("Create project failed (HTTP {}).", resp.status()));
        }
        let data: Value = resp.json().await.map_err(|e| format!("Invalid response: {e}"))?;
        Ok(project_from_gizmo(giz_of(&data)))
    }

    /// One project's detail (GET /backend-api/gizmos/{id}).
    pub async fn get_project(&self, id: &str) -> Result<Project, String> {
        let id = project_id_ok(id)?;
        let url = format!("{BASE_URL}/backend-api/gizmos/{id}?include_file_limits=true");
        let resp = self.client.get(&url).headers(self.headers()).send().await
            .map_err(|e| format!("Get project failed: {e}"))?;
        if !resp.status().is_success() {
            return Err(format!("Get project failed (HTTP {}).", resp.status()));
        }
        let data: Value = resp.json().await.map_err(|e| format!("Invalid response: {e}"))?;
        Ok(project_from_gizmo(giz_of(&data)))
    }

    /// The project's current display.emoji and display.theme, so an update can preserve them
    /// (the PATCH replaces the whole display block). Falls back to null if the read fails.
    async fn project_display(&self, id: &str) -> (Value, Value) {
        let url = format!("{BASE_URL}/backend-api/gizmos/{id}?include_file_limits=true");
        match self.client.get(&url).headers(self.headers()).send().await {
            Ok(r) => match r.json::<Value>().await {
                Ok(v) => {
                    let d = &giz_of(&v)["display"];
                    (d["emoji"].clone(), d["theme"].clone())
                }
                Err(_) => (Value::Null, Value::Null),
            },
            Err(_) => (Value::Null, Value::Null),
        }
    }

    /// Rename / edit a project (PATCH /backend-api/projects/{id}). The server requires the full
    /// {name, instructions, emoji, theme} set and replaces that block, so emoji and theme (which
    /// can only be set on chatgpt.com) are read first and echoed back rather than nulled.
    pub async fn update_project(&self, id: &str, name: &str, instructions: &str, memory_scope: Option<&str>) -> Result<Project, String> {
        let id = project_id_ok(id)?;
        let (emoji, theme) = self.project_display(id).await;
        let url = format!("{BASE_URL}/backend-api/projects/{id}");
        let mut body = json!({ "name": name, "instructions": instructions, "emoji": emoji, "theme": theme });
        // Only "global" or "project_v2" are accepted by the server.
        if let Some(ms) = memory_scope.filter(|m| *m == "global" || *m == "project_v2") {
            body["memory_scope"] = json!(ms);
        }
        let resp = self.client.patch(&url).headers(self.headers())
            .json(&body)
            .send().await.map_err(|e| format!("Update project failed: {e}"))?;
        if !resp.status().is_success() {
            return Err(format!("Update project failed (HTTP {}).", resp.status()));
        }
        let data: Value = resp.json().await.map_err(|e| format!("Invalid response: {e}"))?;
        Ok(project_from_gizmo(giz_of(&data)))
    }

    /// Delete a project (DELETE /backend-api/gizmos/{id}).
    pub async fn delete_project(&self, id: &str) -> Result<(), String> {
        let id = project_id_ok(id)?;
        let url = format!("{BASE_URL}/backend-api/gizmos/{id}");
        let resp = self.client.delete(&url).headers(self.headers()).send().await
            .map_err(|e| format!("Delete project failed: {e}"))?;
        if !resp.status().is_success() {
            return Err(format!("Delete project failed (HTTP {}).", resp.status()));
        }
        Ok(())
    }

    /// Chats inside a project (GET /backend-api/gizmos/{id}/conversations). Same item shape
    /// as the normal conversation list.
    pub async fn list_project_conversations(&self, id: &str, limit: u32) -> Result<Vec<ConversationSummary>, String> {
        let id = project_id_ok(id)?;
        let url = format!("{BASE_URL}/backend-api/gizmos/{id}/conversations?limit={limit}&owned_only=false");
        let resp = self.client.get(&url).headers(self.headers()).send().await
            .map_err(|e| format!("List project chats failed: {e}"))?;
        if !resp.status().is_success() {
            return Err(format!("List project chats failed (HTTP {}).", resp.status()));
        }
        let data: Value = resp.json().await.map_err(|e| format!("Invalid response: {e}"))?;
        Ok(conversation_items(&data))
    }

    /// Move a chat into a project (gizmo_id = Some) or back to the chat list (gizmo_id = None):
    /// PATCH /backend-api/conversation/{id} with the gizmo_id, as chatgpt.com does.
    pub async fn move_chat_to_project(&self, conversation_id: &str, gizmo_id: Option<&str>) -> Result<(), String> {
        if conversation_id.is_empty() || conversation_id.len() > 100
            || !conversation_id.chars().all(|c| c.is_ascii_alphanumeric() || c == '-') {
            return Err("Bad conversation id.".into());
        }
        let url = format!("{BASE_URL}/backend-api/conversation/{conversation_id}");
        // chatgpt.com clears a chat's project with an empty string, not null.
        let gid = match gizmo_id {
            Some(g) => json!(project_id_ok(g)?),
            None => json!(""),
        };
        let resp = self.client.patch(&url).headers(self.headers())
            .json(&json!({ "gizmo_id": gid }))
            .send().await.map_err(|e| format!("Move chat failed: {e}"))?;
        if !resp.status().is_success() {
            return Err(format!("Move chat failed (HTTP {}).", resp.status()));
        }
        Ok(())
    }

    /// Rename a chat (PATCH /conversation/{id} {title}).
    pub async fn rename_conversation(&self, id: &str, title: &str) -> Result<(), String> {
        self.patch_conversation(id, json!({ "title": title }), "Rename").await
    }

    /// Archive or unarchive a chat.
    pub async fn archive_conversation(&self, id: &str, archived: bool) -> Result<(), String> {
        self.patch_conversation(id, json!({ "is_archived": archived }), "Archive").await
    }

    /// Pin or unpin a chat. ChatGPT stores pinned state as `is_starred`.
    pub async fn pin_conversation(&self, id: &str, pinned: bool) -> Result<(), String> {
        self.patch_conversation(id, json!({ "is_starred": pinned }), "Pin").await
    }

    async fn patch_conversation(&self, id: &str, body: Value, what: &str) -> Result<(), String> {
        if id.is_empty() || id.len() > 100 || !id.chars().all(|c| c.is_ascii_alphanumeric() || c == '-') {
            return Err("Bad conversation id.".into());
        }
        let url = format!("{BASE_URL}/backend-api/conversation/{id}");
        let resp = self.client.patch(&url).headers(self.headers()).json(&body)
            .send().await.map_err(|e| format!("{what} failed: {e}"))?;
        if !resp.status().is_success() {
            return Err(format!("{what} failed (HTTP {}).", resp.status()));
        }
        Ok(())
    }

    /// Create a public share link for a chat (POST /share/create); returns the share URL.
    pub async fn share_conversation(&self, id: &str) -> Result<String, String> {
        let conv = self.get_conversation(id).await?;
        let url = format!("{BASE_URL}/backend-api/share/create");
        let resp = self.client.post(&url).headers(self.headers())
            .json(&json!({ "conversation_id": id, "current_node_id": conv.current_node, "is_anonymous": true }))
            .send().await.map_err(|e| format!("Share failed: {e}"))?;
        if !resp.status().is_success() {
            return Err(format!("Share failed (HTTP {}).", resp.status()));
        }
        let data: Value = resp.json().await.map_err(|e| format!("Invalid response: {e}"))?;
        let share_url = data["share_url"].as_str().unwrap_or("");
        if !share_url.starts_with("https://chatgpt.com/share/") {
            return Err("Unexpected share URL.".into());
        }
        Ok(share_url.to_string())
    }
}

/// A project's gizmo object is wrapped differently per endpoint: bare, under "gizmo", or under
/// "resource.gizmo". Dig out the gizmo object itself.
fn giz_of(v: &Value) -> &Value {
    if v.get("gizmo").is_some() {
        &v["gizmo"]
    } else if v.get("resource").and_then(|r| r.get("gizmo")).is_some() {
        &v["resource"]["gizmo"]
    } else {
        v
    }
}

/// Build a Project from an (already unwrapped) gizmo object.
fn project_from_gizmo(g: &Value) -> Project {
    let perm = &g["current_user_permission"];
    Project {
        id: g["id"].as_str().unwrap_or("").to_string(),
        name: g["display"]["name"].as_str().or_else(|| g["name"].as_str()).unwrap_or("").to_string(),
        description: g["display"]["description"].as_str().unwrap_or("").to_string(),
        instructions: g["instructions"].as_str().unwrap_or("").to_string(),
        memory_enabled: g["memory_enabled"].as_bool().unwrap_or(false),
        memory_scope: g["memory_scope"].as_str().unwrap_or("global").to_string(),
        can_write: perm["can_write"].as_bool().unwrap_or(false),
        can_delete: perm["can_delete"].as_bool().unwrap_or(false),
        updated: time_key(&g["last_interacted_at"]).or_else(|| time_key(&g["updated_at"])),
    }
}

/// Project ids look like `g-p-<hex>`; keep anything odd out of a URL path.
fn project_id_ok(id: &str) -> Result<&str, String> {
    if !id.is_empty() && id.len() <= 100 && id.chars().all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_') {
        Ok(id)
    } else {
        Err("Bad project id.".into())
    }
}

/// Parse a `{ items: [...] }` conversation list into summaries (shared by the normal list and a
/// project's chat list).
fn conversation_items(data: &Value) -> Vec<ConversationSummary> {
    data["items"].as_array()
        .map(|arr| {
            arr.iter().map(|c| ConversationSummary {
                id: c["id"].as_str().unwrap_or("").to_string(),
                title: c["title"].as_str().unwrap_or("Untitled").to_string(),
                model: c["default_model_slug"].as_str()
                    .or_else(|| c["current_node_model_slug"].as_str())
                    .unwrap_or("").to_string(),
                updated: time_key(&c["update_time"]),
                pinned: c["is_starred"].as_bool().unwrap_or(false),
                pinned_time: time_key(&c["pinned_time"]),
            }).collect()
        })
        .unwrap_or_default()
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
/// Put "@" picks where chatgpt.com puts them: top-level `system_hints` and the message's
/// `metadata.system_hints` (with markdown serialization, since app mentions are markdown links).
fn apply_system_hints(body: &mut Value, picked: &[String], reasoning_effort: Option<&str>) {
    let mut hints: Vec<String> = Vec::new();
    for h in picked {
        let valid = !h.is_empty() && h.len() <= 200 && h.chars().all(|c| c.is_ascii_alphanumeric() || "_-:.".contains(c));
        if valid && !hints.contains(h) {
            hints.push(h.clone());
        }
    }
    if !hints.is_empty() {
        body["messages"][0]["metadata"]["system_hints"] = json!(hints);
        body["messages"][0]["metadata"]["serialization_metadata"] = json!({ "render_format": "markdown" });
    }
    if let Some(effort) = reasoning_effort {
        hints.push(format!("reasoning_effort:{effort}"));
    }
    if !hints.is_empty() {
        body["system_hints"] = json!(hints);
    }
}

#[derive(serde::Serialize, Clone, Debug, PartialEq)]
pub struct VoiceOption {
    pub voice: String,
    pub name: String,
    pub description: String,
}

#[derive(serde::Serialize, Clone, Debug, PartialEq)]
pub struct VoiceList {
    /// The voice chosen in the user's ChatGPT settings.
    pub selected: Option<String>,
    pub voices: Vec<VoiceOption>,
}

fn parse_voices(data: &Value) -> VoiceList {
    let voices = data["voices"]
        .as_array()
        .map(|list| {
            list.iter()
                .filter_map(|v| {
                    let voice = v["voice"].as_str().filter(|s| !s.is_empty())?.to_string();
                    let name = v["name"].as_str().filter(|s| !s.is_empty()).unwrap_or(&voice).to_string();
                    Some(VoiceOption { voice, name, description: v["description"].as_str().unwrap_or("").to_string() })
                })
                .collect()
        })
        .unwrap_or_default();
    VoiceList { selected: data["selected"].as_str().map(str::to_string), voices }
}

/// What the UI chooses for a voice call; everything else in the session is fixed.
/// The UI sends camelCase keys (timezoneOffsetMin, conversationId, …).
#[derive(serde::Deserialize, Clone, Debug, Default)]
#[serde(rename_all = "camelCase")]
pub struct VoiceSettings {
    pub voice: Option<String>,
    pub locale: Option<String>,
    pub timezone: Option<String>,
    pub timezone_offset_min: Option<i32>,
    /// Continue an existing chat by voice (as chatgpt.com does from an open chat).
    pub conversation_id: Option<String>,
    pub parent_message_id: Option<String>,
    /// Model behind the voice ("gpt-6" on the web).
    pub backend_model: Option<String>,
}

/// The "session" form field of /realtime/wm: the 17 keys chatgpt.com sends (captured live),
/// plus conversation_id/parent_message_id when continuing an open chat.
fn voice_session_json(s: &VoiceSettings, session_id: &str) -> Value {
    let word = |v: &Option<String>, fallback: &str, max: usize| {
        v.as_deref()
            .filter(|x| !x.is_empty() && x.len() <= max && x.chars().all(|c| c.is_ascii_alphanumeric() || "-_/+".contains(c)))
            .unwrap_or(fallback)
            .to_string()
    };
    let id_ok = |v: &Option<String>| v.as_deref().filter(|x| !x.is_empty() && x.len() <= 100 && x.chars().all(|c| c.is_ascii_alphanumeric() || c == '-')).map(str::to_string);
    let mut session = json!({
        "requested_default_model": "",
        "voice": word(&s.voice, "juniper", 32),
        "voice_session_id": session_id,
        "voice_status_request_id": session_id,
        "timezone_offset_min": s.timezone_offset_min.unwrap_or(0).clamp(-900, 900),
        "timezone": word(&s.timezone, "UTC", 64),
        "user_locale": word(&s.locale, "en-US", 16),
        "voice_mode": "wingman",
        "model_slug": "",
        "model_slug_advanced": "",
        "client_tools": [],
        "history_and_training_disabled": false,
        // The other 5 keys chatgpt.com sends (values captured from the web; the
        // conversation_mode kind is the one text messages use, inferred).
        "conversation_mode": { "kind": "primary_assistant" },
        "chat_mode": "chat",
        "backend_model": word(&s.backend_model, "gpt-6", 64),
        "enable_message_streaming": true,
        "deprecate_celsius": true
    });
    if let Some(conv) = id_ok(&s.conversation_id) {
        session["conversation_id"] = json!(conv);
        if let Some(parent) = id_ok(&s.parent_message_id) {
            session["parent_message_id"] = json!(parent);
        }
    }
    session
}

/// A model family for the picker: its plain slug (sent for Instant) and its thinking slug
/// (sent with an effort for Medium/High). Checked on chatgpt.com for GPT-6:
/// Instant = "gpt-6", Medium = "gpt-6-thinking"+"standard", High = "gpt-6-thinking"+"extended".
#[derive(Serialize, Clone, Debug, PartialEq)]
pub struct ModelFamily {
    pub slug: String,
    pub thinking_slug: String,
    pub title: String,
    pub efforts: Vec<String>,
}

#[derive(Serialize, Clone, Debug, PartialEq)]
pub struct ModelList {
    pub default_slug: String,
    pub families: Vec<ModelFamily>,
}

/// Families that have both "<slug>" and "<slug>-thinking" with configurable effort, in the
/// order /backend-api/models lists them, the account default first.
pub fn parse_models(data: &Value) -> ModelList {
    let models: Vec<&Value> = data["models"].as_array().map(|a| a.iter().collect()).unwrap_or_default();
    let by_slug = |s: &str| models.iter().find(|m| m["slug"].as_str() == Some(s)).copied();
    let default_slug = data["default_model_slug"].as_str().unwrap_or("auto").to_string();
    let mut families: Vec<ModelFamily> = models
        .iter()
        .filter_map(|m| {
            let slug = m["slug"].as_str()?;
            let thinking = by_slug(&format!("{slug}-thinking"))?;
            if thinking["configurable_thinking_effort"].as_bool() != Some(true) {
                return None;
            }
            let efforts = thinking["thinking_efforts"]
                .as_array()
                .map(|a| a.iter().filter_map(|e| e["thinking_effort"].as_str().or(e.as_str()).map(str::to_string)).collect())
                .unwrap_or_default();
            Some(ModelFamily {
                slug: slug.to_string(),
                thinking_slug: format!("{slug}-thinking"),
                title: m["title"].as_str().unwrap_or(slug).to_string(),
                efforts,
            })
        })
        .collect();
    if let Some(i) = families.iter().position(|f| f.slug == default_slug) {
        let f = families.remove(i);
        families.insert(0, f);
    }
    ModelList { default_slug, families }
}

/// One entry of the "@" menu: a tool ("search", "picture_v2") or a connected app ("plugin:…").
#[derive(Serialize, Clone, Debug, PartialEq)]
pub struct SystemHint {
    pub id: String,
    pub name: String,
    pub label: String,
    pub description: String,
    /// Image source the UI can use directly: https URL or data:image/svg+xml.
    pub logo: String,
    pub is_plugin: bool,
    /// Shown before the user types a search (chatgpt.com hides unconnected apps and some tools).
    pub initial: bool,
    pub aliases: Vec<String>,
}

/// Parse /backend-api/system_hints?mode=all into "@" menu entries.
pub fn parse_system_hints(data: &Value) -> Vec<SystemHint> {
    let Some(items) = data["system_hints"].as_array() else { return Vec::new() };
    items
        .iter()
        .filter_map(|i| {
            let id = i["system_hint"].as_str()?.to_string();
            let name = i["name"].as_str().unwrap_or(&id).to_string();
            let is_plugin = i["is_plugin"].as_bool().unwrap_or(false) || id.starts_with("plugin:");
            let connected = i["is_connected"].as_bool().unwrap_or(false);
            let hidden = i["hide_from_initial_selection"].as_bool().unwrap_or(false);
            // Unconnected apps would need chatgpt.com's connect flow; leave them out.
            if is_plugin && !connected {
                return None;
            }
            Some(SystemHint {
                label: i["action_label"].as_str().filter(|s| !s.is_empty()).unwrap_or(&name).to_string(),
                description: truncate_chars(i["description"].as_str().unwrap_or(""), 120),
                logo: logo_src(i["logo"].as_str().unwrap_or("")),
                aliases: i["aliases"].as_array().map(|a| a.iter().filter_map(|x| x.as_str().map(str::to_string)).collect()).unwrap_or_default(),
                initial: !hidden,
                is_plugin,
                id,
                name,
            })
        })
        .collect()
}

/// chatgpt.com sends logos as inline SVG markup, a site path, or an https URL.
/// Inline SVG becomes a data: URL so it renders through <img> (no scripts run there).
fn logo_src(logo: &str) -> String {
    use base64::Engine;
    let logo = logo.trim();
    if logo.starts_with("<svg") {
        format!("data:image/svg+xml;base64,{}", base64::engine::general_purpose::STANDARD.encode(logo))
    } else if logo.starts_with('/') && !logo.starts_with("//") {
        format!("{BASE_URL}{logo}")
    } else if logo.starts_with("https://") {
        logo.to_string()
    } else {
        String::new()
    }
}

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

/// Reply text from streamed events, kept per message id (in first-seen order) so pieces of
/// two messages streaming at once never interleave, then merged with merge_reply_text.
/// Returns the text and the number of reply messages seen.
pub fn join_reply(events: &[StreamEvent]) -> (String, usize) {
    let mut order: Vec<&str> = Vec::new();
    let mut texts: HashMap<&str, String> = HashMap::new();
    for e in events {
        if let StreamEvent::Text { delta, id } = e {
            if !texts.contains_key(id.as_str()) {
                order.push(id.as_str());
            }
            texts.entry(id.as_str()).or_default().push_str(delta);
        }
    }
    let mut out = String::new();
    for id in &order {
        merge_reply_text(&mut out, texts[id].trim());
    }
    (out, order.len())
}

/// Add one reply message's text to the reply. The server can stream the same reply twice at
/// once: whole in one message and cut into consecutive segments in others (seen: 788 + 3232 +
/// 4913 chars = the 8933-char whole). So a text already inside the reply is a copy and is
/// skipped; a text containing the reply so far replaces it; a text whose start repeats the
/// reply's end continues it; anything else is a separate message, joined as a new paragraph.
pub fn merge_reply_text(out: &mut String, t: &str) {
    if t.is_empty() || out.contains(t) {
        return;
    }
    if out.is_empty() || t.contains(out.as_str()) {
        *out = t.to_string();
        return;
    }
    let overlap = reply_overlap(out, t);
    if overlap > 0 {
        out.push_str(&t[overlap..]);
    } else {
        out.push_str("\n\n");
        out.push_str(t);
    }
}

/// Bytes of t's start that out already ends with (at least 20 chars of it), else 0.
fn reply_overlap(out: &str, t: &str) -> usize {
    let probe_end = t.char_indices().nth(20).map(|(i, _)| i);
    let Some(probe_end) = probe_end else { return 0 };
    let probe = &t[..probe_end];
    let from = out.len().saturating_sub(t.len());
    let from = (from..=out.len()).find(|i| out.is_char_boundary(*i)).unwrap_or(out.len());
    for (pos, _) in out[from..].match_indices(probe) {
        let tail = &out[from + pos..];
        if t.starts_with(tail) {
            return tail.len();
        }
    }
    0
}

/// Where the raw stream of the last message is kept (overwritten on every send), for
/// diagnosing replies that render differently from chatgpt.com.
pub fn last_stream_path() -> Option<std::path::PathBuf> {
    dirs::cache_dir().map(|d| d.join("chatgpt-ui").join("last-stream.sse"))
}

/// One raw SSE line for the diagnostic log, with the conversation resume token removed.
fn redact_stream_line(line: &str) -> String {
    if !line.contains("resume_conversation_token") {
        return line.to_string();
    }
    match line.find("\"token\":\"") {
        Some(at) => {
            let start = at + "\"token\":\"".len();
            let end = line[start..].find('"').map(|n| start + n).unwrap_or(line.len());
            format!("{}<redacted>{}", &line[..start], &line[end..])
        }
        None => line.to_string(),
    }
}

/// A stored message's text: string parts, plus the transcript of voice-mode turns
/// ({"content_type":"audio_transcription","text":…} parts), which have no string parts at all.
fn message_text(msg: &Value) -> String {
    msg["content"]["parts"]
        .as_array()
        .map(|arr| {
            arr.iter()
                .filter_map(|p| {
                    p.as_str().or_else(|| {
                        (p["content_type"].as_str() == Some("audio_transcription")).then(|| p["text"].as_str()).flatten()
                    })
                })
                .collect::<Vec<_>>()
                .join("")
        })
        .unwrap_or_default()
}

/// A signed file link served by ChatGPT itself (where generated images live).
pub fn is_chatgpt_file_url(link: &str) -> bool {
    let Ok(u) = reqwest::Url::parse(link) else { return false };
    u.scheme() == "https"
        && (u.host_str() == Some("chatgpt.com") && u.path().starts_with("/backend-api/estuary/content")
            || u.host_str().is_some_and(|h| h.ends_with(".oaiusercontent.com")))
}

/// Images the image tool returned in a tool message (multimodal_text image_asset_pointer parts).
fn generated_images(msg: &Value) -> Vec<GeneratedImage> {
    if msg.pointer("/author/role").and_then(|r| r.as_str()) != Some("tool") {
        return Vec::new();
    }
    let title = msg.pointer("/metadata/image_gen_title").and_then(|t| t.as_str()).unwrap_or("");
    msg["content"]["parts"]
        .as_array()
        .into_iter()
        .flatten()
        .filter(|p| p["content_type"].as_str() == Some("image_asset_pointer"))
        .filter_map(|p| {
            let pointer = p["asset_pointer"].as_str()?;
            let id = pointer.strip_prefix("sediment://").or_else(|| pointer.strip_prefix("file-service://"))?;
            if id.is_empty() || !id.chars().all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '-') {
                return None;
            }
            let part_title = p.pointer("/metadata/dalle/serialization_title").and_then(|t| t.as_str()).unwrap_or("");
            Some(GeneratedImage {
                file_id: id.to_string(),
                width: p["width"].as_u64().unwrap_or(0) as u32,
                height: p["height"].as_u64().unwrap_or(0) as u32,
                title: truncate_chars(if title.is_empty() { part_title } else { title }, 200),
            })
        })
        .collect()
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
    } else if recipient.len() <= 32 && recipient.chars().all(|c| c.is_ascii_lowercase() || c == '_') {
        format!("Using {recipient}")
    } else {
        // Internal tool names (e.g. the image tool's "t2uay3k.sj1i4kz") mean nothing to people.
        "Using a tool".into()
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

/// The step's icon as chatgpt.com shows it (metadata.tool_icons): an app logo URL, a site path
/// on chatgpt.com, or a named icon. Favicons served by Google are skipped on purpose: loading
/// them would send every searched site to Google.
fn step_icon(msg: &Value) -> String {
    let Some(first) = msg.pointer("/metadata/tool_icons/0").and_then(|i| i.as_str()) else { return String::new() };
    if let Ok(u) = reqwest::Url::parse(first) {
        let host = u.host_str().unwrap_or("");
        let google = host == "google.com" || host.ends_with(".google.com") || host.ends_with(".gstatic.com");
        return if u.scheme() == "https" && !google { first.to_string() } else { String::new() };
    }
    if first.starts_with('/') && !first.starts_with("//") {
        return format!("{BASE_URL}{first}");
    }
    if first.len() <= 30 && first.chars().all(|c| c.is_ascii_lowercase() || c == '-' || c == '_') {
        return first.to_string();
    }
    String::new()
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
        // chatgpt.com's own wording ("Running app request") beats our guess from the tool name.
        let invoking = msg.pointer("/metadata/tool_invoking_message").and_then(|t| t.as_str()).unwrap_or("");
        let title = if !title.is_empty() {
            title
        } else if !invoking.is_empty() {
            truncate_chars(invoking, 120)
        } else {
            friendly_tool(recipient)
        };
        return Some(("tool_call".into(), title, tool_call_detail(msg), recipient.to_string()));
    }
    if role == "tool" {
        let tool = msg.pointer("/author/name").and_then(|n| n.as_str()).unwrap_or("").to_string();
        if let Some(image_title) = msg.pointer("/metadata/image_gen_title").and_then(|t| t.as_str()) {
            return Some(("tool_result".into(), "Created image".into(), truncate_chars(image_title, 200), tool));
        }
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

/// A saved reply's activity, gathered from the messages before its text.
#[derive(Default)]
struct ReplyActivity {
    recap: String,
    steps: Vec<HistoryStep>,
    runs: Vec<CodeRun>,
}

impl ReplyActivity {
    fn is_empty(&self) -> bool {
        self.recap.is_empty() && self.steps.is_empty() && self.runs.is_empty()
    }
}

/// What chatgpt.com shows for a saved reply, measured on a reply that searched and ran code:
/// the header is the reasoning_recap ("Worked for 13s"); opened, it lists the thought summaries
/// ("Searched 3 websites", "Calculated 3.5% of …", marked with tool_summary_type); code the
/// python tool ran shows as an "Analyzed" block with its result. App calls (connectors) are
/// listed too. Tool calls that thoughts already summarise (web search, python) aren't.
fn collect_activity(msg: &Value, act: &mut ReplyActivity) {
    if msg.pointer("/metadata/is_visually_hidden_from_conversation").and_then(|h| h.as_bool()) == Some(true) {
        return;
    }
    let role = msg.pointer("/author/role").and_then(|r| r.as_str()).unwrap_or("");
    let recipient = msg["recipient"].as_str().unwrap_or("all");
    let content_type = msg["content"]["content_type"].as_str().unwrap_or("text");
    let text_of = |m: &Value| -> String {
        m["content"]["text"].as_str().map(str::to_string).unwrap_or_else(|| {
            m["content"]["parts"].as_array().map(|p| p.iter().filter_map(|x| x.as_str()).collect::<Vec<_>>().join("")).unwrap_or_default()
        })
    };
    match role {
        "assistant" if content_type == "reasoning_recap" => {
            if let Some((_, recap, _, _)) = activity_step(msg) {
                if !recap.is_empty() {
                    act.recap = truncate_chars(&recap, 80);
                }
            }
        }
        "assistant" if content_type == "thoughts" && recipient == "all" => {
            let kind = msg.pointer("/metadata/tool_summary_type").and_then(|t| t.as_str())
                .filter(|t| t.len() <= 20 && t.chars().all(|c| c.is_ascii_lowercase() || c == '_'))
                .unwrap_or("thought");
            let mut domains: Vec<String> = Vec::new();
            for g in msg.pointer("/metadata/inline_cot_expandable_content/search_result_groups").and_then(|g| g.as_array()).into_iter().flatten() {
                if let Some(d) = g["domain"].as_str() {
                    if domains.len() < 8 && !domains.iter().any(|x| x == d) {
                        domains.push(d.to_string());
                    }
                }
            }
            for t in msg["content"]["thoughts"].as_array().into_iter().flatten() {
                let summary = t["summary"].as_str().unwrap_or("").trim();
                if summary.is_empty() {
                    continue;
                }
                let content = t["content"].as_str().unwrap_or("").trim();
                act.steps.push(HistoryStep {
                    kind: kind.to_string(),
                    title: truncate_chars(summary, 200),
                    detail: if content == summary { String::new() } else { truncate_chars(content, 2000) },
                    icon: step_icon(msg),
                    domains: std::mem::take(&mut domains),
                });
            }
        }
        "assistant" if recipient.starts_with("python") => {
            act.runs.push(CodeRun { code: truncate_chars(text_of(msg).trim(), 20_000), output: String::new() });
        }
        "assistant" if recipient != "all" && (recipient.starts_with("api_tool") || recipient.contains("mcp") || recipient.contains("connector")) => {
            if let Some((_, title, detail, _)) = activity_step(msg) {
                act.steps.push(HistoryStep { kind: "tool_call".into(), title, detail, icon: step_icon(msg), domains: Vec::new() });
            }
        }
        "tool" if content_type == "execution_output" && msg.pointer("/author/name").and_then(|n| n.as_str()).unwrap_or("").starts_with("python") => {
            if let Some(run) = act.runs.last_mut() {
                run.output = truncate_chars(text_of(msg).trim(), 4000);
            }
        }
        _ => {}
    }
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
    generated_ids: std::collections::HashSet<String>,
    announced_conversation: Option<String>,
}

impl SseParser {
    /// Events for one SSE line: at most one text/step event, plus any newly resolved images.
    fn feed(&mut self, line: &str, client: &mut ChatGptClient) -> Vec<StreamEvent> {
        let Some((msg_id, data)) = parse_sse_line(line) else { return Vec::new() };
        let mut out: Vec<StreamEvent> = Vec::new();
        if let Some(conv_id) = data.get("conversation_id").and_then(|c| c.as_str()) {
            if self.announced_conversation.as_deref() != Some(conv_id) {
                self.announced_conversation = Some(conv_id.to_string());
                out.push(StreamEvent::Conversation { conversation_id: conv_id.to_string() });
            }
        }
        out.extend(self.feed_message(msg_id, &data, client));
        if is_user_visible(&data["message"]) {
            let fresh: Vec<GenImage> = genui_images(&data["message"])
                .into_iter()
                .filter(|img| self.image_queries.insert(img.query.clone()))
                .collect();
            if !fresh.is_empty() {
                out.push(StreamEvent::Images { images: fresh });
            }
        }
        let made: Vec<GeneratedImage> = generated_images(&data["message"])
            .into_iter()
            .filter(|img| self.generated_ids.insert(img.file_id.clone()))
            .collect();
        if !made.is_empty() {
            out.push(StreamEvent::Generated { images: made });
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
            let icon = step_icon(msg);
            let sig = format!("{kind}\u{1}{title}\u{1}{detail}\u{1}{tool}\u{1}{}\u{1}{icon}", sources.len());
            if self.step_sigs.get(&msg_id) == Some(&sig) {
                return None;
            }
            self.step_sigs.insert(msg_id.clone(), sig);
            return Some(StreamEvent::Step { id: msg_id, kind, title, detail, tool, sources, icon });
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
        self.last_message_id = Some(msg_id.clone());
        if let Some(model) = msg.pointer("/metadata/model_slug").and_then(|m| m.as_str()) {
            client.actual_model = Some(model.to_string());
        }
        Some(StreamEvent::Text { delta, id: msg_id })
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

/// A chat's update_time as a comparable key: the list sends an ISO string, other endpoints a
/// number of seconds. Missing or other types give None.
fn time_key(v: &Value) -> Option<String> {
    match v {
        Value::String(s) if !s.is_empty() => Some(s.clone()),
        Value::Number(n) => Some(n.to_string()),
        _ => None,
    }
}

/// The status word from a stream_status response, or "" when it has none.
fn parse_stream_status(data: &Value) -> String {
    data["status"]
        .as_str()
        .filter(|s| s.len() <= 40 && s.chars().all(|c| c.is_ascii_uppercase() || c == '_'))
        .unwrap_or("")
        .to_string()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn saved_reply_activity_matches_the_web() {
        // Message shapes as stored for a reply that searched, ran python and thought (measured).
        let msgs = vec![
            json!({ "author": { "role": "assistant" }, "recipient": "web.run", "content": { "content_type": "text", "parts": ["{}"] }, "metadata": { "reasoning_title": "Searching the web" } }),
            json!({ "author": { "role": "tool", "name": "web.run" }, "recipient": "all", "content": { "content_type": "text", "parts": [""] }, "metadata": { "reasoning_title": "Searching 3 websites" } }),
            json!({ "author": { "role": "assistant" }, "recipient": "all", "content": { "content_type": "thoughts", "thoughts": [{ "summary": "Searched 3 websites", "content": "" }] },
                    "metadata": { "tool_summary_type": "web", "inline_cot_expandable_content": { "search_result_groups": [{ "domain": "a.example" }, { "domain": "b.example" }, { "domain": "a.example" }] } } }),
            json!({ "author": { "role": "assistant" }, "recipient": "python", "content": { "content_type": "code", "text": "x = 2\nx * 3" }, "metadata": {} }),
            json!({ "author": { "role": "tool", "name": "python" }, "recipient": "all", "content": { "content_type": "execution_output", "text": "6" }, "metadata": {} }),
            json!({ "author": { "role": "assistant" }, "recipient": "all", "content": { "content_type": "thoughts", "thoughts": [{ "summary": "Calculated the result", "content": "Multiply" }] }, "metadata": { "tool_summary_type": "python" } }),
            json!({ "author": { "role": "assistant" }, "recipient": "bio", "content": { "content_type": "text", "parts": ["x"] }, "metadata": { "is_visually_hidden_from_conversation": true } }),
            json!({ "author": { "role": "assistant" }, "recipient": "api_tool.call_tool", "content": { "content_type": "code", "text": "{}" }, "metadata": { "tool_invoking_message": "Running app request" } }),
            json!({ "author": { "role": "assistant" }, "recipient": "all", "content": { "content_type": "reasoning_recap", "content": "Worked for 13s" }, "metadata": { "finished_duration_sec": 13 } }),
        ];
        let mut act = ReplyActivity::default();
        for m in &msgs {
            collect_activity(m, &mut act);
        }
        assert_eq!(act.recap, "Worked for 13s");
        let steps: Vec<(&str, &str, &str)> = act.steps.iter().map(|s| (s.kind.as_str(), s.title.as_str(), s.detail.as_str())).collect();
        assert_eq!(steps, vec![
            ("web", "Searched 3 websites", ""),
            ("python", "Calculated the result", "Multiply"),
            ("tool_call", "Running app request", "{}"),
        ]);
        assert_eq!(act.steps[0].domains, vec!["a.example", "b.example"]);
        assert_eq!(act.runs, vec![CodeRun { code: "x = 2\nx * 3".into(), output: "6".into() }]);
        // A recap without text falls back to the duration.
        let mut act2 = ReplyActivity::default();
        collect_activity(&json!({ "author": { "role": "assistant" }, "recipient": "all", "content": { "content_type": "reasoning_recap" }, "metadata": { "finished_duration_sec": 9.4 } }), &mut act2);
        assert_eq!(act2.recap, "Thought for 9s");
    }

    #[test]
    fn stream_status_reads_the_status_word() {
        assert_eq!(parse_stream_status(&json!({ "status": "IS_STREAMING" })), "IS_STREAMING");
        assert_eq!(parse_stream_status(&json!({ "status": "COMPLETE" })), "COMPLETE");
        assert_eq!(parse_stream_status(&json!({})), "");
        assert_eq!(parse_stream_status(&json!({ "status": "<b>x</b>" })), "");
    }

    #[test]
    fn time_key_reads_string_and_number_update_times() {
        assert_eq!(time_key(&json!("2026-11-08T01:02:03.456789Z")).as_deref(), Some("2026-11-08T01:02:03.456789Z"));
        assert_eq!(time_key(&json!(1762563723.5)).as_deref(), Some("1762563723.5"));
        assert_eq!(time_key(&json!(null)), None);
        assert_eq!(time_key(&json!("")), None);
        assert_ne!(time_key(&json!("2026-11-08T01:02:03Z")), time_key(&json!("2026-11-08T01:05:00Z")));
    }

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
        let text: String = events.iter().filter_map(|e| match e { StreamEvent::Text { delta, .. } => Some(delta.as_str()), _ => None }).collect();
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
        let text: String = events.iter().filter_map(|e| match e { StreamEvent::Text { delta, .. } => Some(delta.as_str()), _ => None }).collect();
        assert_eq!(text, "ECU คือ");
    }

    /// The NPatch reply: a second message with the same reply started late and the two streamed
    /// interleaved. Joined per message, the result is the reply once, never a mix.
    #[test]
    fn interleaved_reply_messages_do_not_mix() {
        let mut client = ChatGptClient::new("t".into());
        let snap = |id: &str, text: &str| {
            format!("data: {}", json!({ "message": { "id": id, "author": { "role": "assistant" }, "recipient": "all", "channel": "final", "content": { "content_type": "text", "parts": [text] } } }))
        };
        let full = "**ใช่ครับ เป็นโปรเจกต์เดียวกัน — NPatch ของ `7723mod`**\n\nREADME ระบุว่าเป็น Rootless Xposed Framework";
        let cut = |n: usize| full.chars().take(n).collect::<String>();
        let sse = [
            snap("a", &cut(20)),
            snap("a", &cut(44)),
            snap("b", &cut(52)), // b starts late: its first snapshot already holds a's text
            snap("a", &cut(60)),
            snap("b", &cut(80)),
            snap("a", full),
            snap("b", full),
        ]
        .join("\n");
        let events = parse_sse_stream(&sse, &mut client);
        let mixed: String = events.iter().filter_map(|e| match e { StreamEvent::Text { delta, .. } => Some(delta.as_str()), _ => None }).collect();
        assert_ne!(mixed, full, "the old way (one string) garbles the reply");
        let (text, count) = join_reply(&events);
        assert_eq!(count, 2);
        assert_eq!(text, full);

        // Two different messages (e.g. a preamble, then the answer) are both kept, in order.
        let two = parse_sse_stream(&[snap("p", "ผมจะตรวจสอบก่อน"), snap("q", "ผลคือ X")].join("\n"), &mut client);
        assert_eq!(join_reply(&two).0, "ผมจะตรวจสอบก่อน\n\nผลคือ X");
    }

    #[test]
    fn reply_streamed_whole_and_in_segments_shows_once() {
        // Seen in a goal round: the reply streamed whole in one message ("w") while three other
        // messages carried it cut into consecutive segments ("s1" + "s2" + "s3" == whole).
        let mut client = ChatGptClient::new("t".into());
        let snap = |id: &str, text: &str| {
            format!("data: {}", json!({ "message": { "id": id, "author": { "role": "assistant" }, "recipient": "all", "channel": "final", "content": { "content_type": "text", "parts": [text] } } }))
        };
        let s1 = "## ผลรอบนี้\n\nเราตรวจสอบเงื่อนไขของวงจรแล้ว\n\n";
        let s2 = "### 4. พบข้อจำกัดของวิธีพิสูจน์แบบ Fixed Window\n\nกำหนด Terras map: \\[T(n)=n/2\\]\n\n";
        let s3 = "### 5. สถานะ\n\nยังไม่สำเร็จ และไม่มีการอ้างว่าพิสูจน์ได้แล้ว";
        let whole = format!("{s1}{s2}{s3}");
        let cut = |s: &str, n: usize| s.chars().take(n).collect::<String>();
        let sse = [
            snap("s1", &cut(s1, 10)),
            snap("w", &cut(&whole, 10)),
            snap("s1", s1),
            snap("w", &cut(&whole, 40)),
            snap("s2", &cut(s2, 30)),             // segment 2 starts while the whole is behind
            snap("w", &cut(&whole, s1.chars().count() + 50)),
            snap("s2", s2),
            snap("w", &cut(&whole, s1.chars().count() + s2.chars().count() + 5)),
            snap("s3", s3),                        // segment 3 runs ahead of the whole
            snap("w", &whole),
        ];
        // At every point while streaming, nothing appears twice.
        for k in 1..=sse.len() {
            let events = parse_sse_stream(&sse[..k].join("\n"), &mut client);
            let (text, _) = join_reply(&events);
            assert_eq!(text.matches("Fixed Window").count().min(1), text.matches("Fixed Window").count(), "step {k}: duplicated");
            assert_eq!(text.matches("### 5.").count().min(1), text.matches("### 5.").count(), "step {k}: duplicated");
        }
        let events = parse_sse_stream(&sse.join("\n"), &mut client);
        let (text, count) = join_reply(&events);
        assert_eq!(count, 4);
        assert_eq!(text, whole.trim());
    }

    #[test]
    fn stream_log_hides_resume_token() {
        let line = r#"data: {"type":"resume_conversation_token","kind":"topic","token":"eyJsecret","conversation_id":"c"}"#;
        let out = redact_stream_line(line);
        assert!(!out.contains("eyJsecret"));
        assert!(out.contains(r#""token":"<redacted>""#) && out.contains("conversation_id"));
        assert_eq!(redact_stream_line("data: {\"message\":1}"), "data: {\"message\":1}");
    }

    #[test]
    fn generated_images_come_from_tool_messages() {
        let tool: Value = serde_json::from_str(r#"{"author":{"role":"tool","name":"t2uay3k.sj1i4kz"},"recipient":"all",
            "metadata":{"image_gen_title":"Sunrise Lake Fishing Adventure"},
            "content":{"content_type":"multimodal_text","parts":[
                {"content_type":"image_asset_pointer","asset_pointer":"sediment://file_00000000784482","width":1536,"height":1024},
                {"content_type":"image_asset_pointer","asset_pointer":"sediment://../../etc"},
                "text part"
            ]}}"#).unwrap();
        let imgs = generated_images(&tool);
        assert_eq!(imgs, vec![GeneratedImage { file_id: "file_00000000784482".into(), width: 1536, height: 1024, title: "Sunrise Lake Fishing Adventure".into() }]);
        let mut assistant = tool.clone();
        assistant["author"]["role"] = json!("assistant");
        assert!(generated_images(&assistant).is_empty(), "only tool output counts");

        // In a stream: one generated event, emitted once, plus a readable activity step.
        let mut client = ChatGptClient::new("t".into());
        let line = format!("data: {}", json!({ "message": { "id": "t1", "author": tool["author"], "recipient": "all", "metadata": tool["metadata"], "content": tool["content"] } }));
        let events = parse_sse_stream(&format!("{line}\n{line}"), &mut client);
        let generated: Vec<_> = events.iter().filter(|e| matches!(e, StreamEvent::Generated { .. })).collect();
        assert_eq!(generated.len(), 1);
        assert!(events.iter().any(|e| matches!(e, StreamEvent::Step { title, .. } if title == "Created image")));
        assert_eq!(friendly_tool("t2uay3k.sj1i4kz"), "Using a tool");
    }

    #[test]
    fn only_chatgpt_file_links_are_trusted() {
        assert!(is_chatgpt_file_url("https://chatgpt.com/backend-api/estuary/content?id=file_1&sig=x"));
        assert!(is_chatgpt_file_url("https://files.oaiusercontent.com/file-1?se=1"));
        assert!(!is_chatgpt_file_url("http://chatgpt.com/backend-api/estuary/content?id=1"));
        assert!(!is_chatgpt_file_url("https://chatgpt.com/backend-api/conversations"));
        assert!(!is_chatgpt_file_url("https://evil.com/oaiusercontent.com"));
        assert!(!is_chatgpt_file_url("https://chatgpt.com.evil.com/backend-api/estuary/content"));
    }

    /// Stop while the server is silent (thinking) must end the read at once, keeping what came.
    #[tokio::test]
    async fn stop_ends_a_silent_stream() {
        use tokio::io::{AsyncReadExt, AsyncWriteExt};
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        tokio::spawn(async move {
            let (mut sock, _) = listener.accept().await.unwrap();
            let mut buf = [0u8; 4096];
            let _ = sock.read(&mut buf).await;
            let body = "data: {\"message\":{\"id\":\"a\",\"author\":{\"role\":\"assistant\"},\"recipient\":\"all\",\"content\":{\"content_type\":\"text\",\"parts\":[\"partial\"]}}}\n";
            let head = "HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nTransfer-Encoding: chunked\r\n\r\n";
            sock.write_all(head.as_bytes()).await.unwrap();
            sock.write_all(format!("{:x}\r\n{}\r\n", body.len(), body).as_bytes()).await.unwrap();
            tokio::time::sleep(std::time::Duration::from_secs(30)).await; // then silence
        });
        let (tx, rx) = tokio::sync::watch::channel(false);
        let mut client = ChatGptClient::new("t".into());
        client.cancel = Some(rx);
        let mut resp = reqwest::get(format!("http://{addr}/")).await.unwrap();
        tokio::spawn(async move {
            tokio::time::sleep(std::time::Duration::from_millis(300)).await;
            let _ = tx.send(true);
        });
        let started = std::time::Instant::now();
        let events = client.read_reply(&mut resp, None, |_| {}).await.expect("stopped, not failed");
        assert!(started.elapsed() < std::time::Duration::from_secs(5), "stopped promptly");
        assert_eq!(join_reply(&events).0, "partial", "text that arrived is kept");
        assert!(client.cancel.is_some(), "the stop switch is kept for the next round (Goal mode)");
    }

    #[test]
    fn voice_session_matches_the_web() {
        let s = VoiceSettings { voice: Some("juniper".into()), locale: Some("th-TH".into()), timezone: Some("Asia/Bangkok".into()), timezone_offset_min: Some(-420), ..Default::default() };
        let j = voice_session_json(&s, "id-1");
        let mut keys: Vec<&str> = j.as_object().unwrap().keys().map(String::as_str).collect();
        keys.sort();
        assert_eq!(keys, ["backend_model", "chat_mode", "client_tools", "conversation_mode", "deprecate_celsius", "enable_message_streaming", "history_and_training_disabled", "model_slug", "model_slug_advanced", "requested_default_model", "timezone", "timezone_offset_min", "user_locale", "voice", "voice_mode", "voice_session_id", "voice_status_request_id"], "the 17 keys chatgpt.com sends");
        let cont = VoiceSettings { conversation_id: Some("6aef3bd0-88a8".into()), parent_message_id: Some("311a5b56-cc61".into()), ..Default::default() };
        let j2 = voice_session_json(&cont, "id-3");
        assert_eq!((j2["conversation_id"].as_str(), j2["parent_message_id"].as_str()), (Some("6aef3bd0-88a8"), Some("311a5b56-cc61")));
        // Voice list, shaped as captured from /backend-api/settings/voices (names differ from ids).
        let vl = parse_voices(&json!({ "selected": "juniper", "voices": [
            { "voice": "orbit", "name": "Spruce", "description": "Calm and affirming", "gain_db": 0 },
            { "voice": "bubbie", "name": "Bubbie", "description": "" },
            { "name": "no id" } ] }));
        assert_eq!(vl.selected.as_deref(), Some("juniper"));
        assert_eq!(vl.voices.len(), 2, "entries without a voice id are skipped");
        assert_eq!((vl.voices[0].voice.as_str(), vl.voices[0].name.as_str()), ("orbit", "Spruce"));
        // The UI sends camelCase keys; they must not be silently dropped.
        let from_ui: VoiceSettings = serde_json::from_value(json!({ "voice": "cove", "timezoneOffsetMin": -420, "conversationId": "abc-1", "parentMessageId": "def-2" })).unwrap();
        assert_eq!((from_ui.timezone_offset_min, from_ui.conversation_id.as_deref(), from_ui.parent_message_id.as_deref()), (Some(-420), Some("abc-1"), Some("def-2")));
        assert_eq!(j["voice_mode"], "wingman");
        assert_eq!(j["timezone"], "Asia/Bangkok");
        assert_eq!(j["voice_status_request_id"], "id-1");
        let odd = VoiceSettings { voice: Some("x\"y".into()), timezone_offset_min: Some(99999), ..Default::default() };
        let j = voice_session_json(&odd, "id-2");
        assert_eq!(j["voice"], "juniper", "odd values fall back");
        assert_eq!(j["timezone_offset_min"], 900);
    }

    #[test]
    fn voice_turns_show_their_transcript() {
        let user: Value = serde_json::from_str(r#"{"content":{"content_type":"multimodal_text","parts":[
            {"content_type":"real_time_user_audio_video_asset_pointer"},
            {"content_type":"audio_transcription","text":"ทดสอบเสียง","direction":"in"}]}}"#).unwrap();
        assert_eq!(message_text(&user), "ทดสอบเสียง");
        let plain: Value = serde_json::from_str(r#"{"content":{"content_type":"text","parts":["hello"]}}"#).unwrap();
        assert_eq!(message_text(&plain), "hello");
        let other: Value = serde_json::from_str(r#"{"content":{"content_type":"multimodal_text","parts":[{"content_type":"image_asset_pointer","text":"x"}]}}"#).unwrap();
        assert_eq!(message_text(&other), "", "only transcripts count, not other objects");
    }

    #[test]
    fn steps_carry_the_tools_own_icon() {
        let with = |icons: Value| json!({ "author": { "role": "assistant" }, "recipient": "api_tool.call_tool", "content": { "content_type": "code", "text": "{}" }, "metadata": { "tool_icons": icons, "tool_invoking_message": "Running app request" } });
        assert_eq!(step_icon(&with(json!(["https://files.openai.com/content?id=1&sig=x"]))), "https://files.openai.com/content?id=1&sig=x");
        assert_eq!(step_icon(&with(json!(["/images/ecosystem/apps/personal_context/icon.png"]))), "https://chatgpt.com/images/ecosystem/apps/personal_context/icon.png");
        assert_eq!(step_icon(&with(json!(["globe"]))), "globe");
        assert_eq!(step_icon(&with(json!(["https://www.google.com/s2/favicons?domain=x.com"]))), "", "no Google favicons");
        assert_eq!(step_icon(&with(json!(["javascript:alert(1)"]))), "");
        assert_eq!(step_icon(&with(json!([]))), "");
        let (_, title, _, _) = activity_step(&with(json!(["globe"]))).unwrap();
        assert_eq!(title, "Running app request", "the web's own wording when there is no reasoning title");
    }

    #[test]
    fn each_send_targets_its_own_conversation() {
        let mut client = ChatGptClient::new("t".into());
        client.set_thread(Some("conv-a".into()), Some("msg-1".into()));
        assert_eq!((client.conversation_id.as_deref(), client.parent_message_id.as_str()), (Some("conv-a"), "msg-1"));
        client.set_thread(None, Some("msg-1".into()));
        assert_eq!(client.conversation_id, None, "new chat");
        assert_ne!(client.parent_message_id, "msg-1", "a new chat starts from a fresh parent");
        client.set_thread(Some("bad id\"".into()), None);
        assert_eq!(client.conversation_id, None);
    }

    #[test]
    fn stream_announces_its_conversation_once() {
        let mut client = ChatGptClient::new("t".into());
        let line = r#"data: {"message":{"id":"a","author":{"role":"assistant"},"recipient":"all","content":{"content_type":"text","parts":["hi"]}},"conversation_id":"c9"}"#;
        let events = parse_sse_stream(&format!("{line}\n{line}"), &mut client);
        let announced: Vec<_> = events.iter().filter_map(|e| match e { StreamEvent::Conversation { conversation_id } => Some(conversation_id.as_str()), _ => None }).collect();
        assert_eq!(announced, ["c9"]);
    }

    #[test]
    fn models_become_picker_families() {
        let data: Value = serde_json::from_str(r#"{"default_model_slug":"gpt-6","models":[
            {"slug":"gpt-5-6","title":"GPT-5.6 Sol"},
            {"slug":"gpt-5-6-thinking","title":"GPT-5.6 Sol","configurable_thinking_effort":true,"thinking_efforts":[{"thinking_effort":"standard"},{"thinking_effort":"extended"}]},
            {"slug":"gpt-6","title":"GPT-6"},
            {"slug":"gpt-6-instant","title":"GPT-6"},
            {"slug":"gpt-6-thinking","title":"GPT-6","configurable_thinking_effort":true,"thinking_efforts":[{"thinking_effort":"standard"},{"thinking_effort":"extended"}]},
            {"slug":"gpt-6-t-mini","title":"GPT-6","configurable_thinking_effort":false}
        ]}"#).unwrap();
        let list = parse_models(&data);
        assert_eq!(list.default_slug, "gpt-6");
        let slugs: Vec<&str> = list.families.iter().map(|f| f.slug.as_str()).collect();
        assert_eq!(slugs, ["gpt-6", "gpt-5-6"], "default family first");
        assert_eq!(list.families[0].thinking_slug, "gpt-6-thinking");
        assert_eq!(list.families[0].efforts, ["standard", "extended"]);
    }

    #[test]
    fn model_choice_goes_into_the_request_like_the_web() {
        let mut client = ChatGptClient::new("t".into());
        client.set_model_choice(Some("gpt-6-thinking".into()), Some("extended".into()));
        assert_eq!((client.model.as_str(), client.thinking_effort.as_deref()), ("gpt-6-thinking", Some("extended")));
        client.set_model_choice(Some("gpt-6".into()), None);
        assert_eq!((client.model.as_str(), client.thinking_effort.as_deref()), ("gpt-6", None));
        client.set_model_choice(Some("bad model\"".into()), Some("x y".into()));
        assert_eq!(client.model, "gpt-6", "odd values are ignored");
        assert_eq!(client.thinking_effort, None);
    }

    #[test]
    fn system_hints_parse_like_the_menu() {
        let data: Value = serde_json::from_str(r#"{"system_hints":[
            {"system_hint":"search","name":"Search","action_label":"Web search","description":"Find real-time news","logo":"<svg width=\"24\"></svg>","is_plugin":false,"is_connected":false,"hide_from_initial_selection":false},
            {"system_hint":"tatertot","name":"Study","action_label":"Study","logo":"/images/x.png","is_plugin":false,"hide_from_initial_selection":true},
            {"system_hint":"plugin:asdk_app_1","name":"Hexey","action_label":"Hexey","logo":"https://files.openai.com/c?sig=1","is_plugin":true,"is_connected":true,"hide_from_initial_selection":false},
            {"system_hint":"plugin:connector_n","name":"Notion","is_plugin":true,"is_connected":false},
            {"system_hint":"plugin:x","name":"Bad logo","logo":"javascript:alert(1)","is_plugin":true,"is_connected":true}
        ]}"#).unwrap();
        let hints = parse_system_hints(&data);
        let ids: Vec<&str> = hints.iter().map(|h| h.id.as_str()).collect();
        assert_eq!(ids, ["search", "tatertot", "plugin:asdk_app_1", "plugin:x"], "unconnected apps are left out");
        assert_eq!(hints[0].label, "Web search");
        assert!(hints[0].logo.starts_with("data:image/svg+xml;base64,"));
        assert!(!hints[1].initial, "hidden from the first list but still searchable");
        assert_eq!(hints[1].logo, "https://chatgpt.com/images/x.png");
        assert_eq!(hints[2].logo, "https://files.openai.com/c?sig=1");
        assert_eq!(hints[3].logo, "", "non-https logos are dropped");
    }

    #[test]
    fn system_hints_go_where_the_web_puts_them() {
        let mut body = json!({ "messages": [{ "metadata": {} }] });
        apply_system_hints(&mut body, &["plugin:asdk_app_1".into(), "search".into(), "search".into(), "bad hint\"".into()], Some("high"));
        assert_eq!(body["messages"][0]["metadata"]["system_hints"], json!(["plugin:asdk_app_1", "search"]));
        assert_eq!(body["messages"][0]["metadata"]["serialization_metadata"]["render_format"], "markdown");
        assert_eq!(body["system_hints"], json!(["plugin:asdk_app_1", "search", "reasoning_effort:high"]));

        let mut plain = json!({ "messages": [{ "metadata": {} }] });
        apply_system_hints(&mut plain, &[], None);
        assert!(plain.get("system_hints").is_none());
        assert!(plain["messages"][0]["metadata"].get("system_hints").is_none());
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
        let delta = |evs: Vec<StreamEvent>| evs.into_iter().find_map(|e| match e { StreamEvent::Text { delta, .. } => Some(delta), _ => None });
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
        let reply: String = events.iter().filter_map(|e| match e { StreamEvent::Text { delta, .. } => Some(delta.as_str()), _ => None }).collect();
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
                if let StreamEvent::Text { delta, .. } = ev {
                    arrivals.push((start.elapsed().as_millis(), delta.len()));
                }
            })
            .await
            .expect("send");
        println!("text deltas: {}", arrivals.len());
        println!("first at {} ms, last at {} ms", arrivals.first().unwrap().0, arrivals.last().unwrap().0);
        assert!(arrivals.len() > 3, "expected several deltas, got {}", arrivals.len());
    }

    /// Read-only: a saved chat with generated images resolves to replies carrying them, and the
    /// signed link downloads without cookies. Run with
    /// `cargo test live_generated_image -- --ignored --nocapture`.
    #[tokio::test]
    #[ignore]
    async fn live_generated_image() {
        let token = crate::auth::load_token().expect("saved token");
        let client = ChatGptClient::new(token);
        let list = client.list_conversations(0, 20, false).await.expect("list");
        let conv = list.items.iter().find(|c| c.title.contains("ตกปลา")).expect("image chat");
        let full = client.get_conversation(&conv.id).await.expect("conversation");
        let with_images: Vec<_> = full.messages.iter().filter(|m| !m.generated.is_empty()).collect();
        for m in &with_images {
            println!("reply {} | text {} chars | images {:?}", m.role, m.content.len(), m.generated.iter().map(|g| (&g.title, g.width, g.height)).collect::<Vec<_>>());
        }
        assert!(!with_images.is_empty());
        let link = client.file_download_url(&with_images[0].generated[0].file_id).await.expect("link");
        let plain = reqwest::get(&link).await.expect("fetch");
        println!("no auth: HTTP {}", plain.status());
        let (bytes, ctype) = client.fetch_image_file(&with_images[0].generated[0].file_id).await.expect("image");
        println!("fetch_image_file: {ctype}, {} bytes", bytes.len());
        assert!(ctype.starts_with("image/") && bytes.len() > 1000);
    }

    /// Read-only: fetch the "@" menu for the saved account.
    /// Run with `cargo test live_system_hints -- --ignored --nocapture`.
    #[tokio::test]
    #[ignore]
    async fn live_system_hints() {
        let token = crate::auth::load_token().expect("saved token");
        let client = ChatGptClient::new(token);
        let hints = client.list_system_hints().await.expect("system hints");
        for h in &hints {
            let logo = h.logo.split([';', '?']).next().unwrap_or("");
            println!("{:<34} | {:<18} | initial={} | logo={}", h.id.chars().take(34).collect::<String>(), h.label, h.initial, logo);
        }
        assert!(hints.iter().any(|h| h.id == "search"));
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
                StreamEvent::Text { delta, .. } => text_len += delta.len(),
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
        let reply: String = events.iter().filter_map(|e| match e { StreamEvent::Text { delta, .. } => Some(delta.as_str()), _ => None }).collect();
        println!("reply: {reply}");
        assert!(reply.contains("PELICAN"));
    }
}

#[cfg(test)]
mod project_parse_tests {
    use super::*;

    // A gizmo as it arrives in a snorlax/sidebar item (trimmed to the fields we read).
    const SIDEBAR_ITEM: &str = r#"{"gizmo":{"id":"g-p-abc","instructions":"be brief",
        "display":{"name":"My Proj","description":"d","theme":null,"emoji":null},
        "memory_enabled":true,"last_interacted_at":"2026-11-09T18:02:27.095240+00:00",
        "updated_at":"2026-11-09T18:02:26+00:00",
        "current_user_permission":{"can_delete":true,"can_write":false}}}"#;

    #[test]
    fn project_parses_from_a_sidebar_item() {
        let v: Value = serde_json::from_str(SIDEBAR_ITEM).unwrap();
        let p = project_from_gizmo(giz_of(&v));
        assert_eq!(p.id, "g-p-abc");
        assert_eq!(p.name, "My Proj");
        assert_eq!(p.instructions, "be brief");
        assert!(p.memory_enabled);
        assert!(p.can_delete);
        assert!(!p.can_write);
        // prefers last_interacted_at over updated_at
        assert_eq!(p.updated.as_deref(), Some("2026-11-09T18:02:27.095240+00:00"));
    }

    #[test]
    fn create_response_unwraps_resource_gizmo() {
        let v: Value = serde_json::from_str(r#"{"resource":{"gizmo":{"id":"g-p-xyz","display":{"name":"R"}}},"error":null}"#).unwrap();
        let p = project_from_gizmo(giz_of(&v));
        assert_eq!(p.id, "g-p-xyz");
        assert_eq!(p.name, "R");
    }

    #[test]
    fn falls_back_to_updated_at_when_never_interacted() {
        let v: Value = serde_json::from_str(r#"{"gizmo":{"id":"g-p-1","display":{"name":"n"},"last_interacted_at":null,"updated_at":"2026-01-02T03:04:05+00:00"}}"#).unwrap();
        let p = project_from_gizmo(giz_of(&v));
        assert_eq!(p.updated.as_deref(), Some("2026-01-02T03:04:05+00:00"));
    }

    #[test]
    fn project_id_rejects_path_tricks() {
        assert!(project_id_ok("g-p-6af20ab2227c8191992f97b968ce9d34").is_ok());
        assert!(project_id_ok("../etc/passwd").is_err());
        assert!(project_id_ok("g-p-a/b").is_err());
        assert!(project_id_ok("").is_err());
    }
}
