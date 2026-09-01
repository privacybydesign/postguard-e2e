//! The JS readers the corpus is verified with, and what each of them is
//! allowed not to be able to do.
//!
//! Three readers, because they answer different questions:
//!
//! - **`@e4a/pg-wasm`, pinned published** — the layer that owns the container
//!   format on the JS side, and the only JS reader that opens a memory-mode
//!   container at all. Pinned rather than floating: it is the client half of
//!   the archival contract, so it should keep opening the corpus even as the
//!   pin ages.
//! - **`@e4a/pg-js`, the version `compat/manifest.json` records as current** —
//!   the SDK websites and add-ons actually ship. Verifying through
//!   `PostGuard#open` covers more than a container parse: the header policy map
//!   turned into a recipient list, the USK fetched for the chosen recipient,
//!   the sender identity handed to the UI. This is the reader whose regression
//!   would orphan mail in the field, so the corpus is checked against the
//!   *current* one and not a pin that quietly ages out of relevance.
//! - **`@e4a/pg-wasm` 0.6.4, pinned permanently** — the first release that
//!   rejects a swapped header-signature block
//!   ([postguard#347](https://github.com/encryption4all/postguard/issues/347)).
//!   What this pin freezes is *that the fix worked as shipped*: a floating pin
//!   would only duplicate `fixtures-verify` and would stop testing 0.6.4 the
//!   day 0.6.5 lands. It is an npm alias rather than a second dependency
//!   because `pg-js` declares `^0.6.1` and npm dedupes a plain second entry
//!   onto the top-level copy.
//!
//! `pg-js` cannot read a memory-mode container, and that is a structural
//! property rather than a defect: it decrypts through `StreamUnsealer` in both
//! of its input modes, and it never writes one either (`toBytes()` seals with
//! `sealStream`). So the corpus does not skip those cases for it — it asserts
//! the refusal, by exact message. A memory container that fails for any *other*
//! reason is a wire break, and a `pg-js` that suddenly opens one is a change in
//! the support story that has to be recorded here rather than passing quietly.
//!
//! `rejectsTampered` is the same idea for the expected-failure containers. The
//! corpus carries containers whose header signature block was replaced
//! (`corpus.mjs`, `TAMPER_KINDS`); a reader older than the fix opens them and
//! reports the identity they claim. That non-rejection is the blast radius
//! written down: recorded here, it holds the reader to what it does today and
//! turns a pin bump into a visible failure rather than a silent change.
//!
//! An entry carries the `stage` the reader fails at and the `refusal` pattern
//! the failure has to match, because a rejection recorded without one would be
//! satisfied by any throw at all — a truncated container, a missing file, a
//! reader that no longer agrees with the header layout.

import { readFileSync } from 'node:fs';
import { readFile as readFileAsync } from 'node:fs/promises';
import { createServer } from 'node:http';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { REPO_ROOT } from './corpus.mjs';

/** The refusal `pg-js` answers a memory-mode container with. */
export const PG_JS_MEMORY_REFUSAL = /mode is not supported: InMemory/;

/**
 * What `pg-js` answers a rejected tampered container with, which is *not* what
 * the wasm under it raises.
 *
 * pg-core raises `IncorrectSignature` and pg-js surfaces
 * `IdentityMismatchError: Identity mismatch: the Yivi attributes did not match
 * the encryption policy.` — a sender-signature failure reported as a
 * *recipient*-attribute one. Measured, not inferred: the same container through
 * the nested `@e4a/pg-wasm` 0.6.5 directly throws `incorrect signature`.
 *
 * The corpus records what the reader does, so this is the pattern to match. But
 * the mislabelling is a real defect for a consumer — it points a developer at
 * the recipient's disclosure when the sender's signature is what failed — and
 * it is filed rather than papered over here.
 *
 * Matching it is weaker as a discriminator than `incorrect signature`, since a
 * genuine attribute mismatch says the same thing. The four assertions
 * `runTamperedCase` makes around it are what carry the weight: the good twin
 * opens, the header parses, it claims the attacker, and it no longer claims the
 * real sender. Only then is this message asked for.
 */
export const PG_JS_IDENTITY_MISMATCH = /identity mismatch/i;

/** The package both wasm readers are, whichever specifier resolves them. */
const PG_WASM_PACKAGE = '@e4a/pg-wasm';

/**
 * The error `pg-core` raises for a header signature it will not accept, and the
 * pattern every `rejectsTampered` entry below is matched by.
 *
 * It is the same error plain corruption raises, deliberately: postguard#347
 * reuses `Error::IncorrectSignature` rather than adding a variant to a public
 * enum carrying no `#[non_exhaustive]`, which would have been a major. So
 * matching it is necessary but never sufficient, which is why `verify.mjs`
 * asserts three more things around it.
 */
const INCORRECT_SIGNATURE = /incorrect signature/i;

/**
 * Why the pre-fix reader refuses a `respelled-sender` container outright,
 * which is *not* the tamper check finding anything.
 *
 * One reader, not two, since pg-js 2.5.0: it declared `^0.6.5` and stopped
 * deduping onto this pin, so it reads through a wasm that postdates both
 * canonicalization and the fix. `@e4a/pg-wasm 0.6.1` is the only reader left
 * that predates them.
 *
 * Canonicalization landed in the same release as the fix
 * ([postguard#335](https://github.com/encryption4all/postguard/issues/335)), so
 * a reader older than it derives the signer's identity from the policy bytes as
 * they stand. A respelled policy derives an identity the header signature was
 * never made for, so the signature does not verify and the container is refused
 * before any payload is read.
 */
const RESPELL_REFUSED_AT_HEADER = {
  stage: 'header',
  refusal: INCORRECT_SIGNATURE,
  why:
    'this reader predates canonicalization (postguard#335): it derives the signer identity from ' +
    'the policy bytes as they stand, so the header signature over a respelled policy does not ' +
    'verify and the container is refused before the payload is read',
};

/**
 * The `@e4a/pg-js` version the corpus is verified with. Read from
 * `compat/manifest.json` rather than hardcoded, so "current" means the same
 * thing here as it does to the cross-repo drift detector: one definition of
 * current, in the file whose whole job is to hold it.
 */
export function currentPgJsVersion() {
  const manifest = JSON.parse(
    readFileSync(join(REPO_ROOT, 'compat', 'manifest.json'), 'utf8')
  );
  const version = manifest?.sdk?.['pg-js']?.current;
  if (!version) throw new Error('compat/manifest.json has no sdk["pg-js"].current');
  return version;
}

/**
 * The version of an installed package, read off disk.
 *
 * Neither published package exports `package.json`, so
 * `import('<pkg>/package.json')` is `ERR_PACKAGE_PATH_NOT_EXPORTED`. Resolve
 * an entry point instead and walk up to the manifest that names the package —
 * walking rather than assuming a fixed depth, because how deep a package puts
 * its entry is the package's business and changes between releases.
 */
function installedVersion(specifier, name) {
  let dir = dirname(fileURLToPath(import.meta.resolve(specifier)));
  for (let i = 0; i < 8; i++) {
    try {
      const manifest = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'));
      if (manifest.name === name) return manifest.version;
    } catch {
      // Keep walking: not every directory on the way up has a manifest.
    }
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  throw new Error(`cannot find the installed package.json of ${name} from ${specifier}`);
}

/**
 * A reader over one installed copy of `@e4a/pg-wasm`. Two of them are in the
 * list and they differ only in which copy and what each is held to, so the
 * container plumbing is written once — a second hand-written copy would drift
 * from this one on the first fix to either.
 */
function pgWasmReader({ id, label, specifier, expectVersion, rejectsTampered }) {
  return {
    id,
    label,
    cannotOpen: {},
    rejectsTampered,

    async load() {
      // The package's default entry is the bundler target, which does
      // `import * as wasm from "./index_bg.wasm"` — plain Node cannot resolve
      // that. The web target takes the module bytes as an argument instead. The
      // .wasm file is not in the package's `exports`, so resolve the glue and
      // read its sibling rather than resolving the wasm directly.
      const glue = `${specifier}/web`;
      const module = await import(glue);
      await module.default({
        module_or_path: await readFileAsync(new URL('index_bg.wasm', import.meta.resolve(glue))),
      });

      const version = installedVersion(glue, PG_WASM_PACKAGE);
      if (expectVersion && version !== expectVersion) {
        throw new Error(
          `${id} resolved ${PG_WASM_PACKAGE} ${version}, not the ${expectVersion} it is pinned ` +
            'to — this reader exists to hold one published release to what it did, so a copy ' +
            'npm deduped onto another version verifies nothing. Check the specifier in ' +
            'fixtures/package.json and its lockfile.'
        );
      }
      return { module, version };
    },

    /**
     * Parse the header and read the sender identity it *claims*, without
     * decrypting. `public_identity()` has to be called before `unseal()`,
     * which consumes the unsealer.
     */
    async inspect({ module }, { set, container }) {
      const unsealer = await newUnsealer(module, set, container);
      return {
        recipients: [...unsealer.inspect_header().keys()],
        identity: unsealer.public_identity(),
      };
    },

    async open({ module }, { set, container }) {
      const { usk, meta } = set;
      const unsealer = await newUnsealer(module, set, container);
      const recipients = [...unsealer.inspect_header().keys()];

      if (container.mode === 'memory') {
        // `unseal()` takes ownership of the unsealer: the generated glue hands
        // the pointer to wasm and nulls it on the way in, so a tidy free()
        // afterwards is a double free reported as `null pointer passed to rust`
        // — which reads exactly like a broken container. Nothing here frees.
        const [plaintext, identity] = await unsealer.unseal(meta.recipientId, usk);
        return { plaintext: Buffer.from(plaintext), identity, recipients };
      }

      const chunks = [];
      const writable = new WritableStream({
        write(chunk) {
          chunks.push(Buffer.from(chunk));
        },
      });
      const identity = await unsealer.unseal(meta.recipientId, usk, writable);
      return { plaintext: Buffer.concat(chunks), identity, recipients };
    },
  };
}

/** A fresh unsealer over one container, in whichever mode it was sealed. */
async function newUnsealer(module, set, container) {
  const ciphertext = new Uint8Array(await readFileAsync(join(set.dir, container.file)));
  if (container.mode === 'memory') {
    return module.Unsealer.new(ciphertext, set.verifyingKey);
  }
  const readable = new ReadableStream({
    start(controller) {
      controller.enqueue(ciphertext);
      controller.close();
    },
  });
  return module.StreamUnsealer.new(readable, set.verifyingKey);
}

const pgWasm = pgWasmReader({
  id: 'pg-wasm',
  label: '@e4a/pg-wasm (pinned published)',
  specifier: PG_WASM_PACKAGE,
  rejectsTampered: {
    // A swapped header signature block is not rejected here, and must not be:
    // this pin predates postguard#347, so it opens those containers and reports
    // the sender they claim. That is the recorded blast radius of the bug.
    'respelled-sender': RESPELL_REFUSED_AT_HEADER,
  },
});

const pgWasm064 = pgWasmReader({
  id: 'pg-wasm-0-6-4',
  label: '@e4a/pg-wasm 0.6.4 (pinned permanently)',
  specifier: 'pg-wasm-0-6-4',
  expectVersion: '0.6.4',
  rejectsTampered: {
    'swapped-signer': {
      stage: 'unseal',
      refusal: INCORRECT_SIGNATURE,
      why:
        'the AEAD-protected copy of the sender\'s public signing policy names the real sender ' +
        'and the header signature block names someone else (postguard#347), so the header still ' +
        'parses and unseal is where it stops',
    },
    'respelled-sender': {
      stage: 'unseal',
      refusal: INCORRECT_SIGNATURE,
      why:
        'the check is byte equality on the policy and not identity equality, so a respelling ' +
        'that derives the same sender is rejected too — which is what separates a reader that ' +
        'only reads the header from one that reads the copy under the AEAD',
    },
  },
});

const pgJs = {
  id: 'pg-js',
  label: '@e4a/pg-js (current, per compat/manifest.json)',
  cannotOpen: {
    memory:
      'pg-js decrypts through StreamUnsealer in both input modes, so it neither reads nor ' +
      'writes a memory-mode container; @e4a/pg-wasm covers those cases',
  },
  // Whichever `@e4a/pg-wasm` the current pg-js resolves onto does the container
  // work, so this reader inherits that copy's answers — and which copy that is
  // changed under it. Through 2.4.0 pg-js declared `^0.6.1` and npm deduped it
  // onto the top-level pin, so it read through a wasm predating both the fix
  // (postguard#347) and canonicalization (postguard#335): it opened a
  // swapped-signer container and reported the attacker as verified, and it
  // refused a respelled one at the header because the signature over
  // as-written policy bytes did not verify. 2.5.0 moved the range to `^0.6.5`
  // for `signChallenge`, which no longer dedupes, so npm nests its own 0.6.5
  // and both of those answers inverted at once. Measured on 0.6.1 vs 0.6.5:
  //
  //   0.6.1  stream-spoofed  header claims attacker@golden.test; unseal OK
  //          mem-respelled   refused at the header: incorrect signature
  //   0.6.5  stream-spoofed  header claims attacker@golden.test; unseal refused
  //          mem-respelled   header claims Sender@Golden.TEST;   unseal refused
  //
  // So this reader now answers like `pg-wasm-0-6-4` below: the header parses in
  // both cases and unseal is where it stops. A range bump for an unrelated
  // feature is what carried a security fix into this reader.
  rejectsTampered: {
    'swapped-signer': {
      stage: 'unseal',
      refusal: PG_JS_IDENTITY_MISMATCH,
      why:
        'the resolved wasm carries the AEAD-protected copy of the sender\'s public signing ' +
        'policy (postguard#347), so the swapped header block parses and unseal is where it ' +
        'stops — reported through pg-js as an identity mismatch, see PG_JS_IDENTITY_MISMATCH',
    },
    'respelled-sender': {
      stage: 'unseal',
      refusal: PG_JS_IDENTITY_MISMATCH,
      why:
        'canonicalization (postguard#335) derives the same signer from a respelled policy, so ' +
        'the header signature verifies and the byte-equality check under the AEAD is what ' +
        'refuses it — the same split `pg-wasm-0-6-4` records, one release later',
    },
  },

  async load({ set }) {
    const { PostGuard } = await import('@e4a/pg-js');
    const version = installedVersion('@e4a/pg-js', '@e4a/pg-js');
    const declared = currentPgJsVersion();
    if (version !== declared) {
      throw new Error(
        `installed @e4a/pg-js is ${version} but compat/manifest.json records ${declared} as ` +
          'current — the archival corpus must be verified with the reader the ecosystem ships, ' +
          'so move the pin in fixtures/package.json (and its lockfile) to match'
      );
    }
    const pkg = await startPkgStub(set);
    return { PostGuard, pkg, version };
  },

  async unload({ pkg }) {
    await pkg?.close();
  },

  /**
   * `inspect()` before `decrypt()` is the documented consumer pattern (show the
   * recipient list, then decrypt for one of them) and it is the SDK call that
   * reads the multi-recipient header on its own. Its `sender` is the identity
   * the header *claims*, which is the pre-decrypt reading a UI would show.
   */
  async inspect({ PostGuard, pkg }, { set, container }) {
    const { recipients, sender } = await openLazily(PostGuard, pkg, set, container).inspect();
    return { recipients, identity: sender?.raw ?? null };
  },

  async open({ PostGuard, pkg }, { set, container }) {
    const opened = openLazily(PostGuard, pkg, set, container);
    const { recipients } = await opened.inspect();

    // Where a browser consumer scans a QR code, the corpus passes a session
    // callback that hands the PKG stub the recipient id in place of the Yivi
    // JWT a deployment would send. Everything after this is the SDK's own path.
    const { plaintext, sender } = await opened.decrypt({
      recipient: set.meta.recipientId,
      session: async () => set.meta.recipientId,
    });
    return { plaintext: Buffer.from(plaintext), identity: sender?.raw ?? null, recipients };
  },
};

/** The SDK's lazy builder over one container's bytes. */
function openLazily(PostGuard, pkg, set, container) {
  const data = readFileSync(join(set.dir, container.file));
  return new PostGuard({ pkgUrl: pkg.url }).open({ data: new Uint8Array(data) });
}

export const READERS = [pgWasm, pgJs, pgWasm064];

export function readerById(id) {
  const reader = READERS.find((r) => r.id === id);
  if (!reader) throw new Error(`no reader ${id} (have ${READERS.map((r) => r.id).join(', ')})`);
  return reader;
}

/**
 * The two PKG endpoints `@e4a/pg-js` fetches on its decrypt path, served from
 * the fixture set itself.
 *
 * `pg-js` is an SDK for a deployment: it takes a `pkgUrl` and fetches the
 * verifying key and the recipient's user secret key from it, because in the
 * field the USK only exists after a Yivi disclosure. The corpus has neither a
 * PKG nor a Yivi app, but it does have both keys on disk — every set commits
 * them shaped like the responses of those two endpoints on purpose. So this is
 * not a PKG and does not pretend to be one; it hands back two committed files,
 * which is what lets the published SDK's real decrypt path run unmodified
 * against golden bytes. A mock unsealer would test the mock instead.
 */
async function startPkgStub(set) {
  const server = createServer((req, res) => {
    const { pathname } = new URL(req.url, 'http://localhost');
    const json = (body) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(body);
    };
    if (pathname === '/v2/sign/parameters') return json(set.verifyingKeyRaw);
    if (/^\/v2\/irma\/key\/\d+$/.test(pathname)) return json(set.uskRaw);

    // Anything else means the SDK's decrypt path changed shape and the corpus
    // is no longer exercising what it thinks it is. Say which route was asked.
    res.writeHead(404, { 'content-type': 'application/json' });
    return res.end(JSON.stringify({ error: `the corpus PKG stub does not serve ${pathname}` }));
  });

  // Loopback only, on a port the kernel picks, so parallel case processes need
  // agree on nothing.
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  server.unref();

  return {
    url: `http://127.0.0.1:${server.address().port}`,
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}
