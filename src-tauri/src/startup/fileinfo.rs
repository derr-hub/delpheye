//! What a program file says about itself: who made it, what it is, and whether it is signed.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::Mutex;

use windows::Win32::Foundation::{HANDLE, HWND};
use windows::Win32::Security::WinTrust::{
    WINTRUST_ACTION_GENERIC_VERIFY_V2, WINTRUST_DATA, WINTRUST_FILE_INFO, WTD_CACHE_ONLY_URL_RETRIEVAL,
    WTD_CHOICE_FILE, WTD_REVOKE_NONE, WTD_STATEACTION_CLOSE, WTD_STATEACTION_VERIFY, WTD_UI_NONE, WinVerifyTrust,
};
use windows::Win32::Storage::FileSystem::{GetFileVersionInfoSizeW, GetFileVersionInfoW, VerQueryValueW};
use windows::Win32::System::Com::{CLSCTX_INPROC_SERVER, COINIT_APARTMENTTHREADED, CoCreateInstance, CoInitializeEx, IPersistFile, STGM_READ};
use windows::Win32::UI::Shell::{IShellLinkW, ShellLink};
use windows::core::{HSTRING, Interface, PCWSTR};

#[derive(Clone, Debug, Default)]
pub struct FileFacts {
    pub exists: bool,
    pub company: Option<String>,
    pub description: Option<String>,
    /// `None` when not checked (files that ship with Windows are signed through catalogs instead).
    pub signed: Option<bool>,
}

/// Facts already looked up, kept between lists so a re-list after a change is instant.
static CACHE: Mutex<Option<HashMap<PathBuf, FileFacts>>> = Mutex::new(None);

pub fn inspect(path: &Path, check_signature: bool) -> FileFacts {
    // Copied out in its own statement so the lock is released here: the branch below locks
    // the cache again, and holding it across that would deadlock the thread on itself.
    let cached = CACHE.lock().unwrap().get_or_insert_with(HashMap::new).get(path).cloned();
    if let Some(facts) = cached {
        // Looked up earlier without the (slower) signature check: add it now if asked for.
        if check_signature && facts.exists && facts.signed.is_none() {
            let facts = FileFacts { signed: Some(is_signed(path)), ..facts };
            CACHE.lock().unwrap().get_or_insert_with(HashMap::new).insert(path.to_path_buf(), facts.clone());
            return facts;
        }
        return facts;
    }
    let exists = path.is_file();
    let (company, description) = if exists { version_strings(path) } else { (None, None) };
    let facts = FileFacts { exists, company, description, signed: (exists && check_signature).then(|| is_signed(path)) };
    CACHE.lock().unwrap().get_or_insert_with(HashMap::new).insert(path.to_path_buf(), facts.clone());
    facts
}

/// `CompanyName` and `FileDescription` from the file's version resource.
fn version_strings(path: &Path) -> (Option<String>, Option<String>) {
    let name = HSTRING::from(path.as_os_str());
    // SAFETY: the buffer is sized by the API itself and outlives every pointer into it;
    // `VerQueryValueW` only hands back pointers inside that buffer, with their length.
    unsafe {
        let size = GetFileVersionInfoSizeW(&name, None);
        if size == 0 {
            return (None, None);
        }
        let mut block = vec![0u8; size as usize];
        if GetFileVersionInfoW(&name, Some(0), size, block.as_mut_ptr().cast()).is_err() {
            return (None, None);
        }
        let query = |sub: &str| -> Option<String> {
            let mut ptr = std::ptr::null_mut();
            let mut len = 0u32;
            let sub = HSTRING::from(sub);
            if !VerQueryValueW(block.as_ptr().cast(), &sub, &mut ptr, &mut len).as_bool() || len == 0 {
                return None;
            }
            let units = std::slice::from_raw_parts(ptr as *const u16, len as usize);
            let text = String::from_utf16_lossy(units.split(|&u| u == 0).next().unwrap_or(&[]));
            let text = text.trim().to_string();
            (!text.is_empty()).then_some(text)
        };
        // The language the file declares first, then the usual English fallbacks.
        let mut tables = Vec::new();
        let mut ptr = std::ptr::null_mut();
        let mut len = 0u32;
        if VerQueryValueW(block.as_ptr().cast(), &HSTRING::from(r"\VarFileInfo\Translation"), &mut ptr, &mut len).as_bool() && len >= 4 {
            let pair = std::slice::from_raw_parts(ptr as *const u16, 2);
            tables.push(format!("{:04x}{:04x}", pair[0], pair[1]));
        }
        tables.extend(["040904b0".to_string(), "040904e4".to_string(), "000004b0".to_string()]);
        let field = |key: &str| tables.iter().find_map(|t| query(&format!(r"\StringFileInfo\{t}\{key}")));
        (field("CompanyName"), field("FileDescription"))
    }
}

/// Whether the file carries a valid embedded Authenticode signature. Works offline.
pub fn is_signed(path: &Path) -> bool {
    let name = HSTRING::from(path.as_os_str());
    let mut file = WINTRUST_FILE_INFO {
        cbStruct: size_of::<WINTRUST_FILE_INFO>() as u32,
        pcwszFilePath: PCWSTR(name.as_ptr()),
        hFile: HANDLE::default(),
        pgKnownSubject: std::ptr::null_mut(),
    };
    let mut data = WINTRUST_DATA {
        cbStruct: size_of::<WINTRUST_DATA>() as u32,
        dwUIChoice: WTD_UI_NONE,
        fdwRevocationChecks: WTD_REVOKE_NONE,
        dwUnionChoice: WTD_CHOICE_FILE,
        dwStateAction: WTD_STATEACTION_VERIFY,
        dwProvFlags: WTD_CACHE_ONLY_URL_RETRIEVAL,
        ..Default::default()
    };
    data.Anonymous.pFile = &mut file;
    let mut action = WINTRUST_ACTION_GENERIC_VERIFY_V2;
    // SAFETY: `data` and `file` (and the path string `file` points to) live across both calls;
    // the second call releases the state the first one allocated.
    unsafe {
        let status = WinVerifyTrust(HWND::default(), &mut action, (&raw mut data).cast());
        data.dwStateAction = WTD_STATEACTION_CLOSE;
        WinVerifyTrust(HWND::default(), &mut action, (&raw mut data).cast());
        status == 0
    }
}

/// The program and arguments a `.lnk` shortcut starts.
pub fn shortcut_target(link: &Path) -> Option<(PathBuf, String)> {
    // SAFETY: COM is initialised for this thread before use; every buffer handed to the
    // shell is a correctly sized, writable slice.
    unsafe {
        let _ = CoInitializeEx(None, COINIT_APARTMENTTHREADED);
        let shell_link: IShellLinkW = CoCreateInstance(&ShellLink, None, CLSCTX_INPROC_SERVER).ok()?;
        shell_link.cast::<IPersistFile>().ok()?.Load(&HSTRING::from(link.as_os_str()), STGM_READ).ok()?;
        let mut path = [0u16; 1024];
        shell_link.GetPath(&mut path, std::ptr::null_mut(), 0).ok()?;
        let mut args = [0u16; 2048];
        let _ = shell_link.GetArguments(&mut args);
        let text = |buf: &[u16]| String::from_utf16_lossy(buf.split(|&u| u == 0).next().unwrap_or(&[]));
        let target = text(&path);
        (!target.is_empty()).then(|| (PathBuf::from(target), text(&args)))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn windows_own_programs_describe_themselves() {
        let notepad = PathBuf::from(std::env::var("SystemRoot").unwrap()).join("System32").join("notepad.exe");
        let facts = inspect(&notepad, false);
        assert!(facts.exists);
        assert!(facts.company.unwrap_or_default().contains("Microsoft"));
        assert_eq!(facts.signed, None, "not checked when not asked");
    }

    #[test]
    fn a_missing_or_unsigned_file_is_reported_as_such() {
        let missing = inspect(Path::new(r"C:\definitely\not\here.exe"), true);
        assert!(!missing.exists && missing.signed.is_none());

        let sandbox = crate::cleanup::testing::Sandbox::new();
        let fake = sandbox.root.join("fake.exe");
        crate::cleanup::testing::write(&fake, 64);
        let facts = inspect(&fake, true);
        assert_eq!((facts.exists, facts.signed, facts.company), (true, Some(false), None));
    }
}
