/// Thermal printing on Windows.
///
/// A receipt goes to the spooler as RAW bytes, not through a print dialog: the
/// printer driver must not reinterpret ESC/POS command bytes as text. Ported from
/// the previous system's Win32 path, which is known to work on the TVS RP 3200.
#[cfg(windows)]
mod win {
    use std::ffi::OsStr;
    use std::os::windows::ffi::OsStrExt;

    use windows::core::PWSTR;
    use windows::Win32::Graphics::Printing::{
        ClosePrinter, EndDocPrinter, EndPagePrinter, EnumPrintersW, GetDefaultPrinterW,
        OpenPrinterW, StartDocPrinterW, StartPagePrinter, WritePrinter, DOC_INFO_1W,
        PRINTER_ENUM_CONNECTIONS, PRINTER_ENUM_LOCAL, PRINTER_INFO_4W,
    };

    fn wide(s: &str) -> Vec<u16> {
        OsStr::new(s).encode_wide().chain(std::iter::once(0)).collect()
    }

    pub fn default_printer() -> Option<String> {
        let mut len: u32 = 0;
        unsafe { let _ = GetDefaultPrinterW(None, &mut len); }
        if len == 0 {
            return None;
        }
        let mut buf = vec![0u16; len as usize];
        let ok = unsafe { GetDefaultPrinterW(Some(PWSTR(buf.as_mut_ptr())), &mut len) };
        if !ok.as_bool() {
            return None;
        }
        let end = buf.iter().position(|&c| c == 0).unwrap_or(buf.len());
        Some(String::from_utf16_lossy(&buf[..end]))
    }

    pub fn list_printers() -> Vec<String> {
        let flags = PRINTER_ENUM_LOCAL | PRINTER_ENUM_CONNECTIONS;
        let mut needed: u32 = 0;
        let mut returned: u32 = 0;

        unsafe {
            let _ = EnumPrintersW(flags, None, 4, None, &mut needed, &mut returned);
        }
        if needed == 0 {
            return Vec::new();
        }

        let mut buffer = vec![0u8; needed as usize];
        let ok = unsafe {
            EnumPrintersW(flags, None, 4, Some(&mut buffer), &mut needed, &mut returned)
        };
        if ok.is_err() {
            return Vec::new();
        }

        let entries = buffer.as_ptr() as *const PRINTER_INFO_4W;
        (0..returned as usize)
            .filter_map(|i| unsafe {
                let info = &*entries.add(i);
                if info.pPrinterName.is_null() { None } else { info.pPrinterName.to_string().ok() }
            })
            .collect()
    }

    pub fn print_raw(printer: Option<&str>, bytes: &[u8]) -> Result<(), String> {
        let name = match printer {
            Some(p) if !p.is_empty() => p.to_string(),
            _ => default_printer().ok_or("No default printer is set in Windows")?,
        };

        let mut name_w = wide(&name);
        let mut handle = Default::default();

        unsafe {
            OpenPrinterW(PWSTR(name_w.as_mut_ptr()), &mut handle, None)
                .map_err(|e| format!("Could not open printer \"{name}\": {e}"))?;
        }

        let mut doc_name = wide("ShopOS receipt");
        let mut datatype = wide("RAW");
        let info = DOC_INFO_1W {
            pDocName: PWSTR(doc_name.as_mut_ptr()),
            pOutputFile: PWSTR::null(),
            pDatatype: PWSTR(datatype.as_mut_ptr()),
        };

        let result = unsafe {
            let job = StartDocPrinterW(handle, 1, &info);
            if job == 0 {
                Err("The printer refused the job".to_string())
            } else {
                let mut written: u32 = 0;
                let started = StartPagePrinter(handle).as_bool();
                let wrote = WritePrinter(
                    handle,
                    bytes.as_ptr() as *const _,
                    bytes.len() as u32,
                    &mut written,
                )
                .as_bool();
                let _ = EndPagePrinter(handle);
                let _ = EndDocPrinter(handle);

                if !started || !wrote || written as usize != bytes.len() {
                    Err("The receipt was only partly sent to the printer".to_string())
                } else {
                    Ok(())
                }
            }
        };

        unsafe { let _ = ClosePrinter(handle); }
        result
    }
}

#[cfg(not(windows))]
mod win {
    pub fn default_printer() -> Option<String> { None }
    pub fn list_printers() -> Vec<String> { Vec::new() }
    pub fn print_raw(_printer: Option<&str>, _bytes: &[u8]) -> Result<(), String> {
        Err("Thermal printing is only implemented on Windows".into())
    }
}

#[tauri::command]
pub fn list_printers() -> Vec<String> {
    win::list_printers()
}

#[tauri::command]
pub fn default_printer() -> Option<String> {
    win::default_printer()
}

/// `bytes` arrives as a plain number array from the webview — the receipt is
/// already encoded there, so nothing reinterprets it on the way through.
#[tauri::command]
pub fn print_receipt(printer: Option<String>, bytes: Vec<u8>) -> Result<(), String> {
    if bytes.is_empty() {
        return Err("Nothing to print".into());
    }
    win::print_raw(printer.as_deref(), &bytes)
}
