//! A single thing the protection check found.

use serde::Serialize;

pub use super::patterns::Severity;

#[derive(Serialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Finding {
    /// Stable within one scan, used to ask for actions on it.
    pub id: String,
    /// "persistence", "process" or "tamper".
    pub area: &'static str,
    /// What kind of finding, e.g. "ifeo-debugger"; the UI explains each kind.
    pub kind: &'static str,
    /// Why this instance was flagged, when a kind has several possible reasons.
    pub reason: Option<&'static str>,
    pub severity: Severity,
    /// What it is about: a program, a value name, a domain.
    pub title: String,
    /// The evidence as found: a command line, a value, a hosts line.
    pub detail: String,
    /// Where it was found: a registry path, a file, a task.
    pub location: String,
    /// A file involved, for reputation checks, revealing and quarantine.
    pub file: Option<String>,
    /// A running process involved.
    pub pid: Option<u32>,
    /// A registry key that can be safely set aside (exported, then removed) to neutralise it.
    pub key: Option<String>,
}

impl Finding {
    pub fn new(area: &'static str, kind: &'static str, severity: Severity, title: impl Into<String>, detail: impl Into<String>, location: impl Into<String>) -> Self {
        Self {
            id: String::new(),
            area,
            kind,
            reason: None,
            severity,
            title: title.into(),
            detail: detail.into(),
            location: location.into(),
            file: None,
            pid: None,
            key: None,
        }
    }

    pub fn reason(mut self, reason: &'static str) -> Self {
        self.reason = Some(reason);
        self
    }

    pub fn file(mut self, file: Option<String>) -> Self {
        self.file = file;
        self
    }

    pub fn pid(mut self, pid: u32) -> Self {
        self.pid = Some(pid);
        self
    }

    pub fn key(mut self, key: impl Into<String>) -> Self {
        self.key = Some(key.into());
        self
    }
}
