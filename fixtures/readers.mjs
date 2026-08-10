//! The JS readers the corpus is verified with, and what each of them is
//! allowed not to be able to do.
//!
//! Two readers, because they answer different questions:
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
//!
//! `pg-js` cannot read a memory-mode container, and that is a structural
//! property rather than a defect: it decrypts through `StreamUnsealer` in both
//! of its input modes, and it never writes one either (`toBytes()` seals with
//! `sealStream`). So the corpus does not skip those cases for it — it asserts
//! the refusal, by exact message. A memory container that fails for any *other*
//! reason is a wire break, and a `pg-js` that suddenly opens one is a change in
//! the support story that has to be recorded here rather than passing quietly.

import { readFileSync } from 'node:fs';
import { readFile as readFileAsync } from 'node:fs/promises';
import { createServer } from 'node:http';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { REPO_ROOT } from './corpus.mjs';

/** The refusal `pg-js` answers a memory-mode container with. */
export const PG_JS_MEMORY_REFUSAL = /mode is not supported: InMemory/;

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

const pgWasm = {
  id: 'pg-wasm',
  label: '@e4a/pg-wasm (pinned published)',
  cannotOpen: {},

  async load() {
    // The package's default entry is the bundler target, which does
    // `import * as wasm from "./index_bg.wasm"` — plain Node cannot resolve
    // that. The web target takes the module bytes as an argument instead. The
    // .wasm file is not in the package's `exports`, so resolve the glue and
    // read its sibling rather than resolving the wasm directly.
    const glue = '@e4a/pg-wasm/web';
    const module = await import(glue);
    await module.default({
      module_or_path: await readFileAsync(new URL('index_bg.wasm', import.meta.resolve(glue))),
    });
    return { module, version: installedVersion(glue, '@e4a/pg-wasm') };
  },

  async open({ module }, { set, container }) {
    const ciphertext = new Uint8Array(await readFileAsync(join(set.dir, container.file)));
    const { verifyingKey, usk, meta } = set;

    if (container.mode === 'memory') {
      const unsealer = await module.Unsealer.new(ciphertext, verifyingKey);
      const recipients = [...unsealer.inspect_header().keys()];
      // `unseal()` takes ownership of the unsealer: the generated glue hands
      // the pointer to wasm and nulls it on the way in, so a tidy free()
      // afterwards is a double free reported as `null pointer passed to rust`
      // — which reads exactly like a broken container. Nothing here frees.
      const [plaintext, identity] = await unsealer.unseal(meta.recipientId, usk);
      return { plaintext: Buffer.from(plaintext), identity, recipients };
    }

    const readable = new ReadableStream({
      start(controller) {
        controller.enqueue(ciphertext);
        controller.close();
      },
    });
    const chunks = [];
    const writable = new WritableStream({
      write(chunk) {
        chunks.push(Buffer.from(chunk));
      },
    });
    const unsealer = await module.StreamUnsealer.new(readable, verifyingKey);
    const recipients = [...unsealer.inspect_header().keys()];
    const identity = await unsealer.unseal(meta.recipientId, usk, writable);
    return { plaintext: Buffer.concat(chunks), identity, recipients };
  },
};

const pgJs = {
  id: 'pg-js',
  label: '@e4a/pg-js (current, per compat/manifest.json)',
  cannotOpen: {
    memory:
      'pg-js decrypts through StreamUnsealer in both input modes, so it neither reads nor ' +
      'writes a memory-mode container; @e4a/pg-wasm covers those cases',
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

  async open({ PostGuard, pkg }, { set, container }) {
    const data = new Uint8Array(await readFileAsync(join(set.dir, container.file)));
    const postguard = new PostGuard({ pkgUrl: pkg.url });
    const opened = postguard.open({ data });

    // inspect() before decrypt() is the documented consumer pattern (show the
    // recipient list, then decrypt for one of them) and it is the SDK call that
    // reads the multi-recipient header on its own.
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

export const READERS = [pgWasm, pgJs];

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
