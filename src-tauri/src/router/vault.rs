//! Router logins kept in Windows Credential Manager, protected by the user's Windows account —
//! never in DelphEye's own files.

use windows::Win32::Foundation::FILETIME;
use windows::Win32::Security::Credentials::{CRED_PERSIST_LOCAL_MACHINE, CRED_TYPE_GENERIC, CREDENTIALW, CredDeleteW, CredFree, CredReadW, CredWriteW};
use windows::core::{HSTRING, PWSTR};

fn target(host: &str) -> String {
    format!("DelphEye/router/{host}")
}

pub fn save(host: &str, user: &str, password: &str) -> Result<(), String> {
    let mut name: Vec<u16> = target(host).encode_utf16().chain([0]).collect();
    let mut user_w: Vec<u16> = user.encode_utf16().chain([0]).collect();
    let mut blob: Vec<u8> = password.encode_utf16().flat_map(|u| u.to_le_bytes()).collect();
    let cred = CREDENTIALW {
        Type: CRED_TYPE_GENERIC,
        TargetName: PWSTR(name.as_mut_ptr()),
        CredentialBlobSize: blob.len() as u32,
        CredentialBlob: blob.as_mut_ptr(),
        Persist: CRED_PERSIST_LOCAL_MACHINE,
        UserName: PWSTR(user_w.as_mut_ptr()),
        LastWritten: FILETIME::default(),
        ..Default::default()
    };
    // SAFETY: every pointer in `cred` points into a buffer that outlives the call.
    let result = unsafe { CredWriteW(&cred, 0) }.map_err(|e| e.to_string());
    blob.iter_mut().for_each(|b| *b = 0);
    result
}

pub fn load(host: &str) -> Option<(String, String)> {
    // SAFETY: the returned credential is read within its reported sizes and freed.
    unsafe {
        let mut cred: *mut CREDENTIALW = std::ptr::null_mut();
        CredReadW(&HSTRING::from(target(host)), CRED_TYPE_GENERIC, None, &mut cred).ok()?;
        let c = &*cred;
        let user = if c.UserName.is_null() { String::new() } else { c.UserName.to_string().unwrap_or_default() };
        let bytes = std::slice::from_raw_parts(c.CredentialBlob, c.CredentialBlobSize as usize);
        let units: Vec<u16> = bytes.chunks_exact(2).map(|p| u16::from_le_bytes([p[0], p[1]])).collect();
        let password = String::from_utf16_lossy(&units);
        CredFree(cred as *const _);
        Some((user, password))
    }
}

pub fn exists(host: &str) -> bool {
    load(host).is_some()
}

pub fn forget(host: &str) {
    // SAFETY: plain call with a valid string.
    let _ = unsafe { CredDeleteW(&HSTRING::from(target(host)), CRED_TYPE_GENERIC, None) };
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn round_trip_in_credential_manager() {
        let host = "test.invalid";
        save(host, "admin", "пароль-123").unwrap();
        assert_eq!(load(host), Some(("admin".into(), "пароль-123".into())));
        forget(host);
        assert!(!exists(host));
    }
}
