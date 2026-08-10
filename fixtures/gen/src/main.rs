//! Seals a golden container fixture set with a PINNED PUBLISHED `pg-core`
//! release from crates.io (issue #23, corpus half of #19).
//!
//! ```text
//! cargo run --locked -- 0.6.1  ../pg-core-0.6.1
//! cargo run --locked -- 0.5.10 ../pg-core-0.5.10
//! ```
//!
//! Why a published writer and not the working tree: the corpus is the *time*
//! axis. A container in the corpus has to be bytes some released client really
//! produced, so that "current readers still open it" is a statement about the
//! field and not about this checkout. HEAD-sealed bytes are the other
//! direction, and they belong to the forward job (#25) and to postguard's own
//! `wire-compat-rust` gate.
//!
//! Everything is a pure function of [`SEED`]: master keys, user secret keys,
//! signatures, IVs, and therefore every sealed byte. Two runs produce
//! byte-identical files, so re-running the generator over an existing set is a
//! way to check that the committed bytes are what this writer produces —
//! though the generator refuses to touch a populated set directory, because
//! the corpus is append-only (see `../README.md`).
//!
//! The set is deliberately self-contained per writer, keys included: a
//! published writer derives its own key universe with its own `ibe`/`ibs`
//! versions, so keys are NOT shared across writers and no cross-version key
//! JSON compatibility is assumed anywhere.

use std::collections::BTreeMap;
use std::fs;
use std::path::{Path, PathBuf};
use std::process::ExitCode;

/// Seed for every random value in every set. Changing it changes every byte of
/// every future set, so don't: append a writer instead.
const SEED: [u8; 32] = *b"postguard-e2e-container-corpus-1";

/// Fixed policy timestamp (2024-01-01T00:00:00Z). A clock here would make the
/// output non-reproducible, which is the one property that lets a reviewer tell
/// a wire change from RNG noise.
const TIMESTAMP: u64 = 1_704_067_200;

/// The recipient every container is sealed for. Same identity the existing
/// `pg-wasm-0.6.1/` set uses, so the whole corpus reads the same way.
const RECIPIENT_ID: &str = "phd-holder";
const RECIPIENT_ATTR_TYPE: &str = "irma-demo.RU.studentCard.level";
const RECIPIENT_ATTR_VALUE: &str = "PhD";

/// The sender identity signing every container's header. `verify.mjs` asserts
/// this attribute type, so the whole corpus has to agree on it.
const SENDER_ATTR_TYPE: &str = "pbdf.sidn-pbdf.email.email";
const SENDER_EMAIL: &str = "sender@golden.test";

/// The attribute the `*-privsig` containers sign the payload with, visible only
/// after decryption.
const PRIVATE_SENDER_ATTR_TYPE: &str = "pbdf.gemeente.personalData.fullname";
const PRIVATE_SENDER_NAME: &str = "Golden Sender";

/// Schema version of `meta.json`. A verifier that does not recognise the value
/// must fail, not skip: a corpus job that reads nothing and passes is worse
/// than no job.
const META_SCHEMA_VERSION: u32 = 2;

/// One container in a set. The four cover both container modes times both
/// signing shapes, which is the whole readable container surface a single
/// recipient can produce.
struct Container {
    file: &'static str,
    mode: &'static str,
    private_signing: bool,
}

const CONTAINERS: &[Container] = &[
    Container {
        file: "mem.bin",
        mode: "memory",
        private_signing: false,
    },
    Container {
        file: "stream.bin",
        mode: "stream",
        private_signing: false,
    },
    Container {
        file: "mem-privsig.bin",
        mode: "memory",
        private_signing: true,
    },
    Container {
        file: "stream-privsig.bin",
        mode: "stream",
        private_signing: true,
    },
];

/// Distinct plaintext per container, so a verifier that opens the wrong file,
/// or a writer that seals the same bytes twice, cannot pass by coincidence.
fn plaintext(version: &str, container: &Container) -> Vec<u8> {
    format!(
        "postguard-e2e container corpus: pg-core {version} {} container{}; \
         old ciphertexts must decrypt forever",
        container.mode,
        if container.private_signing {
            ", private signature"
        } else {
            ""
        }
    )
    .into_bytes()
}

type Set = BTreeMap<String, Vec<u8>>;

/// Generates the whole set for one published `pg-core`.
///
/// A macro rather than a generic function because each pinned version is a
/// separate crate with separate, unrelated types — the same reason `pg-compat`
/// instantiates its reader per version.
macro_rules! writer {
    ($module:ident, $pg:ident, $version:literal) => {
        mod $module {
            use super::{
                plaintext, Set, CONTAINERS, META_SCHEMA_VERSION, PRIVATE_SENDER_ATTR_TYPE,
                PRIVATE_SENDER_NAME, RECIPIENT_ATTR_TYPE, RECIPIENT_ATTR_VALUE, RECIPIENT_ID, SEED,
                SENDER_ATTR_TYPE, SENDER_EMAIL, TIMESTAMP,
            };

            use $pg::artifacts::{PublicKey, SigningKey, SigningKeyExt, UserSecretKey, VerifyingKey};
            use $pg::client::rust::stream::SealerStreamConfig;
            use $pg::client::rust::SealerMemoryConfig;
            use $pg::client::Sealer;
            use $pg::consts::VERSION_V3;
            use $pg::identity::{Attribute, EncryptionPolicy, Policy};
            use $pg::kem::cgw_kv::CGWKV;
            use $pg::kem::IBKEM;

            use rand::SeedableRng;
            use rand_chacha::ChaCha20Rng;

            pub const VERSION: &str = $version;

            fn policy(attrs: Vec<Attribute>) -> Policy {
                Policy { timestamp: TIMESTAMP, con: attrs }
            }

            pub fn build() -> Result<Set, String> {
                let mut rng = ChaCha20Rng::from_seed(SEED);

                let (ibe_pk, ibe_msk) = CGWKV::setup(&mut rng);
                let (ibs_pk, ibs_sk) = $pg::ibs::gg::setup(&mut rng);
                let mpk = PublicKey::<CGWKV>(ibe_pk);
                let vk = VerifyingKey(ibs_pk);

                let recipient = policy(vec![Attribute::new(
                    RECIPIENT_ATTR_TYPE,
                    Some(RECIPIENT_ATTR_VALUE),
                )]);
                let enc_policy: EncryptionPolicy =
                    [(RECIPIENT_ID.to_string(), recipient.clone())].into_iter().collect();

                let derived = recipient
                    .derive_kem::<CGWKV>()
                    .map_err(|e| format!("derive recipient kem id: {e:?}"))?;
                let usk = UserSecretKey::<CGWKV>(CGWKV::extract_usk(
                    Some(&mpk.0),
                    &ibe_msk,
                    &derived,
                    &mut rng,
                ));

                let public_sender = policy(vec![Attribute::new(SENDER_ATTR_TYPE, Some(SENDER_EMAIL))]);
                let private_sender = policy(vec![Attribute::new(
                    PRIVATE_SENDER_ATTR_TYPE,
                    Some(PRIVATE_SENDER_NAME),
                )]);
                let mut sign_key = |p: &Policy| -> Result<SigningKeyExt, String> {
                    let id = p.derive_ibs().map_err(|e| format!("derive ibs id: {e:?}"))?;
                    Ok(SigningKeyExt {
                        key: SigningKey($pg::ibs::gg::keygen(&ibs_sk, &id, &mut rng)),
                        policy: p.clone(),
                    })
                };
                let pub_sign_key = sign_key(&public_sender)?;
                let priv_sign_key = sign_key(&private_sender)?;

                let mut out = Set::new();

                // Shaped like the PKG responses a real client reads, so the
                // same files feed the Rust, pg-wasm and pg-js verifiers with no
                // translation: /v2/parameters, /v2/sign/parameters and
                // /v2/irma/key/<ts>.
                out.insert(
                    "mpk.json".into(),
                    super::json_bytes(&serde_json::json!({
                        "formatVersion": 0, "publicKey": mpk,
                    })),
                );
                out.insert(
                    "vk.json".into(),
                    super::json_bytes(&serde_json::json!({
                        "formatVersion": 0, "publicKey": vk,
                    })),
                );
                out.insert(
                    "usk.json".into(),
                    super::json_bytes(&serde_json::json!({
                        "status": "DONE", "proofStatus": "VALID", "key": usk,
                    })),
                );
                // Shaped like POST /v2/irma/sign/key. Committed so a future
                // writer in another language can seal a new container into
                // THIS key universe (see ../README.md); a Rust writer derives
                // its own from the seed and never reads this file.
                out.insert(
                    "signkey.json".into(),
                    super::json_bytes(&serde_json::json!({
                        "pubSignKey": pub_sign_key, "privSignKey": priv_sign_key,
                    })),
                );

                let mut containers = Vec::new();
                for c in CONTAINERS {
                    let plain = plaintext(VERSION, c);
                    let bytes = match c.mode {
                        "memory" => {
                            let sealer = Sealer::<_, SealerMemoryConfig>::new(
                                &mpk,
                                &enc_policy,
                                &pub_sign_key,
                                &mut rng,
                            )
                            .map_err(|e| format!("{}: sealer: {e:?}", c.file))?;
                            let sealer = if c.private_signing {
                                sealer.with_priv_signing_key(priv_sign_key.clone())
                            } else {
                                sealer
                            };
                            sealer.seal(&plain).map_err(|e| format!("{}: seal: {e:?}", c.file))?
                        }
                        "stream" => {
                            let mut sealer = Sealer::<_, SealerStreamConfig>::new(
                                &mpk,
                                &enc_policy,
                                &pub_sign_key,
                                &mut rng,
                            )
                            .map_err(|e| format!("{}: sealer: {e:?}", c.file))?;
                            if c.private_signing {
                                sealer = sealer.with_priv_signing_key(priv_sign_key.clone());
                            }
                            let mut buf = Vec::new();
                            futures::executor::block_on(async {
                                let mut input = futures::io::Cursor::new(&plain);
                                sealer.seal(&mut input, &mut buf).await
                            })
                            .map_err(|e| format!("{}: seal: {e:?}", c.file))?;
                            buf
                        }
                        other => return Err(format!("unknown mode {other}")),
                    };

                    containers.push(serde_json::json!({
                        "file": c.file,
                        "mode": c.mode,
                        "privateSigning": c.private_signing,
                        "plaintextB64": super::base64_encode(&plain),
                    }));
                    out.insert(c.file.to_string(), bytes);
                }

                out.insert(
                    "meta.json".into(),
                    super::json_bytes(&serde_json::json!({
                        "schemaVersion": META_SCHEMA_VERSION,
                        "sealedBy": format!("pg-core@{VERSION}"),
                        "writer": {
                            "registry": "crates.io",
                            "package": "pg-core",
                            "version": VERSION,
                        },
                        "wireVersion": VERSION_V3,
                        "recipientId": RECIPIENT_ID,
                        "ts": TIMESTAMP,
                        "con": [{ "t": RECIPIENT_ATTR_TYPE, "v": RECIPIENT_ATTR_VALUE }],
                        "senderEmail": SENDER_EMAIL,
                        "senderPrivate": {
                            "t": PRIVATE_SENDER_ATTR_TYPE, "v": PRIVATE_SENDER_NAME,
                        },
                        "containers": containers,
                        "files": {
                            "mpk.json": "PKG /v2/parameters response (master public key)",
                            "vk.json": "PKG /v2/sign/parameters response (IBS verifying key)",
                            "usk.json": "PKG /v2/irma/key/{ts} response (recipient IBE user secret key)",
                            "signkey.json": "PKG POST /v2/irma/sign/key response (sender signing keys)",
                        },
                    })),
                );

                Ok(out)
            }
        }
    };
}

writer!(v0_6_1, pg_core_0_6_1, "0.6.1");
writer!(v0_5_10, pg_core_0_5_10, "0.5.10");

/// Pretty JSON with a trailing newline, so a reviewer can read a diff between
/// two runs of the generator.
fn json_bytes(value: &serde_json::Value) -> Vec<u8> {
    let mut buf = serde_json::to_vec_pretty(value).expect("serialize");
    buf.push(b'\n');
    buf
}

/// Minimal std-only base64 (standard alphabet, padded), so the generator needs
/// no dependency for one field. Mirrors `fixtures-verify`'s decoder.
fn base64_encode(bytes: &[u8]) -> String {
    const ALPHABET: &[u8] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut out = String::with_capacity((bytes.len() + 2) / 3 * 4);
    for chunk in bytes.chunks(3) {
        let b = [
            chunk[0],
            *chunk.get(1).unwrap_or(&0),
            *chunk.get(2).unwrap_or(&0),
        ];
        let n = (b[0] as u32) << 16 | (b[1] as u32) << 8 | b[2] as u32;
        for i in 0..4 {
            if i <= chunk.len() {
                out.push(ALPHABET[(n >> (18 - 6 * i) & 0x3f) as usize] as char);
            } else {
                out.push('=');
            }
        }
    }
    out
}

fn usage() -> ExitCode {
    eprintln!("usage: cargo run --locked -- <writer-version> <out-dir>");
    eprintln!(
        "       writer-version: {} | {}",
        v0_6_1::VERSION,
        v0_5_10::VERSION
    );
    ExitCode::FAILURE
}

fn main() -> ExitCode {
    let mut args = std::env::args().skip(1);
    let (Some(version), Some(out_dir), None) = (args.next(), args.next(), args.next()) else {
        return usage();
    };
    let out_dir = PathBuf::from(out_dir);

    let set = match version.as_str() {
        v if v == v0_6_1::VERSION => v0_6_1::build(),
        v if v == v0_5_10::VERSION => v0_5_10::build(),
        other => {
            eprintln!("no writer pinned for pg-core {other}");
            return usage();
        }
    };
    let set = match set {
        Ok(set) => set,
        Err(e) => {
            eprintln!("seal: {e}");
            return ExitCode::FAILURE;
        }
    };

    // The corpus is append-only: a generator that silently rewrites a committed
    // set is the accident the CI gate exists to catch, so refuse it here too.
    // Regenerating into an empty directory and diffing is the supported way to
    // check committed bytes against this writer.
    if let Ok(existing) = fs::read_dir(&out_dir) {
        let clashes: Vec<_> = existing
            .flatten()
            .map(|e| e.file_name().to_string_lossy().into_owned())
            .filter(|name| set.contains_key(name))
            .collect();
        if !clashes.is_empty() {
            eprintln!(
                "{} already holds {}: the corpus is append-only — write a new \
                 directory, or generate into an empty one and diff",
                out_dir.display(),
                clashes.join(", ")
            );
            return ExitCode::FAILURE;
        }
    }
    if let Err(e) = fs::create_dir_all(&out_dir) {
        eprintln!("create {}: {e}", out_dir.display());
        return ExitCode::FAILURE;
    }

    for (name, bytes) in &set {
        let path: PathBuf = Path::new(&out_dir).join(name);
        if let Err(e) = fs::write(&path, bytes) {
            eprintln!("write {}: {e}", path.display());
            return ExitCode::FAILURE;
        }
        println!("{} ({} bytes)", path.display(), bytes.len());
    }

    ExitCode::SUCCESS
}
