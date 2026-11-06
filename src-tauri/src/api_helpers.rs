use reqwest::header::{HeaderMap, HeaderValue};
use uuid::Uuid;

pub const UA: &str = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";
pub const BASE_URL: &str = "https://chatgpt.com";

pub fn new_device_id() -> String {
    Uuid::new_v4().to_string()
}

pub fn base_headers(token: &str, device_id: &str) -> HeaderMap {
    let mut headers = HeaderMap::new();
    headers.insert(
        "Authorization",
        HeaderValue::from_str(&format!("Bearer {token}")).unwrap(),
    );
    headers.insert("Content-Type", HeaderValue::from_static("application/json"));
    headers.insert("oai-device-id", HeaderValue::from_str(device_id).unwrap());
    headers.insert("OAI-Device-Id", HeaderValue::from_str(device_id).unwrap());
    headers.insert("oai-did", HeaderValue::from_str(device_id).unwrap());
    headers.insert("OAI-Language", HeaderValue::from_static("en-US"));
    headers.insert("oai-language", HeaderValue::from_static("en-US"));
    headers.insert("originator", HeaderValue::from_static("chat"));
    headers.insert(
        "x-openai-web-frontend",
        HeaderValue::from_static("web"),
    );
    headers.insert(
        "x-oai-mcp-form-version",
        HeaderValue::from_static("2"),
    );
    headers.insert("User-Agent", HeaderValue::from_static(UA));
    headers.insert("Origin", HeaderValue::from_static("https://chatgpt.com"));
    headers.insert("Referer", HeaderValue::from_static("https://chatgpt.com/"));
    headers.insert(
        "sec-ch-ua",
        HeaderValue::from_static(r#""Chromium";v="131", "Not_A Brand";v="24""#),
    );
    headers.insert("sec-ch-ua-mobile", HeaderValue::from_static("?0"));
    headers.insert(
        "sec-ch-ua-platform",
        HeaderValue::from_static(r#""Windows""#),
    );
    headers.insert("sec-fetch-dest", HeaderValue::from_static("empty"));
    headers.insert("sec-fetch-mode", HeaderValue::from_static("cors"));
    headers.insert("sec-fetch-site", HeaderValue::from_static("same-origin"));
    headers
}
