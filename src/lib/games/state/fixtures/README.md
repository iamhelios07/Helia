# Content fingerprint compatibility vectors

`content-hash.json` fixes canonical JSON text, its UTF-8 bytes, the old UTF-16/FNV
fingerprint and the new SHA-256 fingerprint. Node `crypto.createHash('sha256')`
generated the SHA expectations independently of the application implementation.
The old values were captured with the algorithm from commit `620460a` and must
remain fixed. `json` is JSON text rather than a nested value so Rust can load the
isolated-surrogate case without parsing that surrogate into a Rust string.

TypeScript verifies value-to-canonical-text-to-bytes-to-digest. Rust ring verifies
the exact same canonical text bytes, without assuming serde JSON serialization
matches JavaScript. `legacy-content.json` holds actual old FNV IDs for a snapshot,
game-owned blob and resource reference, used by both hosts' storage regressions.
`legacy-build.json` preserves FNV script/UI cache keys to check that old builds
remain readable and are regenerated when the next build compares their keys.

The release/package SHA-256 fixtures elsewhere are independent and unchanged.
