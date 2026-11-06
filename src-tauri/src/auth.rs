use base64::Engine;
use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use std::fs;
use std::path::PathBuf;
use std::time::{SystemTime, UNIX_EPOCH};

fn config_dir() -> PathBuf {
    dirs::home_dir()
        .unwrap_or_else(|| PathBuf::from("."))
        .join(".chatgpt-cli")
}

fn token_path() -> PathBuf {
    config_dir().join("token")
}

pub fn validate_token(token: &str) -> Result<String, String> {
    let value = token.trim();
    if value.len() < 100 || value.len() > 16384 {
        return Err("Invalid access token format".into());
    }
    if value.contains('\n') || value.contains('\r') || value.contains('\0') {
        return Err("Invalid access token format".into());
    }

    let parts: Vec<&str> = value.split('.').collect();
    if parts.len() != 3 || parts[0].is_empty() || parts[1].is_empty() || parts[2].is_empty() {
        return Err("Invalid access token format".into());
    }

    let payload_bytes = URL_SAFE_NO_PAD
        .decode(parts[1])
        .map_err(|_| "Invalid token payload".to_string())?;

    let payload: serde_json::Value =
        serde_json::from_slice(&payload_bytes).map_err(|_| "Invalid token payload".to_string())?;

    if !payload.is_object() {
        return Err("Invalid token claims".into());
    }

    if let Some(exp) = payload.get("exp") {
        if let Some(exp_num) = exp.as_f64() {
            let now = SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap()
                .as_secs_f64();
            if exp_num <= now {
                return Err("Access token has expired. Sign in again.".into());
            }
        }
    }

    Ok(value.to_string())
}

pub fn load_token() -> Option<String> {
    let path = token_path();
    if !path.exists() {
        return None;
    }
    let content = fs::read_to_string(&path).ok()?;
    validate_token(&content).ok()
}

pub fn save_token(token: &str) -> Result<(), String> {
    let value = validate_token(token)?;
    let dir = config_dir();
    fs::create_dir_all(&dir).map_err(|e| format!("Cannot create config dir: {e}"))?;
    fs::write(token_path(), &value).map_err(|e| format!("Cannot save token: {e}"))?;
    Ok(())
}

pub fn clear_token() -> Result<(), String> {
    let path = token_path();
    if path.exists() {
        fs::remove_file(&path).map_err(|e| format!("Cannot remove token: {e}"))?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn validate_token_rejects_short() {
        assert!(validate_token("too.short.x").is_err());
    }

    #[test]
    fn validate_token_rejects_non_jwt() {
        let long = "a".repeat(200);
        assert!(validate_token(&long).is_err());
    }

    #[test]
    fn validate_token_rejects_expired() {
        let header = URL_SAFE_NO_PAD.encode(r#"{"alg":"HS256"}"#);
        let payload = URL_SAFE_NO_PAD.encode(r#"{"exp":0}"#);
        let sig = "a".repeat(40);
        let token = format!("{header}.{payload}.{sig}");
        let padded = format!("{token}{}", "x".repeat(100usize.saturating_sub(token.len())));
        let result = validate_token(&padded);
        assert!(result.is_err());
        assert!(
            result.unwrap_err().contains("expired"),
            "Should mention expired"
        );
    }

    #[test]
    fn validate_token_accepts_valid() {
        let header = URL_SAFE_NO_PAD.encode(r#"{"alg":"HS256"}"#);
        let exp = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_secs()
            + 3600;
        let payload = URL_SAFE_NO_PAD.encode(format!(r#"{{"exp":{exp}}}"#));
        let sig = "a".repeat(40);
        let token = format!("{header}.{payload}.{sig}");
        let padded = format!("{token}{}", "x".repeat(150usize.saturating_sub(token.len())));
        assert!(validate_token(&padded).is_ok());
    }
}
