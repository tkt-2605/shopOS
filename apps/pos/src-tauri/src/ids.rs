/// A random UUIDv4, as text.
///
/// One copy for the two things that need one: the token a transaction is held
/// by, and the id a machine is minted with. They had a copy each, identical
/// except for how they spelled the last slice.
///
/// Not the v7 that database ids use: neither of these is a document, neither
/// gains anything from sorting by time, and for a device id the minting moment
/// is the one thing about a machine that is nobody else's business.
pub fn uuid_v4() -> String {
    let mut b = [0u8; 16];
    getrandom::fill(&mut b).expect("system randomness unavailable");
    b[6] = (b[6] & 0x0f) | 0x40;
    b[8] = (b[8] & 0x3f) | 0x80;

    let hex: String = b.iter().map(|x| format!("{x:02x}")).collect();
    format!(
        "{}-{}-{}-{}-{}",
        &hex[0..8],
        &hex[8..12],
        &hex[12..16],
        &hex[16..20],
        &hex[20..32]
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn is_shaped_like_a_version_four_uuid() {
        for _ in 0..200 {
            let id = uuid_v4();
            assert_eq!(id.len(), 36);
            assert_eq!(&id[14..15], "4", "version nibble");
            assert!(matches!(&id[19..20], "8" | "9" | "a" | "b"), "variant bits: {id}");
        }
        assert_ne!(uuid_v4(), uuid_v4());
    }
}
