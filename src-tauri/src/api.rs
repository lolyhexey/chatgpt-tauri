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

    pub async fn send_message(
        &mut self,
        text: &str,
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

        let mut body = json!({
            "action": "next",
            "messages": [{
                "id": message_id,
                "author": { "role": "user" },
                "content": { "content_type": "text", "parts": [text] },
                "metadata": {}
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

        let resp = self
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
            return Err(format!("API error (HTTP {status}): {}", &body_text[..body_text.len().min(300)]));
        }

        let full_text = resp.text().await.map_err(|e| format!("Stream read error: {e}"))?;
        let events = parse_sse_stream(&full_text, self);
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

            for nid in &chain {
                if let Some(node) = map.get(nid.as_str()) {
                    let msg = &node["message"];
                    let role = msg["author"]["role"].as_str().unwrap_or("");
                    if role != "user" && role != "assistant" {
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
                    if !parts.is_empty() {
                        messages.push(Message {
                            id: msg["id"].as_str().unwrap_or("").to_string(),
                            role: role.to_string(),
                            content: parts,
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

fn parse_sse_stream(text: &str, client: &mut ChatGptClient) -> Vec<StreamEvent> {
    let mut events = Vec::new();
    let mut msg_texts: HashMap<String, String> = HashMap::new();
    let mut last_message_id = None;

    for line in text.lines() {
        let Some((msg_id, data)) = parse_sse_line(line) else {
            continue;
        };

        let msg = &data["message"];
        let content_type = msg["content"]["content_type"].as_str().unwrap_or("text");
        let parts = msg["content"]["parts"]
            .as_array()
            .map(|arr| {
                arr.iter()
                    .filter_map(|p| p.as_str())
                    .collect::<Vec<_>>()
                    .join("")
            })
            .unwrap_or_default();

        let prev = msg_texts.get(&msg_id).map(|s| s.len()).unwrap_or(0);
        if parts.len() > prev {
            let delta = parts[prev..].to_string();
            msg_texts.insert(msg_id.clone(), parts);
            last_message_id = Some(msg_id.clone());

            if let Some(conv_id) = data.get("conversation_id").and_then(|c| c.as_str()) {
                client.conversation_id = Some(conv_id.to_string());
            }
            if let Some(model) = msg.pointer("/metadata/model_slug").and_then(|m| m.as_str()) {
                client.actual_model = Some(model.to_string());
            }

            let event = match content_type {
                "thoughts" => StreamEvent::Thinking { delta },
                "reasoning_recap" => StreamEvent::Reasoning { delta },
                _ => StreamEvent::Text { delta },
            };
            events.push(event);
        }
    }

    if let Some(mid) = last_message_id {
        client.parent_message_id = mid.clone();
        events.push(StreamEvent::Done {
            conversation_id: client.conversation_id.clone().unwrap_or_default(),
            message_id: mid,
            model: client.actual_model.clone().unwrap_or_default(),
        });
    }

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
}
