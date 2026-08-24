//! Seals the golden container fixture set for PUBLISHED `pg-core` 0.6.4 from
//! crates.io (issue #47, corpus half of #19).
//!
//! ```text
//! cargo run --locked -- 0.6.4 ../pg-core-0.6.4
//! cargo run --locked -- 0.6.4 ../pg-core-0.6.4-tampered --tampered
//! ```
//!
//! Its own crate rather than a third pin in `../gen`, for the reason that
//! crate's `Cargo.toml` records: cargo keeps one copy per semver-compatible
//! range, so 0.6.4 cannot sit beside 0.6.1 in one manifest. What it is *for*
//! is the era: 0.6.4 is the first release that writes the AEAD-protected copy
//! of the sender's public signing policy (postguard#347/#351), so it is the
//! first writer in the corpus that seals the format every new container is
//! sealed in.
//!
//! Constants, plaintexts and file layout are `../gen`'s, value for value, so
//! the whole corpus reads the same way. Copied rather than shared: the two
//! crates pin incompatible `pg-core` majors and have no workspace between
//! them, and the committed bytes plus their ledger lines are what hold the
//! values fixed from here on.
//!
//! Everything is a pure function of [`SEED`]: master keys, user secret keys,
//! signatures, IVs, and therefore every sealed byte. Two runs produce
//! byte-identical files, so re-running the generator into an empty directory
//! and diffing is a way to check that the committed bytes are what this writer
//! produces — it refuses to touch a populated set directory, because the corpus
//! is append-only (see `../README.md`).
//!
//! `--tampered` seals the expected-failure set instead (issue #48): the two
//! public-signature twins byte for byte, plus containers whose header signature
//! block has been replaced. It is a directory of its own rather than three more
//! files beside the positives, because declaring a container means writing it
//! into `meta.json` and every file inside a set is frozen the moment it lands.

use std::collections::BTreeMap;
use std::fs;
use std::path::{Path, PathBuf};
use std::process::ExitCode;

use pg_core::artifacts::{PublicKey, SigningKey, SigningKeyExt, UserSecretKey, VerifyingKey};
use pg_core::client::rust::stream::SealerStreamConfig;
use pg_core::client::rust::SealerMemoryConfig;
use pg_core::client::Sealer;
use pg_core::consts::{HEADER_SIZE_SIZE, PREAMBLE_SIZE, SIG_SIZE_SIZE, VERSION_2};
use pg_core::ibs::gg::{SecretKey as IbsSecretKey, Signature, Signer};
use pg_core::identity::{Attribute, EncryptionPolicy, Policy};
use pg_core::kem::cgw_kv::CGWKV;
use pg_core::kem::IBKEM;

use rand::SeedableRng;
use rand_chacha::ChaCha20Rng;
use serde::Serialize;

/// The `pg-core` release this crate is pinned to, and the only value its
/// command line accepts — spelled out so a copy-pasted invocation from a
/// sibling generator fails loudly instead of writing 0.6.1's plaintexts into a
/// 0.6.4 set.
const VERSION: &str = "0.6.4";

/// Seed for every random value in every set. Changing it changes every byte of
/// every future set, so don't: append a writer instead.
const SEED: [u8; 32] = *b"postguard-e2e-container-corpus-1";

/// Fixed policy timestamp (2024-01-01T00:00:00Z). A clock here would make the
/// output non-reproducible, which is the one property that lets a reviewer tell
/// a wire change from RNG noise.
const TIMESTAMP: u64 = 1_704_067_200;

/// The recipient every container is sealed for. Same identity the rest of the
/// corpus uses, so every set reads the same way.
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

/// The identity the `*-spoofed.bin` header signatures are made under. It has to
/// differ from [`SENDER_EMAIL`] *after* canonicalization (postguard#335), which
/// `derive_ibs` applies: a mere respelling derives to the same identity and
/// would be the same signer, not another one.
const ATTACKER_EMAIL: &str = "attacker@golden.test";

/// The sender's own address, respelled. Canonicalization folds it back to
/// [`SENDER_EMAIL`], so it derives the same identity and the sender's own key
/// signs for it — only the policy BYTES differ, and byte equality is what the
/// check compares (`sealed_pub_pol != self.pub_id`).
const RESPELLED_SENDER_EMAIL: &str = "Sender@Golden.TEST";

/// Schema version of `meta.json`. A verifier that does not recognise the value
/// must fail, not skip: a corpus job that reads nothing and passes is worse
/// than no job.
const META_SCHEMA_VERSION: u32 = 3;

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

/// Which identity the replacement header signature block claims, and therefore
/// which signing key made it. The name is what `meta.json` records as the
/// tamper kind, and `../corpus.mjs` lists the same two.
enum Claimant {
    /// Another identity entirely: the swap postguard#347 rejects.
    Attacker,
    /// The sender's own address, respelled. The sender's own key signs it,
    /// because the identity derives the same; what a reader has to notice is
    /// that the bytes in the header no longer match the copy under the AEAD.
    RespelledSender,
}

impl Claimant {
    fn kind(&self) -> &'static str {
        match self {
            Claimant::Attacker => "swapped-signer",
            Claimant::RespelledSender => "respelled-sender",
        }
    }
}

/// One container in the expected-failure set: a twin from [`CONTAINERS`],
/// identical outside its header signature block.
struct Tampered {
    file: &'static str,
    twin: &'static str,
    claimant: Claimant,
}

/// Public signing only. The swap is on the public block, so a `*-privsig` twin
/// would mostly re-pin what the positive containers already cover.
const TAMPERED: &[Tampered] = &[
    Tampered {
        file: "mem-spoofed.bin",
        twin: "mem.bin",
        claimant: Claimant::Attacker,
    },
    Tampered {
        file: "stream-spoofed.bin",
        twin: "stream.bin",
        claimant: Claimant::Attacker,
    },
    Tampered {
        file: "mem-respelled.bin",
        twin: "mem.bin",
        claimant: Claimant::RespelledSender,
    },
];

/// Which of the two sets this run seals.
#[derive(Clone, Copy, PartialEq)]
enum SetKind {
    /// The four containers a released 0.6.4 writer produces.
    Positive,
    /// The two public-signature twins plus [`TAMPERED`].
    Tampered,
}

/// A two-field copy of `pg-core`'s own `SignatureExt`, which is not reachable
/// from outside the crate: `client/mod.rs` declares `mod header;` privately and
/// re-exports only `Algorithm`, `Header`, `Mode` and `RecipientHeader`. Both
/// field types come from `pg-core`'s re-exports, so the encoding is the
/// writer's own rather than a guess that has to be kept in step with it.
#[derive(Serialize)]
struct SignatureExt {
    sig: Signature,
    pol: Policy,
}

/// Distinct plaintext per container, so a verifier that opens the wrong file,
/// or a writer that seals the same bytes twice, cannot pass by coincidence.
fn plaintext(container: &Container) -> Vec<u8> {
    format!(
        "postguard-e2e container corpus: pg-core {VERSION} {} container{}; \
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

fn policy(attrs: Vec<Attribute>) -> Policy {
    Policy {
        timestamp: TIMESTAMP,
        con: attrs,
    }
}

/// Mints a signing key for a policy, the way the PKG's
/// `POST /v2/irma/sign/key` does. A free function rather than a closure over
/// the RNG, because the attacker's key is minted after the positive containers
/// are sealed and a closure holding the borrow that long would not compile.
fn sign_key(
    ibs_sk: &IbsSecretKey,
    rng: &mut ChaCha20Rng,
    p: &Policy,
) -> Result<SigningKeyExt, String> {
    let id = p
        .derive_ibs()
        .map_err(|e| format!("derive ibs id: {e:?}"))?;
    Ok(SigningKeyExt {
        key: SigningKey(pg_core::ibs::gg::keygen(ibs_sk, &id, rng)),
        policy: p.clone(),
    })
}

/// The tamper: keep the preamble, header and payload byte for byte, and replace
/// only the header signature block with one made over the *same* header bytes
/// by `key`, carrying `pol`. `pg-core`'s own `swap_header_signature`
/// (`client/rust/stream.rs`) is the reference implementation.
///
/// The block sits outside the AEAD and the header bytes it signs are unchanged,
/// so the result parses and its signature verifies: that is the attack, and why
/// 0.6.4 had to put a copy of the claimed policy inside the AEAD to catch it.
fn swap_header_signature(
    ct: &[u8],
    key: &SigningKeyExt,
    pol: &Policy,
    rng: &mut ChaCha20Rng,
) -> Result<Vec<u8>, String> {
    let be32 = |bytes: Option<&[u8]>, what: &str| -> Result<usize, String> {
        let bytes: [u8; 4] = bytes
            .ok_or_else(|| format!("container is too short for its {what}"))?
            .try_into()
            .map_err(|e| format!("{what}: {e}"))?;
        Ok(u32::from_be_bytes(bytes) as usize)
    };

    // The header length is the preamble's last field. Read it here rather than
    // through pg-core's parser, which is private to the crate.
    let header_len = be32(
        ct.get(PREAMBLE_SIZE - HEADER_SIZE_SIZE..PREAMBLE_SIZE),
        "header length",
    )?;
    let sig_len_at = PREAMBLE_SIZE + header_len;
    let header_bytes = ct
        .get(PREAMBLE_SIZE..sig_len_at)
        .ok_or("container is too short for its header")?;
    let sig_len = be32(
        ct.get(sig_len_at..sig_len_at + SIG_SIZE_SIZE),
        "header signature length",
    )?;
    let payload = ct
        .get(sig_len_at + SIG_SIZE_SIZE + sig_len..)
        .ok_or("container is too short for its payload")?;

    let forged = SignatureExt {
        sig: Signer::new().chain(header_bytes).sign(&key.key.0, rng),
        pol: pol.clone(),
    };
    let forged = pg_core::bincode_compat::serialize(&forged)
        .map_err(|e| format!("serialize header signature: {e:?}"))?;

    let mut out = ct[..sig_len_at].to_vec();
    out.extend_from_slice(
        &u32::try_from(forged.len())
            .map_err(|e| format!("header signature length: {e}"))?
            .to_be_bytes(),
    );
    out.extend_from_slice(&forged);
    out.extend_from_slice(payload);

    Ok(out)
}

fn build(kind: SetKind) -> Result<Set, String> {
    let mut rng = ChaCha20Rng::from_seed(SEED);

    let (ibe_pk, ibe_msk) = CGWKV::setup(&mut rng);
    let (ibs_pk, ibs_sk) = pg_core::ibs::gg::setup(&mut rng);
    let mpk = PublicKey::<CGWKV>(ibe_pk);
    let vk = VerifyingKey(ibs_pk);

    let recipient = policy(vec![Attribute::new(
        RECIPIENT_ATTR_TYPE,
        Some(RECIPIENT_ATTR_VALUE),
    )]);
    let enc_policy: EncryptionPolicy = [(RECIPIENT_ID.to_string(), recipient.clone())]
        .into_iter()
        .collect();

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
    let pub_sign_key = sign_key(&ibs_sk, &mut rng, &public_sender)?;
    let priv_sign_key = sign_key(&ibs_sk, &mut rng, &private_sender)?;

    let mut out = Set::new();

    // Shaped like the PKG responses a real client reads, so the same files feed
    // the Rust, pg-wasm and pg-js verifiers with no translation:
    // /v2/parameters, /v2/sign/parameters and /v2/irma/key/<ts>.
    out.insert(
        "mpk.json".into(),
        json_bytes(&serde_json::json!({
            "formatVersion": 0, "publicKey": mpk,
        })),
    );
    out.insert(
        "vk.json".into(),
        json_bytes(&serde_json::json!({
            "formatVersion": 0, "publicKey": vk,
        })),
    );
    out.insert(
        "usk.json".into(),
        json_bytes(&serde_json::json!({
            "status": "DONE", "proofStatus": "VALID", "key": usk,
        })),
    );
    // Shaped like POST /v2/irma/sign/key. Committed so a future writer in
    // another language can seal a new container into THIS key universe (see
    // ../README.md); a Rust writer derives its own from the seed and never
    // reads this file.
    out.insert(
        "signkey.json".into(),
        json_bytes(&serde_json::json!({
            "pubSignKey": pub_sign_key, "privSignKey": priv_sign_key,
        })),
    );

    // Seal every positive container before anything else draws from the RNG,
    // so the two sets take the same draws in the same order and the files they
    // share — the key material and the twins — come out byte-identical.
    let mut sealed: BTreeMap<&str, (Vec<u8>, Vec<u8>)> = BTreeMap::new();
    for c in CONTAINERS {
        let plain = plaintext(c);
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
                sealer
                    .seal(&plain)
                    .map_err(|e| format!("{}: seal: {e:?}", c.file))?
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
        sealed.insert(c.file, (plain, bytes));
    }

    let mut files = serde_json::json!({
        "mpk.json": "PKG /v2/parameters response (master public key)",
        "vk.json": "PKG /v2/sign/parameters response (IBS verifying key)",
        "usk.json": "PKG /v2/irma/key/{ts} response (recipient IBE user secret key)",
        "signkey.json": "PKG POST /v2/irma/sign/key response (sender signing keys)",
    });
    let mut containers = Vec::new();

    for c in CONTAINERS {
        // The expected-failure set carries only the twins its tampered
        // containers are derived from: it is an addition to the corpus, not a
        // second copy of it.
        if kind == SetKind::Tampered && !TAMPERED.iter().any(|t| t.twin == c.file) {
            continue;
        }
        let (plain, bytes) = &sealed[c.file];
        containers.push(serde_json::json!({
            "file": c.file,
            "mode": c.mode,
            "privateSigning": c.private_signing,
            "plaintextB64": base64_encode(plain),
        }));
        out.insert(c.file.to_string(), bytes.clone());
    }

    if kind == SetKind::Tampered {
        let attacker = policy(vec![Attribute::new(SENDER_ATTR_TYPE, Some(ATTACKER_EMAIL))]);
        let attacker_key = sign_key(&ibs_sk, &mut rng, &attacker)?;
        let respelled = policy(vec![Attribute::new(
            SENDER_ATTR_TYPE,
            Some(RESPELLED_SENDER_EMAIL),
        )]);

        // The attacker's key is committed in a file of its own rather than
        // added to signkey.json, which is frozen in the positive set and
        // byte-identical here. Nothing is leaked: this key universe is a pure
        // function of SEED, and committing it is what keeps the tamper
        // reproducible by anyone re-running this generator.
        out.insert(
            "attacker-signkey.json".into(),
            json_bytes(&serde_json::json!({ "pubSignKey": attacker_key })),
        );
        files["attacker-signkey.json"] = serde_json::json!(format!(
            "PKG POST /v2/irma/sign/key response for {ATTACKER_EMAIL} (the key the \
             *-spoofed.bin header signatures are made with)"
        ));

        for t in TAMPERED {
            let twin = CONTAINERS
                .iter()
                .find(|c| c.file == t.twin)
                .ok_or_else(|| format!("{}: no positive container {}", t.file, t.twin))?;
            let (plain, ct) = &sealed[t.twin];
            let (key, pol, claims) = match t.claimant {
                Claimant::Attacker => (&attacker_key, &attacker, ATTACKER_EMAIL),
                Claimant::RespelledSender => (&pub_sign_key, &respelled, RESPELLED_SENDER_EMAIL),
            };
            let bytes = swap_header_signature(ct, key, pol, &mut rng)
                .map_err(|e| format!("{}: {e}", t.file))?;

            containers.push(serde_json::json!({
                "file": t.file,
                "mode": twin.mode,
                "privateSigning": false,
                "plaintextB64": base64_encode(plain),
                // What the container IS, never what a reader must do about it:
                // this file is frozen forever, and every reader that predates
                // postguard#347 opens these and recovers the plaintext above.
                // Which readers reject it is recorded in ../readers.mjs.
                "tampered": {
                    "kind": t.claimant.kind(),
                    "swappedFrom": t.twin,
                    "attackerEmail": claims,
                },
            }));
            out.insert(t.file.to_string(), bytes);
        }
    }

    let mut meta = serde_json::json!({
        "schemaVersion": META_SCHEMA_VERSION,
        "sealedBy": format!("pg-core@{VERSION}"),
        "writer": {
            "registry": "crates.io",
            "package": "pg-core",
            "version": VERSION,
        },
        "wireVersion": VERSION_2,
        "recipientId": RECIPIENT_ID,
        "ts": TIMESTAMP,
        "con": [{ "t": RECIPIENT_ATTR_TYPE, "v": RECIPIENT_ATTR_VALUE }],
        "senderEmail": SENDER_EMAIL,
        "containers": containers,
        "files": files,
    });
    // Only when a container in the set is signed with it. Declaring claims no
    // container carries would freeze a field forever with nothing to check it
    // against.
    if containers
        .iter()
        .any(|c| c["privateSigning"] == serde_json::json!(true))
    {
        meta["senderPrivate"] = serde_json::json!({
            "t": PRIVATE_SENDER_ATTR_TYPE, "v": PRIVATE_SENDER_NAME,
        });
    }
    out.insert("meta.json".into(), json_bytes(&meta));

    Ok(out)
}

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
    eprintln!("usage: cargo run --locked -- <writer-version> <out-dir> [--tampered]");
    eprintln!("       writer-version: {VERSION}");
    eprintln!("       --tampered:     seal the expected-failure set (issue #48)");
    ExitCode::FAILURE
}

fn main() -> ExitCode {
    let mut args = std::env::args().skip(1);
    let (Some(version), Some(out_dir), flag, None) =
        (args.next(), args.next(), args.next(), args.next())
    else {
        return usage();
    };
    if version != VERSION {
        eprintln!("this crate pins pg-core {VERSION}, not {version}");
        return usage();
    }
    let kind = match flag.as_deref() {
        None => SetKind::Positive,
        Some("--tampered") => SetKind::Tampered,
        Some(other) => {
            eprintln!("unknown flag {other}");
            return usage();
        }
    };
    let out_dir = PathBuf::from(out_dir);

    let set = match build(kind) {
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
