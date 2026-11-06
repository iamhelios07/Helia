//! Bounded binary entries keep service-account JSON inside OS stores with small per-entry limits.
use ring::digest::{SHA256, digest};
use serde::{Deserialize, Serialize};

const CHUNK: usize = 2000;
const LIMIT: usize = 128 * 1024;
const ERROR: &str = "OS 자격 증명 저장소를 읽거나 저장하지 못했어요.";
pub(crate) trait Entries {
    fn get(&self, id: &str) -> Result<Option<Vec<u8>>, String>;
    fn put(&self, id: &str, value: &[u8]) -> Result<(), String>;
    fn delete(&self, id: &str) -> Result<(), String>;
}
#[derive(Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
struct Manifest {
    generation: String,
    chunks: usize,
    length: usize,
    hash: Vec<u8>,
}
fn manifest(store: &impl Entries, id: &str) -> Result<Option<Manifest>, String> {
    let Some(bytes) = store.get(id)? else {
        return Ok(None);
    };
    if bytes.len() > 2048 {
        return Err(ERROR.into());
    }
    let manifest: Manifest = serde_json::from_slice(&bytes).map_err(|_| ERROR)?;
    if manifest.generation.len() != 32
        || !manifest.generation.bytes().all(|b| b.is_ascii_hexdigit())
        || manifest.length == 0
        || manifest.length > LIMIT
        || manifest.chunks != manifest.length.div_ceil(CHUNK)
        || manifest.hash.len() != 32
    {
        return Err(ERROR.into());
    }
    Ok(Some(manifest))
}
fn part(id: &str, generation: &str, index: usize) -> String {
    format!("{id}:{generation}:{index}")
}
fn clean(store: &impl Entries, id: &str, manifest: &Manifest) -> Result<(), String> {
    for index in 0..manifest.chunks {
        store.delete(&part(id, &manifest.generation, index))?;
    }
    Ok(())
}
pub(crate) fn read(store: &impl Entries, id: &str) -> Result<Option<Vec<u8>>, String> {
    let Some(manifest) = manifest(store, id)? else {
        return Ok(None);
    };
    let mut bytes = Vec::with_capacity(manifest.length);
    for index in 0..manifest.chunks {
        let chunk = store
            .get(&part(id, &manifest.generation, index))?
            .ok_or(ERROR)?;
        if chunk.len() != CHUNK.min(manifest.length - index * CHUNK) {
            return Err(ERROR.into());
        }
        bytes.extend(chunk);
    }
    if digest(&SHA256, &bytes).as_ref() != manifest.hash {
        return Err(ERROR.into());
    }
    Ok(Some(bytes))
}
pub(crate) fn write(store: &impl Entries, id: &str, bytes: &[u8]) -> Result<(), String> {
    if bytes.is_empty() || bytes.len() > LIMIT {
        return Err(ERROR.into());
    }
    let old = manifest(store, id)?;
    let mut generation = [0; 16];
    getrandom::fill(&mut generation).map_err(|_| ERROR)?;
    let generation = generation
        .iter()
        .map(|b| format!("{b:02x}"))
        .collect::<String>();
    let new = Manifest {
        generation,
        chunks: bytes.len().div_ceil(CHUNK),
        length: bytes.len(),
        hash: digest(&SHA256, bytes).as_ref().to_vec(),
    };
    for (index, chunk) in bytes.chunks(CHUNK).enumerate() {
        if let Err(error) = store.put(&part(id, &new.generation, index), chunk) {
            let _ = clean(store, id, &new);
            return Err(error);
        }
    }
    let encoded = serde_json::to_vec(&new).map_err(|_| ERROR)?;
    if let Err(error) = store.put(id, &encoded) {
        if store.get(id)?.as_deref() != Some(encoded.as_slice()) {
            let _ = clean(store, id, &new);
            return Err(error);
        }
    }
    if let Some(old) = old {
        let _ = clean(store, id, &old);
    }
    Ok(())
}
pub(crate) fn delete(store: &impl Entries, id: &str) -> Result<(), String> {
    if let Some(manifest) = manifest(store, id)? {
        clean(store, id, &manifest)?;
    }
    store.delete(id)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::{cell::RefCell, collections::HashMap};
    #[derive(Default)]
    struct Memory {
        entries: RefCell<HashMap<String, Vec<u8>>>,
        fail_index: RefCell<bool>,
    }
    impl Entries for Memory {
        fn get(&self, id: &str) -> Result<Option<Vec<u8>>, String> {
            Ok(self.entries.borrow().get(id).cloned())
        }
        fn put(&self, id: &str, bytes: &[u8]) -> Result<(), String> {
            assert!(bytes.len() <= CHUNK);
            if *self.fail_index.borrow() && id == "connection" {
                return Err("injected failure".into());
            }
            self.entries.borrow_mut().insert(id.into(), bytes.to_vec());
            Ok(())
        }
        fn delete(&self, id: &str) -> Result<(), String> {
            self.entries.borrow_mut().remove(id);
            Ok(())
        }
    }
    #[test]
    fn large_credentials_roundtrip_and_failed_replacement_preserves_the_active_generation() {
        let store = Memory::default();
        let original = vec![42; 12000];
        write(&store, "connection", &original).unwrap();
        assert_eq!(read(&store, "connection").unwrap().unwrap(), original);
        let entries = store.entries.borrow().len();
        *store.fail_index.borrow_mut() = true;
        assert!(write(&store, "connection", &vec![51; 20000]).is_err());
        assert_eq!(read(&store, "connection").unwrap().unwrap(), original);
        assert_eq!(store.entries.borrow().len(), entries);
        *store.fail_index.borrow_mut() = false;
        write(&store, "connection", &[7; 5000]).unwrap();
        assert_eq!(read(&store, "connection").unwrap().unwrap(), vec![7; 5000]);
        delete(&store, "connection").unwrap();
        assert!(store.entries.borrow().is_empty());
    }
    #[test]
    fn rejects_missing_or_modified_secret_chunks() {
        let store = Memory::default();
        write(&store, "connection", &[7; 5000]).unwrap();
        let manifest = manifest(&store, "connection").unwrap().unwrap();
        store
            .entries
            .borrow_mut()
            .get_mut(&part("connection", &manifest.generation, 0))
            .unwrap()[0] = 8;
        assert!(read(&store, "connection").is_err());
        store
            .entries
            .borrow_mut()
            .remove(&part("connection", &manifest.generation, 1));
        assert!(read(&store, "connection").is_err());
    }
}
