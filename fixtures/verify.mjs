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
//! Some containers in the corpus are **expected to fail**: their header
//! signature block was replaced, and a reader that reports their claimed sender
//! as verified is the bug postguard#347 fixed. `meta.json` records what such a
//! container is; `readers.mjs` records what each reader does about it. See
//! `runTamperedCase` for what is asserted, and why "it threw" is not enough.
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

/** The attribute type every set's sender identity is expressed in. */
const SENDER_ATTR_TYPE = 'pbdf.sidn-pbdf.email.email';

/** Does this policy carry the sender attribute with exactly this value? */
function claims(policy, email) {
  return (policy?.con ?? []).some((a) => a.t === SENDER_ATTR_TYPE && a.v === email);
}

/** Runs one case in this process and throws with a precise message. */
async function runCase(readerId, setName, containerFile) {
  const reader = readerById(readerId);
  const set = loadSet(setName);
  const container = findContainer(set, containerFile);

  let state;
  try {
    state = await reader.load({ set });
    return container.tampered
      ? await runTamperedCase(reader, state, set, container)
      : await runPositiveCase(reader, state, set, container);
  } finally {
    await reader.unload?.(state ?? {});
  }
}

/** A container the corpus expects this reader to open. */
async function runPositiveCase(reader, state, set, container) {
  const refusal = reader.cannotOpen[container.mode];
  if (refusal) return expectModeRefusal(reader, state, set, container, refusal);

  check(await reader.open(state, { set, container }), set, container);
  return `${container.mode} container opened, plaintext and sender verified`;
}

/**
 * Every `rejectsTampered` entry has to be answerable before it is believed: a
 * stage to fail at, and a pattern the failure has to match. Neither is
 * optional, because a rejection with nothing to match is a rejection that
 * passes on any throw at all — see [`expectRecordedRefusal`].
 */
function validateRejection(reader, kind, rejection) {
  if (rejection.stage !== 'header' && rejection.stage !== 'unseal') {
    throw new Error(
      `readers.mjs records ${reader.id}'s rejectsTampered['${kind}'].stage = ` +
        `${JSON.stringify(rejection.stage)}, which is neither "header" nor "unseal"`
    );
  }
  if (!(rejection.refusal instanceof RegExp)) {
    throw new Error(
      `readers.mjs records no rejectsTampered['${kind}'].refusal pattern for ${reader.id}: a ` +
        'tampered container and a merely broken one make a reader throw alike, so the message ' +
        'has to be matched and not merely caught'
    );
  }
}

/**
 * The refusal `readers.mjs` records, and only that — the same discipline
 * [`expectModeRefusal`] applies to a mode refusal, and for the same reason. A
 * missing file, a truncated container, a reader that no longer agrees with the
 * header layout: all of them throw here too, and every one of them would
 * otherwise be reported as the tamper being caught.
 */
function expectRecordedRefusal(e, kind, stage, rejection) {
  const message = e?.message ?? String(e);
  if (!rejection.refusal.test(message)) {
    throw new Error(
      `expected the ${stage} refusal readers.mjs records for a ${kind} container ` +
        `(${rejection.refusal}), got: ${message} — a container that is merely broken throws ` +
        'here too, so an unmatched message means this is no longer the tamper meta.json says ' +
        'it is rather than a reader that caught one'
    );
  }
  return message;
}

/**
 * A container whose header signature block was replaced. Four things are
 * asserted together, because the error a rejecting reader raises
 * (`IncorrectSignature`) is the one plain corruption raises too — postguard#347
 * reuses it deliberately, a new variant on a public enum with no
 * `#[non_exhaustive]` being a major — so "it threw" would pass just as happily
 * on a fixture that is merely broken:
 *
 *  1. the **good twin** still opens, plaintext and sender verified;
 *  2. the tampered container's header still **parses**, and lists the same
 *     recipients as the twin;
 *  3. the identity reported **before** decrypting is the one the swapped block
 *     claims, and not the real sender's;
 *  4. only `unseal` fails, and with the recorded message.
 *
 * For a reader recorded as unable to reject, the mirror of 4: it opens, hands
 * back the recorded plaintext, and reports the claim. That is the blast radius
 * of the bug, written down and held in place.
 */
async function runTamperedCase(reader, state, set, container) {
  const { kind, swappedFrom, attackerEmail } = container.tampered;
  const rejection = reader.rejectsTampered?.[kind];
  if (rejection) validateRejection(reader, kind, rejection);

  // Recorded as refusing before it reads the payload at all. Assertions 2 to 4
  // are about a container this reader will not parse, so they are unavailable —
  // what is left is 1, which says the corpus and the reader are sound, and the
  // refusal being the recorded one rather than any error whatsoever.
  if (rejection?.stage === 'header') {
    await runPositiveCase(reader, state, set, findContainer(set, swappedFrom));
    try {
      await reader.inspect(state, { set, container });
    } catch (e) {
      const message = expectRecordedRefusal(e, kind, 'header', rejection);
      return `refused a ${kind} container at the header as recorded: ${message}`;
    }
    throw new Error(
      `this reader is recorded as refusing a ${kind} container at the header (${rejection.why}) ` +
        'but it just parsed one — move the rejectsTampered entry in readers.mjs to the stage it ' +
        'fails at now, or drop it'
    );
  }

  const refusal = reader.cannotOpen[container.mode];
  if (refusal) return expectModeRefusal(reader, state, set, container, refusal);

  const twin = findContainer(set, swappedFrom);
  const twinOpened = await reader.open(state, { set, container: twin });
  check(twinOpened, set, twin);

  const header = await reader.inspect(state, { set, container });
  const recipients = [...header.recipients].sort();
  const twinRecipients = [...twinOpened.recipients].sort();
  if (JSON.stringify(recipients) !== JSON.stringify(twinRecipients)) {
    throw new Error(
      `header recipients ${JSON.stringify(recipients)} differ from the twin ${swappedFrom}'s ` +
        `${JSON.stringify(twinRecipients)} — the tamper is supposed to leave the header alone`
    );
  }
  if (!header.identity) {
    throw new Error(
      'this reader reports no sender identity before decrypting, so there is no way to assert ' +
        'that the container claims the swapped-in sender — teach its inspect() to return one'
    );
  }
  if (!claims(header.identity, attackerEmail)) {
    throw new Error(
      `the header should already claim ${attackerEmail}: ${JSON.stringify(header.identity)}`
    );
  }
  if (claims(header.identity, set.meta.senderEmail)) {
    throw new Error(
      `the header still claims the real sender ${set.meta.senderEmail} — this container is not ` +
        'the tamper meta.json says it is'
    );
  }

  if (rejection) {
    let opened;
    try {
      opened = await reader.open(state, { set, container });
    } catch (e) {
      const message = expectRecordedRefusal(e, kind, 'unseal', rejection);
      return `header parsed and claimed ${attackerEmail}; unseal rejected it as recorded: ${message}`;
    }
    throw new Error(
      `this reader is recorded as rejecting a ${kind} container (${rejection.why}) but it just ` +
        `opened one and recovered ${opened.plaintext.length} bytes: it is reporting ` +
        `${attackerEmail} to a user as a verified sender. Fix the reader rather than readers.mjs.`
    );
  }

  const opened = await reader.open(state, { set, container });
  if (!opened.plaintext.equals(container.plaintext)) {
    throw new Error(
      `plaintext mismatch: recovered ${opened.plaintext.length} bytes, expected ` +
        `${container.plaintext.length} — a reader that cannot reject this container should still ` +
        'recover what was sealed in it'
    );
  }
  if (!claims(opened.identity?.public, attackerEmail)) {
    throw new Error(
      `expected the swapped-in ${attackerEmail} as the verified public sender: ` +
        JSON.stringify(opened.identity)
    );
  }
  // The real sender surfaces as a *private* policy: pg-core reports the message
  // signature's policy there whenever it disagrees with the header's, and after
  // a swap they always do. That is what the bug looked like to a user.
  if (!claims(opened.identity?.private, set.meta.senderEmail)) {
    throw new Error(
      `expected the real sender ${set.meta.senderEmail} to surface as a private policy: ` +
        JSON.stringify(opened.identity)
    );
  }
  return (
    `opened as recorded: claims ${attackerEmail}, with the real sender ${set.meta.senderEmail} ` +
    'reported as a private policy'
  );
}

/** The documented mode refusal for this reader, and only that. */
async function expectModeRefusal(reader, state, set, container, refusal) {
  try {
    await reader.open(state, { set, container });
  } catch (e) {
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
  throw new Error(
    `this reader is recorded as unable to open a ${container.mode}-mode container ` +
      `(${refusal}) but it just did — that is a change in the support story: drop the ` +
      'cannotOpen entry in readers.mjs so the corpus starts holding it to the new behaviour'
  );
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

  if (!claims(identity?.public, set.meta.senderEmail)) {
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
      `\n${failures.length} of ${cases} case(s) failed: a container the corpus says must open ` +
        'no longer does — old ciphertexts in the wild fail the same way — or a reader stopped ' +
        'matching what readers.mjs records it does with a tampered one.'
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
