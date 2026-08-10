// The key universe the decrypt legs run in, and the PKG stub that serves it.
//
// A decrypt leg has a hard prerequisite the encrypt leg does not: a user secret
// key for the recipient the artifact was sealed for. In the field that key only
// exists after a Yivi disclosure, and deriving one for a fresh policy needs the
// PKG's master SECRET key — so "seal something now, open it with an old SDK"
// cannot be done against a deployment the harness cannot disclose to.
//
// What it can be done against is a committed fixture set. Every set under
// `fixtures/` carries `mpk.json`, `signkey.json`, `usk.json` and `vk.json`
// shaped exactly like the PKG responses, precisely so a later writer can seal
// into its key universe (`fixtures/README.md`, "Adding a writer's artifacts").
// Seal for the set's own recipient policy and timestamp and the committed USK
// opens the result — so the new stack can seal at sweep time and every
// published SDK in the support matrix can be asked to open it.
//
// The set definition is imported from `fixtures/corpus.mjs` rather than
// re-implemented: which directories are sets, which meta.json schemas exist and
// what a set promises has one owner, and a second opinion here would be a
// disagreement nobody sees until a set silently stops being swept.

import { existsSync, readFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { join } from 'node:path';
import semver from 'semver';

import { fixtureSets, loadSet } from '../fixtures/corpus.mjs';

/**
 * A fixture set can be READ with `vk.json` + `usk.json` alone, but sealing into
 * its key universe also needs the master public key and the sender signing
 * keys. The set generated from the live stack carries no `signkey.json` —
 * nothing can sign as its sender any more — so it is readable-only.
 */
function isSealable(set) {
  return existsSync(join(set.dir, 'signkey.json')) && existsSync(join(set.dir, 'mpk.json'));
}

/** Every fixture set the decrypt legs could seal a fresh artifact into. */
export function sealableUniverses() {
  return fixtureSets().filter(isSealable);
}

/**
 * The writer version a set was sealed by, for ordering. `meta.writer.version`
 * on a schema-2 set; coerced from the directory name otherwise, because a
 * schema-1 set's meta.json can never be edited to add the field.
 */
function writerVersion(set) {
  return semver.coerce(set.meta.writer?.version ?? set.name) ?? semver.parse('0.0.0');
}

/**
 * The key universe to seal into. `name` (PG_DECRYPT_SET) names a set
 * explicitly; without one it is the sealable set with the highest writer
 * version — by semver rather than by directory name, so a future `-0.10.0` set
 * does not sort below `-0.5.10`. The corpus is append-only, so that pick moves
 * forward as sets are added and never backwards.
 *
 * Throws rather than skipping when nothing is sealable: a decrypt gate that
 * quietly has no artifact to open would report success on exactly the runs it
 * exists for.
 */
export function pickUniverse(name) {
  const sealable = sealableUniverses();
  if (name) {
    const set = loadSet(name);
    if (!isSealable(set)) {
      throw new Error(
        `fixture set ${name} has no signkey.json/mpk.json, so nothing can seal into its key ` +
          `universe — sealable sets: ${sealable.map((s) => s.name).join(', ') || 'none'}`
      );
    }
    return describe(set);
  }
  const newest = [...sealable].sort(
    (a, b) => semver.compare(writerVersion(a), writerVersion(b)) || a.name.localeCompare(b.name)
  ).at(-1);
  if (!newest) {
    throw new Error(
      'no fixture set carries both signkey.json and mpk.json, so the decrypt legs have no key ' +
        'universe to seal into — see fixtures/README.md'
    );
  }
  return describe(newest);
}

/**
 * A sealable set plus the four PKG payloads. Two are kept as raw JSON because
 * the stub serves them verbatim; the sealer wants the fields inside the others.
 */
function describe(set) {
  const read = (file) => readFileSync(join(set.dir, file), 'utf8');
  return {
    name: set.name,
    sealedBy: set.meta.sealedBy ?? set.name,
    /** The recipient every artifact in this universe is sealed for. */
    recipientId: set.meta.recipientId,
    /** The sender the header carries, which the decrypt leg verifies. */
    senderEmail: set.meta.senderEmail,
    /**
     * `{ [recipientId]: { ts, con } }` — the pg-wasm/pg-core encryption policy.
     * The timestamp is the set's, not now: the committed USK is derived over the
     * policy INCLUDING its timestamp, so a clock here would produce an artifact
     * nothing in the universe can open.
     */
    policy: { [set.meta.recipientId]: { ts: set.meta.ts, con: set.meta.con } },
    mpk: JSON.parse(read('mpk.json')).publicKey,
    signKeys: JSON.parse(read('signkey.json')),
    verifyingKeyRaw: read('vk.json'),
    uskRaw: read('usk.json'),
  };
}

/**
 * The two PKG endpoints an SDK fetches on its decrypt path, served from the
 * universe's committed files.
 *
 * Not a PKG and not pretending to be one — it hands back two files, which is
 * what lets a published SDK's real decrypt path run unmodified against bytes
 * sealed minutes ago. Same seam as `fixtures/readers.mjs`; it exists here too
 * because that one serves one in-process reader and this one serves a sandbox
 * per swept version over the loopback interface.
 *
 * Anything else 404s and names the route: an SDK that starts asking for a third
 * endpoint has changed its decrypt path, and the leg has to say that rather
 * than fail with a message nobody can act on.
 */
export async function startPkgStub(universe) {
  const asked = new Set();
  const server = createServer((req, res) => {
    const { pathname } = new URL(req.url, 'http://localhost');
    asked.add(pathname);
    const json = (body) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(body);
    };
    if (pathname === '/v2/sign/parameters') return json(universe.verifyingKeyRaw);
    if (/^\/v2\/irma\/key\/\d+$/.test(pathname)) return json(universe.uskRaw);

    res.writeHead(404, { 'content-type': 'application/json' });
    return res.end(
      JSON.stringify({
        error:
          'the decrypt-leg PKG stub serves /v2/sign/parameters and /v2/irma/key/{ts}, not ' +
          pathname,
      })
    );
  });

  // Loopback only, on a port the kernel picks, so parallel sandboxes need agree
  // on nothing.
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  server.unref();

  return {
    url: `http://127.0.0.1:${server.address().port}`,
    /** Routes the stub was asked for, so the run can report what it exercised. */
    asked: () => [...asked].sort(),
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}
