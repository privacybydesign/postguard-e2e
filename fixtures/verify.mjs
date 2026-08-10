//! Opens every container in the committed corpus with the published JS
//! readers — the client half of the read-forever guarantee (EPIC issue #206,
//! corpus in #19/#23).
//!
//! ```text
//! npm ci && npm run verify
//! node verify.mjs --case <reader> <set> <container>   # one case, in-process
//! ```
//!
//! The sibling [`../fixtures-verify/`](../fixtures-verify/) crate runs the same
//! corpus against the CURRENT working-tree `pg-core` (the library side of the
//! contract). Between them, every committed container is opened by a published
//! JS reader, by the SDK the ecosystem currently ships, and by the code about
//! to become the next release.
//!
//! Each case runs in a **child process**. A reader handed a container whose
//! header layout it no longer agrees with does not reliably throw: it can read
//! a garbage length prefix and abort on the allocation, which in wasm arrives
//! as a killed process rather than an exception no `try` can catch. One child
//! per case means such a death names the container that caused it and the run
//! carries on to the rest.

import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { fixtureSets, findContainer, loadSet } from './corpus.mjs';
import { readerById, READERS } from './readers.mjs';

const SELF = fileURLToPath(import.meta.url);

/** Runs one case in this process and throws with a precise message. */
async function runCase(readerId, setName, containerFile) {
  const reader = readerById(readerId);
  const set = loadSet(setName);
  const container = findContainer(set, containerFile);
  const refusal = reader.cannotOpen[container.mode];

  let state;
  try {
    state = await reader.load({ set });

    let opened;
    try {
      opened = await reader.open(state, { set, container });
    } catch (e) {
      if (!refusal) throw e;
      // The reader declares it cannot open this mode, so a refusal is the
      // expected result — but only the documented one. Anything else is a
      // container that broke for a real reason wearing a skip's clothing.
      if (!/mode is not supported/.test(e?.message ?? '')) {
        throw new Error(
          `expected the documented refusal for ${container.mode} mode (${refusal}), got: ${e?.message ?? e}`
        );
      }
      return `refused ${container.mode} mode as documented: ${e.message}`;
    }

    if (refusal) {
      throw new Error(
        `this reader is recorded as unable to open a ${container.mode}-mode container ` +
          `(${refusal}) but it just did — that is a change in the support story: drop the ` +
          'cannotOpen entry in readers.mjs so the corpus starts holding it to the new behaviour'
      );
    }

    check(opened, set, container);
    return `${container.mode} container opened, plaintext and sender verified`;
  } finally {
    await reader.unload?.(state ?? {});
  }
}

/** Everything the corpus promises about one opened container. */
function check(opened, set, container) {
  const { plaintext, identity, recipients } = opened;
  if (!plaintext.equals(container.plaintext)) {
    throw new Error(
      `plaintext mismatch: recovered ${plaintext.length} bytes, expected ${container.plaintext.length}`
    );
  }
  if (!recipients.includes(set.meta.recipientId)) {
    throw new Error(
      `header recipients ${JSON.stringify(recipients)} do not include ${set.meta.recipientId}`
    );
  }

  const publicCon = identity?.public?.con ?? [];
  const senderOk = publicCon.some(
    (a) => a.t === 'pbdf.sidn-pbdf.email.email' && a.v === set.meta.senderEmail
  );
  if (!senderOk) {
    throw new Error(
      `verified sender missing email=${set.meta.senderEmail}: ${JSON.stringify(identity)}`
    );
  }

  // A container sealed with a private signing policy must surface one, and a
  // container sealed without must not: a reader that reports claims nobody
  // signed is as wrong as one that loses them.
  const privateCon = identity?.private?.con;
  if (container.privateSigning && !privateCon) {
    throw new Error('container is privately signed but the reader reported no private policy');
  }
  if (!container.privateSigning && privateCon) {
    throw new Error(
      `container is not privately signed but the reader reported ${JSON.stringify(privateCon)}`
    );
  }
  if (container.privateSigning) {
    const want = set.meta.senderPrivate;
    if (!want) {
      throw new Error(
        'meta.json declares a privately signed container but no senderPrivate to check it against'
      );
    }
    if (!privateCon.some((a) => a.t === want.t && a.v === want.v)) {
      throw new Error(
        `verified private sender policy does not carry ${want.t}=${want.v}: ${JSON.stringify(privateCon)}`
      );
    }
  }
}

/** Spawns one case and turns its fate into a message. */
function spawnCase(readerId, setName, containerFile) {
  const child = spawnSync(
    process.execPath,
    [SELF, '--case', readerId, setName, containerFile],
    { encoding: 'utf8', timeout: 300_000 }
  );

  if (child.status === 0) return { ok: true, note: child.stdout.trim() };
  const stderr = (child.stderr ?? '').trim();
  if (child.signal) {
    // The expected shape of a header-layout break: a reader that aborts rather
    // than throwing. Without naming the signal the only evidence is a reader
    // that printed nothing.
    return {
      ok: false,
      note:
        `reader died on signal ${child.signal} before it could report — a container whose ` +
        'header this reader no longer agrees with aborts on a garbage length prefix rather ' +
        `than throwing${stderr ? `: ${stderr}` : ''}`,
    };
  }
  return { ok: false, note: stderr || `exited with status ${child.status}` };
}

async function main() {
  const [flag, ...rest] = process.argv.slice(2);

  if (flag === '--case') {
    const [readerId, setName, containerFile] = rest;
    try {
      process.stdout.write(await runCase(readerId, setName, containerFile));
      process.exitCode = 0;
    } catch (e) {
      process.stderr.write(String(e?.stack ?? e));
      process.exitCode = 1;
    }
    // No process.exit(): on macOS a pipe write is async and exiting here can
    // truncate what the parent reads back as the failure message.
    return;
  }
  if (flag !== undefined) {
    process.stderr.write('usage: node verify.mjs [--case <reader> <set> <container>]\n');
    process.exitCode = 1;
    return;
  }

  const sets = fixtureSets();
  const failures = [];
  let cases = 0;

  for (const reader of READERS) {
    console.log(`\n${reader.label}`);
    for (const set of sets) {
      for (const container of set.containers) {
        const { ok, note } = spawnCase(reader.id, set.name, container.file);
        cases++;
        if (ok) {
          console.log(`  ok    ${set.name}/${container.file} — ${note}`);
        } else {
          console.log(`  FAIL  ${set.name}/${container.file}`);
          failures.push(`${reader.id}: ${set.name}/${container.file}: ${note}`);
        }
      }
    }
  }

  const containers = sets.reduce((n, set) => n + set.containers.length, 0);
  if (failures.length > 0) {
    console.error('\nFAILURES');
    for (const failure of failures) console.error(`  ${failure}`);
    console.error(
      `\n${failures.length} of ${cases} case(s) failed: a container in the corpus no longer ` +
        'opens. Old ciphertexts in the wild fail the same way.'
    );
    process.exitCode = 1;
    return;
  }

  console.log(
    `\nOK: ${containers} container(s) across ${sets.length} fixture set(s), ` +
      `${READERS.length} reader(s), ${cases} case(s)`
  );
}

await main();
