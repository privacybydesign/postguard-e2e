//! Opens every container in the committed corpus (`../fixtures`) with the
//! CURRENT working-tree `pg-core` — the archival half of the read-forever
//! guarantee (EPIC issue #206, corpus in #19/#23).
//!
//! The containers were sealed by *published* writers (`@e4a/pg-wasm` via the
//! live stack, published `pg-core` releases via `../fixtures/gen`); this binary
//! unseals them with the `pg-core` checked out next to this repo. If it fails,
//! the working tree broke wire-format compatibility (VERSION constant, bincode
//! framing, header layout, …) and ciphertexts in the wild — old encrypted
//! emails and files — would fail identically. That must be a deliberate,
//! versioned decision, never an accident.
//!
//! Usage:
//!
//! ```text
//! cargo run                                  # driver: every set, every container
//! cargo run -- --case <set-dir> <container>  # one container, in this process
//! ```
//!
//! The driver runs each container in a **child process**, which is not
//! tidiness. A reader handed a container whose header layout it no longer
//! agrees with does not always return an error: it can read a garbage length
//! prefix and abort on the allocation (`memory allocation of N bytes failed`,
//! SIGABRT). An abort is not a panic, so `catch_unwind` cannot hold it, and in
//! one process the first such container would take every remaining one with it.
//! Per-container children also mean the failure line names the container that
//! died and the signal that killed it, instead of pointing at whatever ran
//! next.

use std::fs;
use std::path::{Path, PathBuf};
use std::process::{Command, ExitCode};

use pg_core::api::Parameters;
use pg_core::artifacts::{UserSecretKey, VerifyingKey};
use pg_core::client::rust::stream::UnsealerStreamConfig;
use pg_core::client::rust::UnsealerMemoryConfig;
use pg_core::client::{Unsealer, VerificationResult};
use pg_core::identity::Policy;
use pg_core::kem::cgw_kv::CGWKV;

use serde::Deserialize;

/// `meta.json` layouts this verifier understands. A schema it does not
/// recognise is a failure and never a skip: a corpus job that reads nothing and
/// reports success is worse than no job at all.
const SUPPORTED_SCHEMA_VERSIONS: &[u32] = &[1, 2];

/// Directories under `fixtures/` that are tooling rather than a fixture set.
const NOT_A_SET: &[&str] = &["node_modules", "gen"];

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Meta {
    /// Absent in the original hand-generated set, which predates the field.
    #[serde(default = "schema_v1")]
    schema_version: u32,
    sealed_by: String,
    recipient_id: String,
    sender_email: String,
    /// Set-wide plaintext (schema 1). Schema 2 records one per container.
    #[serde(default)]
    plaintext_b64: Option<String>,
    #[serde(default)]
    containers: Option<Vec<Container>>,
    /// The claims a `*-privsig` container signs its payload with.
    #[serde(default)]
    sender_private: Option<Attr>,
}

#[derive(Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
struct Container {
    file: String,
    mode: String,
    #[serde(default)]
    private_signing: bool,
    #[serde(default)]
    plaintext_b64: Option<String>,
}

#[derive(Deserialize)]
struct Attr {
    t: String,
    v: String,
}

#[derive(Deserialize)]
struct UskResponse {
    key: UserSecretKey<CGWKV>,
}

fn schema_v1() -> u32 {
    1
}

impl Meta {
    fn parse(dir: &Path) -> Result<Meta, String> {
        let raw = fs::read(dir.join("meta.json")).map_err(|e| format!("read meta.json: {e}"))?;
        let meta: Meta =
            serde_json::from_slice(&raw).map_err(|e| format!("parse meta.json: {e}"))?;
        if !SUPPORTED_SCHEMA_VERSIONS.contains(&meta.schema_version) {
            return Err(format!(
                "meta.json schemaVersion {} is newer than this verifier understands (knows {:?}) \
                 — teach it the new layout rather than skipping the set",
                meta.schema_version, SUPPORTED_SCHEMA_VERSIONS
            ));
        }
        Ok(meta)
    }

    /// The containers to open. Schema 1 has no list: it is exactly the two
    /// classic files, public signature only. Spelling that default out here is
    /// what lets the corpus stay append-only — the original set's `meta.json`
    /// can never be edited to add the field.
    fn containers(&self) -> Vec<Container> {
        self.containers.clone().unwrap_or_else(|| {
            ["mem.bin", "stream.bin"]
                .into_iter()
                .zip(["memory", "stream"])
                .map(|(file, mode)| Container {
                    file: file.to_string(),
                    mode: mode.to_string(),
                    private_signing: false,
                    plaintext_b64: None,
                })
                .collect()
        })
    }

    fn plaintext(&self, container: &Container) -> Result<Vec<u8>, String> {
        let b64 = container
            .plaintext_b64
            .as_ref()
            .or(self.plaintext_b64.as_ref())
            .ok_or_else(|| {
                format!(
                    "{}: no plaintextB64 on the container and none set-wide — \
                     nothing to compare the decrypted bytes against",
                    container.file
                )
            })?;
        base64_decode(b64).map_err(|e| format!("{}: plaintextB64: {e}", container.file))
    }
}

/// Opens one container and checks everything the corpus promises about it:
/// the recovered plaintext, the verified public sender policy, and whether a
/// private signing policy is present exactly when the container was sealed
/// with one.
fn open_case(dir: &Path, file: &str) -> Result<(), String> {
    let meta = Meta::parse(dir)?;
    let container = meta
        .containers()
        .into_iter()
        .find(|c| c.file == file)
        .ok_or_else(|| format!("meta.json declares no container {file}"))?;

    let read = |name: &str| fs::read(dir.join(name)).map_err(|e| format!("read {name}: {e}"));
    let vk: Parameters<VerifyingKey> =
        serde_json::from_slice(&read("vk.json")?).map_err(|e| format!("parse vk.json: {e}"))?;
    let usk: UskResponse =
        serde_json::from_slice(&read("usk.json")?).map_err(|e| format!("parse usk.json: {e}"))?;
    let want = meta.plaintext(&container)?;
    let ct = read(file)?;

    let (plain, verified) = match container.mode.as_str() {
        "memory" => {
            let unsealer = Unsealer::<Vec<u8>, UnsealerMemoryConfig>::new(&ct, &vk.public_key)
                .map_err(|e| format!("parse header: {e:?}"))?;
            unsealer
                .unseal(&meta.recipient_id, &usk.key)
                .map_err(|e| format!("unseal: {e:?}"))?
        }
        "stream" => {
            let mut reader = futures::io::Cursor::new(&ct);
            let mut plain = Vec::new();
            let verified = futures::executor::block_on(async {
                let unsealer =
                    Unsealer::<_, UnsealerStreamConfig>::new(&mut reader, &vk.public_key)
                        .await
                        .map_err(|e| format!("parse header: {e:?}"))?;
                unsealer
                    .unseal(&meta.recipient_id, &usk.key, &mut plain)
                    .await
                    .map_err(|e| format!("unseal: {e:?}"))
            })?;
            (plain, verified)
        }
        other => return Err(format!("unknown container mode {other}")),
    };

    if plain != want {
        return Err(format!(
            "plaintext mismatch: recovered {} bytes, expected {}",
            plain.len(),
            want.len()
        ));
    }
    check_signatures(&verified, &meta, &container)?;
    Ok(())
}

fn check_signatures(
    verified: &VerificationResult,
    meta: &Meta,
    container: &Container,
) -> Result<(), String> {
    if !has_attribute(
        &verified.public,
        "pbdf.sidn-pbdf.email.email",
        &meta.sender_email,
    ) {
        return Err(format!(
            "verified public sender policy does not carry email={}: {:?}",
            meta.sender_email, verified.public.con
        ));
    }

    match (container.private_signing, &verified.private) {
        (false, Some(private)) => Err(format!(
            "container is not privately signed but the reader reported a private policy: {:?}",
            private.con
        )),
        (true, None) => Err(
            "container is privately signed but the reader reported no private policy".to_string(),
        ),
        (true, Some(private)) => {
            let want = meta.sender_private.as_ref().ok_or_else(|| {
                "meta.json declares a privately signed container but no senderPrivate to check it \
                 against"
                    .to_string()
            })?;
            if !has_attribute(private, &want.t, &want.v) {
                return Err(format!(
                    "verified private sender policy does not carry {}={}: {:?}",
                    want.t, want.v, private.con
                ));
            }
            Ok(())
        }
        (false, None) => Ok(()),
    }
}

fn has_attribute(policy: &Policy, atype: &str, value: &str) -> bool {
    policy
        .con
        .iter()
        .any(|a| a.atype == atype && a.value.as_deref() == Some(value))
}

/// Runs one container in a child process and turns its fate into a message.
/// A signal is reported as a signal, because that is what a shifted header
/// looks like from out here and the number is the only clue the child got no
/// chance to print.
fn run_case(exe: &Path, dir: &Path, file: &str) -> Result<(), String> {
    let out = Command::new(exe)
        .arg("--case")
        .arg(dir)
        .arg(file)
        .output()
        .map_err(|e| format!("spawn {}: {e}", exe.display()))?;

    if out.status.success() {
        return Ok(());
    }

    let stderr = String::from_utf8_lossy(&out.stderr).trim().to_string();
    #[cfg(unix)]
    let signal = {
        use std::os::unix::process::ExitStatusExt;
        out.status.signal()
    };
    #[cfg(not(unix))]
    let signal: Option<i32> = None;

    Err(match signal {
        // A reader that aborts rather than returning an error is the expected
        // shape of a header-layout break, so say so here: without this line the
        // only evidence is an exit code and a reader that printed nothing.
        Some(sig) => {
            format!(
            "reader died on signal {sig} before it could report — a published-writer container \
             whose header the current pg-core no longer agrees with aborts on a garbage length \
             prefix rather than returning an error{}",
            if stderr.is_empty() { String::new() } else { format!(": {stderr}") }
        )
        }
        None if stderr.is_empty() => format!("exited with {}", out.status),
        None => stderr,
    })
}

fn drive(fixtures: &Path) -> Result<(usize, usize), String> {
    let exe = std::env::current_exe().map_err(|e| format!("current_exe: {e}"))?;
    let mut dirs: Vec<PathBuf> = fs::read_dir(fixtures)
        .map_err(|e| format!("cannot read {}: {e}", fixtures.display()))?
        .flatten()
        .map(|e| e.path())
        .filter(|p| p.is_dir())
        .filter(|p| {
            !p.file_name()
                .is_some_and(|n| NOT_A_SET.iter().any(|s| n == *s))
        })
        .collect();
    dirs.sort();

    let mut sets = 0;
    let mut containers = 0;
    let mut failures = Vec::new();

    for dir in &dirs {
        let name = dir
            .file_name()
            .unwrap_or_default()
            .to_string_lossy()
            .into_owned();
        let meta = match Meta::parse(dir) {
            Ok(meta) => meta,
            Err(e) => {
                failures.push(format!("{name}: {e}"));
                continue;
            }
        };
        let declared = meta.containers();
        if declared.is_empty() {
            failures.push(format!("{name}: meta.json declares no containers"));
            continue;
        }
        for container in &declared {
            match run_case(&exe, dir, &container.file) {
                Ok(()) => {
                    println!("ok    {name}/{} ({})", container.file, container.mode);
                    containers += 1;
                }
                Err(e) => failures.push(format!("{name}/{}: {e}", container.file)),
            }
        }
        println!(
            "      {name}: {} container(s), sealed by {}",
            declared.len(),
            meta.sealed_by
        );
        sets += 1;
    }

    if !failures.is_empty() {
        for failure in &failures {
            eprintln!("FAIL  {failure}");
        }
        return Err(format!(
            "{} container(s) in the corpus no longer open with the current pg-core",
            failures.len()
        ));
    }
    Ok((sets, containers))
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
    let args: Vec<String> = std::env::args().skip(1).collect();
    let fixtures = Path::new(env!("CARGO_MANIFEST_DIR")).join("../fixtures");

    // Child mode: exactly one container, so an abort takes only this process.
    if let ["--case", dir, file] = args
        .iter()
        .map(String::as_str)
        .collect::<Vec<_>>()
        .as_slice()
    {
        return match open_case(Path::new(dir), file) {
            Ok(()) => ExitCode::SUCCESS,
            Err(e) => {
                eprintln!("{e}");
                ExitCode::FAILURE
            }
        };
    }
    if !args.is_empty() {
        eprintln!("usage: fixtures-verify [--case <set-dir> <container>]");
        return ExitCode::FAILURE;
    }

    match drive(&fixtures) {
        Ok((0, _)) | Ok((_, 0)) => {
            eprintln!(
                "no fixture sets found in {} — that itself is a failure",
                fixtures.display()
            );
            ExitCode::FAILURE
        }
        Ok((sets, containers)) => {
            println!(
                "\nOK: {containers} container(s) across {sets} fixture set(s) still open with the \
                 current pg-core"
            );
            ExitCode::SUCCESS
        }
        Err(e) => {
            eprintln!("\nwire-format compatibility check FAILED: {e}");
            ExitCode::FAILURE
        }
    }
}
