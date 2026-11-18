//! What the wider world knows about a file, by its hash. Only the hash leaves the computer,
//! never the file, and only when the user has switched this on.
//!
//! * Team Cymru's Malware Hash Registry answers over plain DNS whether a hash is known
//!   malware, and what share of antivirus engines detect it.
//! * CIRCL hashlookup answers over HTTPS whether a hash belongs to known software
//!   (operating systems, packages) and whether it is flagged as malicious.
//!
//! Neither needs an account or a key. "Not found" in both means unknown — not dangerous.

use std::fs::File;
use std::io::Read;
use std::path::Path;
use std::time::Duration;

use serde::Serialize;
use sha1::Sha1;
use sha2::{Digest, Sha256};
use windows::Win32::NetworkManagement::Dns::{DNS_QUERY_STANDARD, DNS_RECORDW, DNS_TYPE_TEXT, DnsFree, DnsFreeRecordList, DnsQuery_W};
use windows::core::HSTRING;

/// Files bigger than this are not hashed: it would take long, and malware is rarely huge.
const MAX_BYTES: u64 = 512 * 1024 * 1024;

#[derive(Serialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Hashes {
    pub sha256: String,
    pub sha1: String,
    pub size: u64,
}

pub fn hash(path: &Path) -> Option<Hashes> {
    let mut file = File::open(path).ok()?;
    let size = file.metadata().ok()?.len();
    if size > MAX_BYTES {
        return None;
    }
    let (mut a, mut b) = (Sha256::new(), Sha1::new());
    let mut buffer = vec![0u8; 1 << 20];
    loop {
        let n = file.read(&mut buffer).ok()?;
        if n == 0 {
            break;
        }
        a.update(&buffer[..n]);
        b.update(&buffer[..n]);
    }
    let hex = |bytes: &[u8]| bytes.iter().map(|b| format!("{b:02x}")).collect::<String>();
    Some(Hashes { sha256: hex(&a.finalize()), sha1: hex(&b.finalize()), size })
}

#[derive(Serialize, Clone, Copy, PartialEq, Eq, Debug)]
#[serde(rename_all = "lowercase")]
pub enum Verdict {
    /// Antivirus engines or a malware database know it as malicious.
    Malicious,
    /// Recorded as part of known, legitimate software.
    Known,
    /// Neither: most files are like this, including brand-new legitimate ones.
    Unknown,
    /// The lookup itself failed (offline, blocked).
    Failed,
}

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct Reputation {
    pub path: String,
    pub hashes: Option<Hashes>,
    pub verdict: Verdict,
    /// Share of antivirus engines detecting it, per Team Cymru.
    pub detection_pct: Option<u32>,
    /// When Team Cymru last saw it, unix seconds.
    pub last_seen: Option<i64>,
    /// CIRCL's confidence that it is legitimate, 0–100.
    pub trust: Option<u32>,
    /// Where CIRCL's malicious flag came from, e.g. "malshare.com".
    pub malicious_source: Option<String>,
}

/// Team Cymru answers "<last seen> <detection %>" for known malware, nothing otherwise.
pub fn parse_cymru(answer: &str) -> Option<(i64, u32)> {
    let mut parts = answer.split_whitespace();
    Some((parts.next()?.parse().ok()?, parts.next()?.parse().ok()?))
}

fn txt_lookup(name: &str) -> Result<Option<String>, ()> {
    const NOT_FOUND: u32 = 9003; // DNS_ERROR_RCODE_NAME_ERROR
    const NO_RECORDS: u32 = 9501; // DNS_INFO_NO_RECORDS
    let mut results: *mut DNS_RECORDW = std::ptr::null_mut();
    // SAFETY: the API fills `results` with a list it allocates; it is read, then freed with
    // the matching call. String pointers are read within each record's declared count.
    unsafe {
        let status = DnsQuery_W(&HSTRING::from(name), DNS_TYPE_TEXT, DNS_QUERY_STANDARD, None, (&raw mut results).cast(), None);
        match status.0 {
            0 => {}
            NOT_FOUND | NO_RECORDS => return Ok(None),
            _ => return Err(()),
        }
        let mut text = None;
        let mut record = results;
        while !record.is_null() {
            if (*record).wType == DNS_TYPE_TEXT.0 {
                let txt = &(*record).Data.TXT;
                let strings = std::slice::from_raw_parts(txt.pStringArray.as_ptr(), txt.dwStringCount as usize);
                text = Some(strings.iter().filter_map(|s| s.to_string().ok()).collect::<Vec<_>>().join(" "));
                break;
            }
            record = (*record).pNext;
        }
        DnsFree(Some(results as *const _), DnsFreeRecordList);
        Ok(text)
    }
}

fn circl(sha256: &str) -> Result<Option<serde_json::Value>, ()> {
    let agent: ureq::Agent = ureq::Agent::config_builder()
        .timeout_global(Some(Duration::from_secs(12)))
        .http_status_as_error(false)
        .user_agent("DelphEye")
        .build()
        .into();
    let mut response = agent.get(&format!("https://hashlookup.circl.lu/lookup/sha256/{sha256}")).header("accept", "application/json").call().map_err(|_| ())?;
    match response.status().as_u16() {
        200 => response.body_mut().read_json::<serde_json::Value>().map(Some).map_err(|_| ()),
        404 => Ok(None),
        _ => Err(()),
    }
}

/// Combines the two answers into one verdict.
pub fn judge(cymru: Result<Option<(i64, u32)>, ()>, circl: Result<Option<serde_json::Value>, ()>) -> (Verdict, Option<u32>, Option<i64>, Option<u32>, Option<String>) {
    let (last_seen, detection) = match cymru {
        Ok(Some((seen, pct))) => (Some(seen), Some(pct)),
        _ => (None, None),
    };
    let record = circl.as_ref().ok().and_then(|c| c.as_ref());
    let trust = record.and_then(|r| r["hashlookup:trust"].as_u64()).map(|t| t as u32);
    let malicious_source = record.and_then(|r| r["KnownMalicious"].as_str()).map(str::to_string);
    let verdict = if detection.is_some_and(|d| d >= 10) || malicious_source.is_some() {
        Verdict::Malicious
    } else if trust.is_some_and(|t| t >= 50) {
        Verdict::Known
    } else if cymru.is_err() && circl.is_err() {
        Verdict::Failed
    } else {
        Verdict::Unknown
    };
    (verdict, detection, last_seen, trust, malicious_source)
}

pub fn lookup(path: &Path) -> Reputation {
    match hash(path) {
        Some(hashes) => lookup_hashes(&path.display().to_string(), hashes),
        // Unreadable: often an antivirus holding the file it just caught.
        None => Reputation { path: path.display().to_string(), hashes: None, verdict: Verdict::Failed, detection_pct: None, last_seen: None, trust: None, malicious_source: None },
    }
}

pub fn lookup_hashes(path: &str, hashes: Hashes) -> Reputation {
    let cymru = txt_lookup(&format!("{}.malware.hash.cymru.com", hashes.sha1)).map(|t| t.as_deref().and_then(parse_cymru));
    let (verdict, detection_pct, last_seen, trust, malicious_source) = judge(cymru, circl(&hashes.sha256));
    Reputation { path: path.to_string(), hashes: Some(hashes), verdict, detection_pct, last_seen, trust, malicious_source }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn hashes_match_known_values() {
        let sandbox = crate::cleanup::testing::Sandbox::new();
        let file = sandbox.root.join("abc.txt");
        std::fs::write(&file, b"abc").unwrap();
        let h = hash(&file).unwrap();
        assert_eq!(h.sha256, "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
        assert_eq!(h.sha1, "a9993e364706816aba3e25717850c26c9cd0d89d");
        assert_eq!(h.size, 3);
    }

    #[test]
    fn verdicts_combine_both_sources() {
        assert_eq!(parse_cymru("1794771864 97"), Some((1_794_771_864, 97)));
        assert_eq!(parse_cymru("garbage"), None);
        let known = serde_json::json!({ "hashlookup:trust": 100 });
        let flagged = serde_json::json!({ "hashlookup:trust": 100, "KnownMalicious": "malshare.com" });
        assert_eq!(judge(Ok(Some((1, 97))), Ok(None)).0, Verdict::Malicious);
        assert_eq!(judge(Ok(None), Ok(Some(flagged))).0, Verdict::Malicious);
        assert_eq!(judge(Ok(None), Ok(Some(known))).0, Verdict::Known);
        assert_eq!(judge(Ok(None), Ok(None)).0, Verdict::Unknown);
        assert_eq!(judge(Err(()), Err(())).0, Verdict::Failed);
        assert_eq!(judge(Ok(Some((1, 3))), Ok(None)).0, Verdict::Unknown, "a 3% detection is noise");
    }

    /// Asks the real services about the harmless EICAR antivirus test file by its hashes (the
    /// file itself is never written: an antivirus would grab it). Runs only when asked for:
    /// `cargo test -- --ignored eicar`.
    #[test]
    #[ignore]
    fn eicar_is_recognised_online() {
        let eicar = Hashes {
            sha256: "275a021bbfb6489e54d471899f7db9d1663fc695ec2fe2a2c4538aabf651fd0f".into(),
            sha1: "3395856ce81f2b7382dee72602f798b642f14140".into(),
            size: 68,
        };
        let r = lookup_hashes("eicar.com", eicar);
        assert_eq!(r.verdict, Verdict::Malicious, "{r:?}");
        assert!(r.detection_pct.is_some_and(|d| d > 50), "{r:?}");
        println!("{r:?}");
    }
}
