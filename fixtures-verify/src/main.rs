//! Verifies every committed crypto-compat fixture set (../fixtures) against
//! the CURRENT working-tree pg-core (EPIC issue #206).
//!
//! The fixtures were sealed by the pinned, published `@e4a/pg-wasm`; this
//! binary unseals them with the pg-core checked out next to this repo. If it
//! fails, the working tree broke wire-format compatibility (VERSION constant,
//! bincode framing, header layout, …) and ciphertexts in the wild — old
//! encrypted emails and files — would fail identically. That must be a
//! deliberate, versioned decision, never an accident.
//!
//! Usage: `cargo run` (from fixtures-verify/), exits non-zero on any failure.

use std::fs;
use std::path::Path;
use std::process::ExitCode;

use pg_core::api::Parameters;
use pg_core::artifacts::{UserSecretKey, VerifyingKey};
use pg_core::client::rust::stream::UnsealerStreamConfig;
use pg_core::client::rust::UnsealerMemoryConfig;
use pg_core::client::Unsealer;
use pg_core::kem::cgw_kv::CGWKV;

use serde::Deserialize;

#[derive(Deserialize)]
struct Meta {
    #[serde(rename = "sealedBy")]
    sealed_by: String,
    #[serde(rename = "recipientId")]
    recipient_id: String,
    #[serde(rename = "plaintextB64")]
    plaintext_b64: String,
}

#[derive(Deserialize)]
struct UskResponse {
    key: UserSecretKey<CGWKV>,
}

fn verify_set(dir: &Path) -> Result<String, String> {
    let read = |name: &str| fs::read(dir.join(name)).map_err(|e| format!("read {name}: {e}"));
    let meta: Meta = serde_json::from_slice(&read("meta.json")?)
        .map_err(|e| format!("parse meta.json: {e}"))?;
    let vk: Parameters<VerifyingKey> = serde_json::from_slice(&read("vk.json")?)
        .map_err(|e| format!("parse vk.json: {e}"))?;
    let usk: UskResponse = serde_json::from_slice(&read("usk.json")?)
        .map_err(|e| format!("parse usk.json: {e}"))?;
    let want = base64_decode(&meta.plaintext_b64).map_err(|e| format!("meta plaintext: {e}"))?;

    // Streaming container.
    {
        let ct = read("stream.bin")?;
        let mut reader = futures::io::Cursor::new(&ct);
        let mut plain = Vec::new();
        futures::executor::block_on(async {
            let unsealer = Unsealer::<_, UnsealerStreamConfig>::new(&mut reader, &vk.public_key)
                .await
                .map_err(|e| format!("stream.bin: parse header: {e:?}"))?;
            unsealer
                .unseal(&meta.recipient_id, &usk.key, &mut plain)
                .await
                .map_err(|e| format!("stream.bin: unseal: {e:?}"))?;
            Ok::<(), String>(())
        })?;
        if plain != want {
            return Err("stream.bin: plaintext mismatch".into());
        }
    }

    // In-memory container.
    {
        let ct = read("mem.bin")?;
        let unsealer = Unsealer::<Vec<u8>, UnsealerMemoryConfig>::new(&ct, &vk.public_key)
            .map_err(|e| format!("mem.bin: parse header: {e:?}"))?;
        let (plain, _verified) = unsealer
            .unseal(&meta.recipient_id, &usk.key)
            .map_err(|e| format!("mem.bin: unseal: {e:?}"))?;
        if plain != want {
            return Err("mem.bin: plaintext mismatch".into());
        }
    }

    Ok(meta.sealed_by)
}

/// Minimal std-only base64 (standard alphabet, padded) so the verifier adds no
/// extra dependency for one field.
fn base64_decode(s: &str) -> Result<Vec<u8>, String> {
    const ALPHABET: &[u8] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut out = Vec::with_capacity(s.len() / 4 * 3);
    let mut buf: u32 = 0;
    let mut bits = 0;
    for &c in s.as_bytes() {
        if c == b'=' {
            break;
        }
        let v = ALPHABET
            .iter()
            .position(|&a| a == c)
            .ok_or_else(|| format!("invalid base64 byte {c}"))? as u32;
        buf = (buf << 6) | v;
        bits += 6;
        if bits >= 8 {
            bits -= 8;
            out.push((buf >> bits) as u8);
        }
    }
    Ok(out)
}

fn main() -> ExitCode {
    let fixtures = Path::new(env!("CARGO_MANIFEST_DIR")).join("../fixtures");
    let mut sets = 0;
    let mut failed = false;

    let entries = match fs::read_dir(&fixtures) {
        Ok(e) => e,
        Err(e) => {
            eprintln!("cannot read {}: {e}", fixtures.display());
            return ExitCode::FAILURE;
        }
    };
    for entry in entries.flatten() {
        let dir = entry.path();
        if !dir.is_dir() || dir.file_name().is_some_and(|n| n == "node_modules") {
            continue;
        }
        match verify_set(&dir) {
            Ok(sealed_by) => {
                println!("ok  {} (sealed by {sealed_by}) — stream + mem unseal", dir.file_name().unwrap().to_string_lossy());
                sets += 1;
            }
            Err(e) => {
                eprintln!("FAIL {}: {e}", dir.display());
                failed = true;
            }
        }
    }

    if failed || sets == 0 {
        eprintln!("wire-format compatibility check FAILED ({sets} set(s) ok)");
        return ExitCode::FAILURE;
    }
    println!("\nOK: {sets} fixture set(s) verified against the current pg-core");
    ExitCode::SUCCESS
}
