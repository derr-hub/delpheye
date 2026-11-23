//! Has a password appeared in a leak? The password never leaves the computer: its SHA-1 is
//! computed here and only the first five characters of that hash go to Have I Been Pwned
//! ("k-anonymity"); the service answers with every leaked hash starting the same way, and the
//! match is looked for here. Also a local estimate of how hard the password is to guess.

use std::time::Duration;

use serde::Serialize;
use sha1::Digest;

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct Check {
    /// Times seen in leaks; None when the service could not be reached.
    pub leaked: Option<u64>,
    /// 0 (guessed at once) … 4 (very strong).
    pub strength: u8,
    /// What weakens it, as codes for the interface.
    pub weak: Vec<&'static str>,
}

const COMMON: [&str; 24] = [
    "password", "qwerty", "123456", "111111", "abc123", "iloveyou", "admin", "welcome", "monkey", "dragon", "letmein", "football", "parol", "parol123", "qwertyuiop",
    "1q2w3e", "zaq12wsx", "asdfgh", "000000", "123123", "666666", "ukraine", "slava", "kyiv",
];

/// A local guess at strength: length and variety, minus common words, repeats and sequences.
pub fn strength(p: &str) -> (u8, Vec<&'static str>) {
    let mut weak = Vec::new();
    let len = p.chars().count();
    let classes = [p.chars().any(|c| c.is_lowercase()), p.chars().any(|c| c.is_uppercase()), p.chars().any(|c| c.is_ascii_digit()), p.chars().any(|c| !c.is_alphanumeric())]
        .iter()
        .filter(|x| **x)
        .count();
    if len < 12 {
        weak.push("short");
    }
    if classes < 3 {
        weak.push("plain");
    }
    let lower = p.to_lowercase();
    if COMMON.iter().any(|w| lower.contains(w)) {
        weak.push("common");
    }
    let chars: Vec<char> = lower.chars().collect();
    if chars.windows(3).any(|w| w[0] == w[1] && w[1] == w[2]) {
        weak.push("repeats");
    }
    if chars.windows(4).any(|w| w.windows(2).all(|x| x[1] as i32 - x[0] as i32 == 1)) {
        weak.push("sequence");
    }
    let mut score: i32 = match len {
        0..=7 => 0,
        8..=11 => 1,
        12..=15 => 2,
        16..=19 => 3,
        _ => 4,
    };
    if classes >= 3 {
        score += 1;
    }
    score -= weak.iter().filter(|w| **w != "short" && **w != "plain").count() as i32 * 2;
    (score.clamp(0, 4) as u8, weak)
}

fn hex_upper(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02X}")).collect()
}

/// Looks the password up by the first five characters of its hash.
fn leaked(password: &str) -> Option<u64> {
    let hash = hex_upper(&sha1::Sha1::digest(password.as_bytes()));
    let (prefix, suffix) = hash.split_at(5);
    let agent: ureq::Agent = ureq::Agent::config_builder().timeout_global(Some(Duration::from_secs(10))).build().into();
    // Padding makes every answer the same size, so the prefix is not given away by length.
    let text = agent.get(&format!("https://api.pwnedpasswords.com/range/{prefix}")).header("Add-Padding", "true").call().ok()?.body_mut().read_to_string().ok()?;
    Some(count_in(&text, suffix))
}

pub fn count_in(text: &str, suffix: &str) -> u64 {
    text.lines().find_map(|l| l.trim().split_once(':').filter(|(s, _)| s.eq_ignore_ascii_case(suffix)).and_then(|(_, n)| n.trim().parse().ok())).unwrap_or(0)
}

#[tauri::command]
pub async fn password_check(password: String) -> Result<Check, String> {
    if password.is_empty() {
        return Err("empty".into());
    }
    tauri::async_runtime::spawn_blocking(move || {
        let (strength, weak) = strength(&password);
        Check { leaked: leaked(&password), strength, weak }
    })
    .await
    .map_err(|e| e.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn strength_and_lookup() {
        assert_eq!(strength("password1").0, 0);
        assert!(strength("qwerty123").1.contains(&"common"));
        assert!(strength("Tr4m-Lamp-Oc3an-Fig!").0 >= 4);
        assert!(strength("abcd").1.contains(&"sequence"));
        // "password" → SHA-1 5BAA61E4C9B93F3F0682250B6CF8331B7EE68FD8
        assert_eq!(hex_upper(&sha1::Sha1::digest(b"password")), "5BAA61E4C9B93F3F0682250B6CF8331B7EE68FD8");
        let answer = "1E4C9B93F3F0682250B6CF8331B7EE68FD8:52256179\r\n0018A45C4D1DEF81644B54AB7F969B88D65:0\r\n";
        assert_eq!(count_in(answer, "1E4C9B93F3F0682250B6CF8331B7EE68FD8"), 52256179);
        assert_eq!(count_in(answer, "FFFF"), 0);
    }
}
