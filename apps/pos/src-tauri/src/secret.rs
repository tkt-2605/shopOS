/// A secret kept on this machine, sealed to the Windows account that saved it.
///
/// The shop's mail password used to sit in `device.json` as it was typed, so
/// anything that could read that file -- another program, a copy of the
/// folder -- had the shop's mailbox. Windows' Data Protection API (DPAPI)
/// encrypts it with a key only this Windows user on this machine can use, and
/// it needs no key of ours to keep.
///
/// The cost is the right one: `device.json` copied to another PC carries a
/// secret that will not open there, and the shop types it again. A sealed
/// value is stored as `dpapi:` and base64, so a plain one left by an older
/// version is told apart and sealed on the next start.
use base64::Engine;

const PREFIX: &str = "dpapi:";

pub fn is_sealed(value: &str) -> bool {
    value.starts_with(PREFIX)
}

pub fn seal(plain: &str) -> Result<String, String> {
    let bytes = protect(plain.as_bytes())?;
    Ok(format!("{PREFIX}{}", base64::engine::general_purpose::STANDARD.encode(bytes)))
}

pub fn unseal(sealed: &str) -> Result<String, String> {
    let encoded = sealed.strip_prefix(PREFIX).ok_or("not a sealed value")?;
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(encoded)
        .map_err(|e| format!("a sealed value that is not base64: {e}"))?;
    String::from_utf8(unprotect(&bytes)?).map_err(|_| "a sealed value that is not text".to_string())
}

#[cfg(windows)]
fn protect(data: &[u8]) -> Result<Vec<u8>, String> {
    use windows::Win32::Security::Cryptography::{CryptProtectData, CRYPTPROTECT_UI_FORBIDDEN, CRYPT_INTEGER_BLOB};
    let input = CRYPT_INTEGER_BLOB { cbData: data.len() as u32, pbData: data.as_ptr() as *mut u8 };
    let mut output = CRYPT_INTEGER_BLOB::default();
    unsafe {
        CryptProtectData(&input, windows::core::w!("ShopOS"), None, None, None, CRYPTPROTECT_UI_FORBIDDEN, &mut output)
            .map_err(|e| format!("Windows could not seal the secret: {e}"))?;
    }
    Ok(take(output))
}

#[cfg(windows)]
fn unprotect(data: &[u8]) -> Result<Vec<u8>, String> {
    use windows::Win32::Security::Cryptography::{CryptUnprotectData, CRYPTPROTECT_UI_FORBIDDEN, CRYPT_INTEGER_BLOB};
    let input = CRYPT_INTEGER_BLOB { cbData: data.len() as u32, pbData: data.as_ptr() as *mut u8 };
    let mut output = CRYPT_INTEGER_BLOB::default();
    unsafe {
        CryptUnprotectData(&input, None, None, None, None, CRYPTPROTECT_UI_FORBIDDEN, &mut output)
            .map_err(|e| format!("Windows could not open the secret (saved on another PC or account?): {e}"))?;
    }
    Ok(take(output))
}

/// Copies out what Windows allocated, and frees it.
#[cfg(windows)]
fn take(blob: windows::Win32::Security::Cryptography::CRYPT_INTEGER_BLOB) -> Vec<u8> {
    use windows::Win32::Foundation::{LocalFree, HLOCAL};
    if blob.pbData.is_null() {
        return Vec::new();
    }
    let bytes = unsafe { std::slice::from_raw_parts(blob.pbData, blob.cbData as usize) }.to_vec();
    unsafe {
        let _ = LocalFree(Some(HLOCAL(blob.pbData as *mut core::ffi::c_void)));
    }
    bytes
}

/* Elsewhere the till is a test build: kept as it was typed, marked as sealed
   so the round trip is the same shape. */
#[cfg(not(windows))]
fn protect(data: &[u8]) -> Result<Vec<u8>, String> {
    Ok(data.to_vec())
}

#[cfg(not(windows))]
fn unprotect(data: &[u8]) -> Result<Vec<u8>, String> {
    Ok(data.to_vec())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_secret_comes_back_as_it_went_in_and_is_not_kept_as_itself() {
        let sealed = seal("abcd efgh ijkl mnop").unwrap();
        assert!(is_sealed(&sealed));
        #[cfg(windows)]
        assert!(!sealed.contains("abcd"), "{sealed}");
        assert_eq!(unseal(&sealed).unwrap(), "abcd efgh ijkl mnop");
    }

    #[test]
    fn a_plain_value_is_told_apart_from_a_sealed_one() {
        assert!(!is_sealed("abcd efgh ijkl mnop"));
        assert!(unseal("dpapi:not base64!").is_err());
    }
}
