//! Reading the root certificates stored in the registry, to see who was added.

use windows::Win32::Security::Cryptography::{
    CERT_NAME_SIMPLE_DISPLAY_TYPE, CertCreateCertificateContext, CertFreeCertificateContext, CertGetNameStringW, PKCS_7_ASN_ENCODING,
    X509_ASN_ENCODING,
};
use winreg::RegKey;
use winreg::enums::{HKEY_CURRENT_USER, HKEY_LOCAL_MACHINE};

/// The property inside a stored certificate blob that holds the certificate itself.
const CERT_PROPERTY: u32 = 32;

/// Pulls the DER certificate out of a registry `Blob`: a list of (id, reserved, length, data)
/// properties, of which one holds the certificate.
pub fn certificate_from_blob(blob: &[u8]) -> Option<&[u8]> {
    let mut at = 0usize;
    while at + 12 <= blob.len() {
        let field = |offset: usize| u32::from_le_bytes(blob[at + offset..at + offset + 4].try_into().unwrap());
        let (id, len) = (field(0), field(8) as usize);
        let data = blob.get(at + 12..at + 12 + len)?;
        if id == CERT_PROPERTY {
            return Some(data);
        }
        at += 12 + len;
    }
    None
}

fn subject(der: &[u8]) -> Option<String> {
    // SAFETY: the context is created from a buffer that outlives it, used only here, and freed.
    unsafe {
        let context = CertCreateCertificateContext(X509_ASN_ENCODING | PKCS_7_ASN_ENCODING, der);
        if context.is_null() {
            return None;
        }
        let mut name = [0u16; 512];
        let len = CertGetNameStringW(context, CERT_NAME_SIMPLE_DISPLAY_TYPE, 0, None, Some(&mut name));
        let _ = CertFreeCertificateContext(Some(context));
        (len > 1).then(|| String::from_utf16_lossy(&name[..len as usize - 1]))
    }
}

/// (thumbprint, subject) of every certificate in the machine's or this user's Root store.
pub fn roots(machine: bool) -> Vec<(String, String)> {
    let (hive, path) = if machine {
        (HKEY_LOCAL_MACHINE, r"SOFTWARE\Microsoft\SystemCertificates\Root\Certificates")
    } else {
        (HKEY_CURRENT_USER, r"Software\Microsoft\SystemCertificates\Root\Certificates")
    };
    let Ok(store) = RegKey::predef(hive).open_subkey(path) else { return Vec::new() };
    store
        .enum_keys()
        .flatten()
        .filter_map(|thumbprint| {
            let blob = store.open_subkey(&thumbprint).ok()?.get_raw_value("Blob").ok()?;
            let name = certificate_from_blob(&blob.bytes).and_then(subject)?;
            Some((thumbprint, name))
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_certificate_is_found_among_other_properties() {
        let mut blob = Vec::new();
        for (id, data) in [(3u32, &b"hash-bytes"[..]), (CERT_PROPERTY, &b"DER!"[..])] {
            blob.extend(id.to_le_bytes());
            blob.extend(1u32.to_le_bytes());
            blob.extend((data.len() as u32).to_le_bytes());
            blob.extend(data);
        }
        assert_eq!(certificate_from_blob(&blob), Some(&b"DER!"[..]));
        assert_eq!(certificate_from_blob(&blob[..20]), None, "cut short");
    }

    #[test]
    fn this_machine_has_microsoft_roots() {
        let roots = roots(true);
        assert!(roots.iter().any(|(_, name)| name.contains("Microsoft")), "{roots:?}");
    }
}
