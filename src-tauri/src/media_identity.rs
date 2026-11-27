//! Streaming primitives for future media storage consumers; existing callers stay unchanged.
use base64::{Engine, engine::general_purpose::STANDARD};
use ring::digest::{Context, SHA256};
use serde::Serialize;
use serde_json::Value;

const BLOCK: usize = 12_288;
const CRC_TABLE: [u32; 256] = crc_table();

const fn crc_table() -> [u32; 256] {
    let mut table = [0; 256];
    let mut index = 0;
    while index < 256 {
        let mut value = index as u32;
        let mut bit = 0;
        while bit < 8 {
            value = if value & 1 == 1 {
                0xedb88320 ^ (value >> 1)
            } else {
                value >> 1
            };
            bit += 1;
        }
        table[index] = value;
        index += 1;
    }
    table
}

#[derive(Default)]
struct Base64Stream {
    pending: Vec<u8>,
}

impl Base64Stream {
    fn update(&mut self, mut bytes: &[u8], emit: &mut dyn FnMut(&[u8])) {
        if !self.pending.is_empty() {
            let count = (3 - self.pending.len()).min(bytes.len());
            self.pending.extend_from_slice(&bytes[..count]);
            bytes = &bytes[count..];
            if self.pending.len() < 3 {
                return;
            }
            emit(STANDARD.encode(&self.pending).as_bytes());
            self.pending.clear();
        }
        let end = bytes.len() - bytes.len() % 3;
        for block in bytes[..end].chunks(BLOCK) {
            emit(STANDARD.encode(block).as_bytes());
        }
        self.pending.extend_from_slice(&bytes[end..]);
    }

    fn finish(self, emit: &mut dyn FnMut(&[u8])) {
        if !self.pending.is_empty() {
            emit(STANDARD.encode(&self.pending).as_bytes());
        }
    }
}

fn hex(context: Context) -> String {
    context
        .finish()
        .as_ref()
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect()
}

#[derive(Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct MediaIdentityResult {
    pub raw: String,
    pub crc: u32,
    pub blob_id: String,
    pub asset_hash: String,
}

pub(crate) struct MediaIdentity {
    raw: Context,
    crc: u32,
    blob: Context,
    asset: Context,
    base64: Base64Stream,
    length: u64,
}

impl MediaIdentity {
    pub(crate) fn new(game_id: &str, mime: &str) -> Self {
        let mut blob = Context::new(&SHA256);
        let mut asset = Context::new(&SHA256);
        let prefix = serde_json::to_string(&format!("data:{mime};base64,")).unwrap();
        let prefix = &prefix[..prefix.len() - 1];
        blob.update(format!("[{},{}", serde_json::to_string(game_id).unwrap(), prefix).as_bytes());
        asset.update(prefix.as_bytes());
        Self {
            raw: Context::new(&SHA256),
            crc: 0xffffffff,
            blob,
            asset,
            base64: Base64Stream::default(),
            length: 0,
        }
    }

    pub(crate) fn update(&mut self, bytes: &[u8]) -> Result<(), String> {
        self.length = self
            .length
            .checked_add(bytes.len() as u64)
            .filter(|length| *length < 1u64 << 61)
            .ok_or("SHA-256 length out of range")?;
        self.raw.update(bytes);
        for byte in bytes {
            self.crc = CRC_TABLE[((self.crc ^ u32::from(*byte)) & 255) as usize] ^ (self.crc >> 8);
        }
        let Self {
            base64,
            blob,
            asset,
            ..
        } = self;
        base64.update(bytes, &mut |encoded| {
            blob.update(encoded);
            asset.update(encoded);
        });
        Ok(())
    }

    pub(crate) fn digest(mut self) -> MediaIdentityResult {
        self.base64.finish(&mut |encoded| {
            self.blob.update(encoded);
            self.asset.update(encoded);
        });
        self.blob.update(b"\"]");
        self.asset.update(b"\"");
        MediaIdentityResult {
            raw: hex(self.raw),
            crc: self.crc ^ 0xffffffff,
            blob_id: hex(self.blob),
            asset_hash: hex(self.asset),
        }
    }
}

/// A resolver supplies ordered chunks to the sink, without collecting a whole media value.
type ByteResolver<'a> = dyn FnMut(&str, &mut dyn FnMut(&[u8])) -> Result<(), String> + 'a;

fn json_string(hash: &mut Context, value: &str) {
    hash.update(b"\"");
    let mut start = 0;
    while start < value.len() {
        let mut end = (start + 4096).min(value.len());
        while !value.is_char_boundary(end) {
            end -= 1;
        }
        let encoded = serde_json::to_string(&value[start..end]).unwrap();
        hash.update(&encoded.as_bytes()[1..encoded.len() - 1]);
        start = end;
    }
    hash.update(b"\"");
}

// The resolver sink cannot return errors, so retain the first failure and stop hashing.
struct MediaString<'a> {
    hash: &'a mut Context,
    length: u64,
    result: Result<(), String>,
}

impl MediaString<'_> {
    fn update(&mut self, bytes: &[u8]) {
        if self.result.is_err() {
            return;
        }
        let Some(length) = self
            .length
            .checked_add(bytes.len() as u64)
            .filter(|length| *length < 1u64 << 61)
        else {
            self.result = Err("SHA-256 length out of range".into());
            return;
        };
        self.length = length;
        self.hash.update(bytes);
    }
}

fn media_string(
    hash: &mut Context,
    reference: &str,
    mime: &str,
    resolve: &mut ByteResolver<'_>,
) -> Result<(), String> {
    let mut writer = MediaString {
        hash,
        length: 0,
        result: Ok(()),
    };
    writer.update(b"[\"string\",");
    let prefix = serde_json::to_string(&format!("data:{mime};base64,")).unwrap();
    writer.update(&prefix.as_bytes()[..prefix.len() - 1]);
    let mut base64 = Base64Stream::default();
    resolve(reference, &mut |bytes| {
        base64.update(bytes, &mut |encoded| writer.update(encoded))
    })?;
    base64.finish(&mut |encoded| writer.update(encoded));
    writer.update(b"\"]");
    writer.result
}

fn canonical_object(
    hash: &mut Context,
    value: &serde_json::Map<String, Value>,
    path: &mut Vec<String>,
    resolve: &mut ByteResolver<'_>,
) -> Result<(), String> {
    hash.update(b"[\"object\",[");
    let mut entries: Vec<_> = value.iter().collect();
    entries.sort_by(|(a, _), (b, _)| a.encode_utf16().cmp(b.encode_utf16()));
    for (index, (key, item)) in entries.into_iter().enumerate() {
        hash.update(if index == 0 { b"[" } else { b",[" });
        json_string(hash, key);
        hash.update(b",");
        let reference = item
            .as_str()
            .filter(|text| text.starts_with("helia-asset:"))
            .filter(|_| path.len() == 2 && path[0] == "resources" && key == "data");
        if let Some(reference) = reference {
            let mime = value
                .get("mime")
                .and_then(Value::as_str)
                .ok_or("Release asset MIME unavailable")?;
            media_string(hash, reference, mime, resolve)?;
        } else {
            path.push(key.clone());
            canonical(hash, item, path, resolve)?;
            path.pop();
        }
        hash.update(b"]");
    }
    hash.update(b"]]");
    Ok(())
}

fn canonical(
    hash: &mut Context,
    value: &Value,
    path: &mut Vec<String>,
    resolve: &mut ByteResolver<'_>,
) -> Result<(), String> {
    match value {
        Value::Null => hash.update(b"[\"null\"]"),
        Value::Bool(value) => hash.update(if *value {
            b"[\"boolean\",true]"
        } else {
            b"[\"boolean\",false]"
        }),
        Value::String(value) => {
            hash.update(b"[\"string\",");
            json_string(hash, value);
            hash.update(b"]");
        }
        Value::Number(value) => {
            let number = value
                .as_f64()
                .filter(|n| n.is_finite())
                .ok_or("Non-finite release number")?;
            let bits = if number == 0.0 { 0 } else { number.to_bits() };
            hash.update(format!("[\"number\",\"{bits:016x}\"]").as_bytes());
        }
        Value::Array(values) => {
            hash.update(b"[\"array\",[");
            for (index, item) in values.iter().enumerate() {
                if index != 0 {
                    hash.update(b",");
                }
                path.push(index.to_string());
                canonical(hash, item, path, resolve)?;
                path.pop();
            }
            hash.update(b"]]");
        }
        Value::Object(values) => canonical_object(hash, values, path, resolve)?,
    }
    Ok(())
}

/// Input is the same normalized authored content used by game_releases::content_hash.
pub(crate) fn hash_release_content(
    content: &Value,
    resolve: &mut ByteResolver<'_>,
) -> Result<String, String> {
    let mut hash = Context::new(&SHA256);
    canonical(&mut hash, content, &mut Vec::new(), resolve)?;
    Ok(hex(hash))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn fixture() -> Value {
        serde_json::from_str(include_str!(
            "../../src/lib/storage/fixtures/media-identity.json"
        ))
        .unwrap()
    }

    fn no_references(_: &str, _: &mut dyn FnMut(&[u8])) -> Result<(), String> {
        Err("Unexpected reference".into())
    }

    #[test]
    fn media_identity_shared_fifteen_chunk_combinations() {
        let fixture = fixture();
        let game_id = fixture["gameId"].as_str().unwrap();
        let mime = fixture["mime"].as_str().unwrap();
        for vector in fixture["vectors"].as_array().unwrap() {
            let length = vector["length"].as_u64().unwrap() as usize;
            let bytes: Vec<u8> = (0..length).map(|i| ((i * 37 + 11) % 256) as u8).collect();
            let mut content = fixture["releaseTemplate"].clone();
            content["resources"]["media"]["data"] =
                Value::String(format!("data:{mime};base64,{}", STANDARD.encode(&bytes)));
            assert_eq!(
                hash_release_content(&content, &mut no_references).unwrap(),
                vector["releaseHash"]
            );
            for size in fixture["chunkSizes"].as_array().unwrap() {
                let size = size.as_u64().unwrap() as usize;
                let mut identity = MediaIdentity::new(game_id, mime);
                for chunk in bytes.chunks(size) {
                    identity.update(chunk).unwrap();
                    identity.update(&[]).unwrap();
                }
                let result = serde_json::to_value(identity.digest()).unwrap();
                for key in ["raw", "crc", "blobId", "assetHash"] {
                    assert_eq!(
                        result[key], vector[key],
                        "length={length}, chunk={size}, key={key}"
                    );
                }
                content["resources"]["media"]["data"] =
                    Value::String("helia-asset:fixture-media".into());
                let mut calls = 0;
                let mut supplied = 0;
                let mut resolve = |reference: &str, sink: &mut dyn FnMut(&[u8])| {
                    assert_eq!(reference, "helia-asset:fixture-media");
                    calls += 1;
                    sink(&[]);
                    for chunk in bytes.chunks(size) {
                        sink(chunk);
                        supplied += chunk.len();
                    }
                    Ok(())
                };
                assert_eq!(
                    hash_release_content(&content, &mut resolve).unwrap(),
                    vector["releaseHash"]
                );
                assert_eq!(calls, 1);
                assert_eq!(supplied, length);
            }
        }
    }

    #[test]
    fn media_identity_preserves_existing_release_fixtures() {
        let fixtures: Value = serde_json::from_str(include_str!(
            "../../src/lib/testing/fixtures/game-releases.json"
        ))
        .unwrap();
        for fixture in fixtures.as_array().unwrap() {
            assert_eq!(
                hash_release_content(&fixture["content"], &mut no_references).unwrap(),
                fixture["hash"],
                "{}",
                fixture["name"]
            );
            let mut content = fixture["content"].clone();
            let mut assets = std::collections::HashMap::new();
            if let Some(resources) = content["resources"].as_object_mut() {
                for (id, resource) in resources {
                    let data = resource["data"].as_str().unwrap();
                    let bytes = STANDARD.decode(data.split_once(',').unwrap().1).unwrap();
                    let reference = format!("helia-asset:{id}");
                    assets.insert(reference.clone(), bytes);
                    resource["data"] = Value::String(reference);
                }
            }
            let mut resolve = |reference: &str, sink: &mut dyn FnMut(&[u8])| {
                for chunk in assets.get(reference).ok_or("Missing asset")?.chunks(7) {
                    sink(chunk);
                }
                Ok(())
            };
            assert_eq!(
                hash_release_content(&content, &mut resolve).unwrap(),
                fixture["hash"]
            );
        }
    }

    #[test]
    fn media_identity_crc_and_length_bound() {
        let mut identity = MediaIdentity::new("game", "image/png");
        identity.update(b"123456789").unwrap();
        assert_eq!(identity.digest().crc, 0xcbf43926);
        let mut identity = MediaIdentity::new("game", "image/png");
        // Exercise the checked counter without allocating a multi-GiB buffer.
        identity.length = 0xffffffff;
        identity.update(b"ab").unwrap();
        assert_eq!(identity.length, 0x100000001);
        identity.length = (1u64 << 61) - 1;
        assert!(identity.update(b"x").is_err());
    }

    #[test]
    fn media_identity_release_media_length_bound() {
        let mut hash = Context::new(&SHA256);
        let mut writer = MediaString {
            hash: &mut hash,
            length: 0xffffffff,
            result: Ok(()),
        };
        writer.update(b"ab");
        assert_eq!(writer.length, 0x100000001);
        assert!(writer.result.is_ok());
        writer.length = (1u64 << 61) - 2;
        writer.update(b"x");
        writer.update(b"");
        assert!(writer.result.is_ok());
        writer.update(b"y");
        assert_eq!(writer.result, Err("SHA-256 length out of range".into()));
        writer.update(b"ignored after error");
        assert_eq!(writer.length, (1u64 << 61) - 1);
        assert_eq!(
            hex(hash),
            hex({
                let mut expected = Context::new(&SHA256);
                expected.update(b"abx");
                expected
            })
        );
    }

    #[test]
    fn media_identity_copies_tails_and_bounds_base64_output() {
        let mut stream = Base64Stream::default();
        let mut encoded = Vec::new();
        let mut emit = |part: &[u8]| {
            assert!(part.len() <= 16_384);
            encoded.extend_from_slice(part);
        };
        let mut bytes = [1, 2];
        stream.update(&bytes, &mut emit);
        bytes.fill(0);
        stream.update(&vec![3; 100_000], &mut emit);
        stream.finish(&mut emit);
        let mut expected = vec![1, 2];
        expected.extend_from_slice(&vec![3; 100_000]);
        assert_eq!(encoded, STANDARD.encode(expected).as_bytes());
    }

    #[test]
    fn media_identity_supplier_errors_propagate() {
        let mut content = fixture()["releaseTemplate"].clone();
        content["resources"]["media"]["data"] = Value::String("helia-asset:missing".into());
        assert_eq!(
            hash_release_content(&content, &mut no_references).unwrap_err(),
            "Unexpected reference"
        );
    }
}
