//! The Recycle Bin, which is managed by the shell rather than by walking folders.

use windows::Win32::UI::Shell::{
    SHEmptyRecycleBinW, SHERB_NOCONFIRMATION, SHERB_NOPROGRESSUI, SHERB_NOSOUND, SHQUERYRBINFO,
    SHQueryRecycleBinW,
};
use windows::core::{HSTRING, PCWSTR};

/// Total size in bytes and number of items across every drive's bin.
pub fn query() -> Option<(u64, u64)> {
    query_root(None).or_else(|| {
        // Asking for all drives at once fails on some systems when one drive has no bin;
        // ask each drive separately instead and add up whatever answers.
        let drives: Vec<(u64, u64)> = ('A'..='Z')
            .filter_map(|letter| query_root(Some(&format!("{letter}:\\"))))
            .collect();
        (!drives.is_empty()).then(|| drives.iter().fold((0, 0), |sum, d| (sum.0 + d.0, sum.1 + d.1)))
    })
}

fn query_root(root: Option<&str>) -> Option<(u64, u64)> {
    let mut info = SHQUERYRBINFO {
        cbSize: size_of::<SHQUERYRBINFO>() as u32,
        ..Default::default()
    };
    let root = root.map(HSTRING::from);
    // SAFETY: `info` is a correctly sized, writable struct and the path, when given,
    // is a NUL-terminated wide string that outlives the call.
    let answered = unsafe {
        match &root {
            Some(root) => SHQueryRecycleBinW(root, &mut info),
            None => SHQueryRecycleBinW(PCWSTR::null(), &mut info),
        }
    };
    answered.ok()?;
    Some((info.i64Size.max(0) as u64, info.i64NumItems.max(0) as u64))
}

/// Permanently deletes everything in every drive's bin, without any shell dialogs.
pub fn empty() -> bool {
    let flags = SHERB_NOCONFIRMATION | SHERB_NOPROGRESSUI | SHERB_NOSOUND;
    // SAFETY: a null window and a null root are both documented as valid arguments.
    unsafe { SHEmptyRecycleBinW(None, PCWSTR::null(), flags).is_ok() }
}
