//! Binary-safe protection against credentials reflected by an external endpoint.
pub(crate) struct SecretResponseGuard {
    pending: Vec<u8>,
    patterns: Vec<Vec<u8>>,
    hold: usize,
}
fn uri_component(value: &str) -> String {
    value
        .as_bytes()
        .iter()
        .map(|byte| {
            if byte.is_ascii_alphanumeric() || b"-_.!~*'()".contains(byte) {
                (*byte as char).to_string()
            } else {
                format!("%{byte:02X}")
            }
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn blocks_split_reflections_and_preserves_binary_data() {
        let mut guard = SecretResponseGuard::new(vec!["private-game-key".into()]);
        assert!(guard.push(b"safe private-", false).unwrap().is_empty());
        assert!(guard.push(b"game-key", false).is_err());
        let mut safe = SecretResponseGuard::new(vec!["private-game-key".into()]);
        let bytes = [0, 255, 254, 12, 13, 0, 10];
        let mut result = safe.push(&bytes, false).unwrap();
        result.extend(safe.push(&[], true).unwrap());
        assert_eq!(result, bytes);
        assert!(safe.header("private-game-key").is_err());
    }
}
impl SecretResponseGuard {
    pub fn new(values: Vec<String>) -> Self {
        let mut patterns = Vec::new();
        for value in values {
            let escaped = serde_json::to_string(&value).unwrap_or_default();
            patterns.push(value.as_bytes().to_vec());
            patterns.push(escaped[1..escaped.len() - 1].as_bytes().to_vec());
            patterns.push(uri_component(&value).into_bytes());
        }
        patterns.retain(|pattern| !pattern.is_empty());
        let hold = patterns
            .iter()
            .map(|pattern| pattern.len() - 1)
            .max()
            .unwrap_or(0);
        Self {
            pending: Vec::new(),
            patterns,
            hold,
        }
    }
    pub fn push(&mut self, bytes: &[u8], final_chunk: bool) -> Result<Vec<u8>, String> {
        self.pending.extend_from_slice(bytes);
        if self.patterns.iter().any(|pattern| {
            self.pending
                .windows(pattern.len())
                .any(|part| part == pattern)
        }) {
            return Err("Fetch failed".into());
        }
        let end = if final_chunk {
            self.pending.len()
        } else {
            self.pending.len().saturating_sub(self.hold)
        };
        Ok(self.pending.drain(..end).collect())
    }
    pub fn header(&self, value: &str) -> Result<(), String> {
        if self.patterns.iter().any(|pattern| {
            value
                .as_bytes()
                .windows(pattern.len())
                .any(|part| part == pattern)
        }) {
            return Err("Fetch failed".into());
        }
        Ok(())
    }
}
