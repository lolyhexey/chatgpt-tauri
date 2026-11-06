use base64::Engine;
use base64::engine::general_purpose::STANDARD;
use uuid::Uuid;

const UA: &str = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";

pub fn fnv1a(input: &str) -> String {
    let mut hash: u32 = 0x811c9dc5;
    for b in input.bytes() {
        hash ^= b as u32;
        hash = hash.wrapping_mul(0x1000193);
    }
    hash ^= hash >> 16;
    hash = hash.wrapping_mul(0x85ebca6b);
    hash ^= hash >> 13;
    hash = hash.wrapping_mul(0xc2b2ae35);
    hash ^= hash >> 16;
    format!("{:08x}", hash)
}

fn fake_config() -> serde_json::Value {
    serde_json::json!([
        3000,
        chrono_now_string(),
        2172649472u64,
        0,
        UA,
        "",
        "",
        "en-US",
        "en-US,en",
        0,
        "userAgent",
        "body",
        "fetch",
        0,
        Uuid::new_v4().to_string(),
        "",
        16,
        timestamp_ms(),
        0,
        0,
        1,
        0,
        0,
        0,
        0
    ])
}

fn chrono_now_string() -> String {
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap();
    let secs = now.as_secs();
    // Approximate ISO string like JS Date()
    let days = secs / 86400;
    let time_of_day = secs % 86400;
    let hours = time_of_day / 3600;
    let mins = (time_of_day % 3600) / 60;
    let secs_remainder = time_of_day % 60;
    // Simple epoch-days to date (good enough for the PoW token)
    let year = 1970 + (days * 400 / 146097);
    format!(
        "{}-01-01T{:02}:{:02}:{:02}.000Z",
        year, hours, mins, secs_remainder
    )
}

fn timestamp_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap()
        .as_millis() as u64
}

fn encode_config(config: &serde_json::Value) -> String {
    let json = serde_json::to_string(config).unwrap();
    STANDARD.encode(json.as_bytes())
}

pub fn solve_pow(seed: &str, difficulty: &str) -> Result<String, String> {
    let start = timestamp_ms();
    let mut config = fake_config();

    for i in 0..500_000u64 {
        config[3] = serde_json::json!(i);
        config[9] = serde_json::json!(timestamp_ms() - start);
        let encoded = encode_config(&config);
        let input = format!("{seed}{encoded}");
        let hash = fnv1a(&input);
        if hash[..difficulty.len()] <= *difficulty {
            return Ok(format!("gAAAAAB{encoded}~S"));
        }
    }

    Err("Proof-of-work could not be solved within 500K iterations".into())
}

pub fn make_app_attest() -> String {
    let mut config = fake_config();
    config[3] = serde_json::json!(1);
    config[9] = serde_json::json!(0);
    format!("gAAAAAC{}", encode_config(&config))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn fnv1a_produces_8_hex_chars() {
        let hash = fnv1a("hello world");
        assert_eq!(hash.len(), 8);
        assert!(hash.chars().all(|c| c.is_ascii_hexdigit()));
    }

    #[test]
    fn fnv1a_deterministic() {
        assert_eq!(fnv1a("test"), fnv1a("test"));
        assert_ne!(fnv1a("test"), fnv1a("test2"));
    }

    #[test]
    fn solve_pow_with_easy_difficulty() {
        let result = solve_pow("test_seed", "ffff");
        assert!(result.is_ok());
        let token = result.unwrap();
        assert!(token.starts_with("gAAAAAB"));
        assert!(token.ends_with("~S"));
    }

    #[test]
    fn make_app_attest_format() {
        let attest = make_app_attest();
        assert!(attest.starts_with("gAAAAAC"));
    }
}
