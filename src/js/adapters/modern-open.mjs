// Decrypt leg for the "modern" @e4a/pg-js API (>=1.0.0): open an artifact the
// NEW stack sealed, with the OLD published SDK under test. Copied into each
// sandbox as open.mjs and run there, so the bare `@e4a/pg-js` import resolves to
// the version being swept. Prints a single `__RESULT__ <json>` line.
//
// This is the consumer-breaking direction: a deployment updates, its senders
// start producing new bytes, and every recipient still on last year's add-on has
// to keep opening them. The SDK's real decrypt path runs unmodified — inspect
// the header, ask the PKG for the verifying key and the recipient's USK, unseal
// — against a PKG stub that hands back the fixture set's committed keys
// (src/keys.mjs). Where a browser shows a QR code, the session callback returns
// the recipient id: the stub does not check it, because in a deployment the
// check is the PKG's and this leg is not testing the PKG.
//
// A pass means the plaintext came back byte-exact AND the header still named the
// recipient AND the verified sender survived. Recovering bytes while losing the
// sender identity is a wire break too — a reader that shows mail as unsigned
// when it was signed is wrong in the direction that matters most.
import { readFile } from 'node:fs/promises';
import { PostGuard } from '@e4a/pg-js';

const pkgUrl = process.env.PG_OPEN_PKG_URL;
const container = process.env.PG_OPEN_CONTAINER;
const recipient = process.env.PG_OPEN_RECIPIENT;
const expectPlaintext = Buffer.from(process.env.PG_OPEN_EXPECT_PLAINTEXT_B64 ?? '', 'base64');
const expectSender = process.env.PG_OPEN_EXPECT_SENDER;

function emit(obj) {
  console.log('__RESULT__ ' + JSON.stringify(obj));
}

/**
 * The attributes of the verified sender, across both shapes this SDK line has
 * used: 1.x hands back the raw policy (`{ts, con}`), 2.x nests the public
 * policy under `public`. Reading only one shape would report "sender lost" on
 * the major that is merely different, which is the false red that makes a
 * cross-version gate untrustworthy.
 */
function senderAttributes(sender) {
  const raw = sender?.raw ?? sender ?? null;
  if (!raw) return [];
  return raw.public?.con ?? raw.con ?? [];
}

try {
  const data = new Uint8Array(await readFile(container));

  const pg = new PostGuard({ pkgUrl });
  const opened = pg.open({ data });

  // inspect() before decrypt() is the documented consumer pattern (show the
  // recipient list, then decrypt for one of them) and it is the call that reads
  // the multi-recipient header on its own.
  const { recipients } = await opened.inspect();

  const { plaintext, sender } = await opened.decrypt({
    recipient,
    session: async () => recipient,
  });

  const recovered = Buffer.from(plaintext);
  const attributes = senderAttributes(sender);
  const senderEmail = attributes.find((a) => a.t?.endsWith('.email.email'))?.v ?? null;

  if (!recovered.equals(expectPlaintext)) {
    throw new Error(
      `plaintext mismatch: recovered ${recovered.length} bytes, expected ${expectPlaintext.length}`
    );
  }
  if (!recipients.includes(recipient)) {
    throw new Error(
      `header recipients ${JSON.stringify(recipients)} do not include ${recipient}`
    );
  }
  if (expectSender && senderEmail !== expectSender) {
    throw new Error(
      `verified sender is ${senderEmail ?? 'absent'}, expected ${expectSender} ` +
        `(attributes: ${JSON.stringify(attributes)})`
    );
  }

  emit({ ok: true, recipients, senderEmail });
} catch (err) {
  // NetworkError carries the PKG status/body; without them a stub route the SDK
  // newly asks for reads as an unexplained failure.
  const http = typeof err?.status === 'number' ? ` [http ${err.status}] ${err.body}` : '';
  emit({ ok: false, error: String(err?.message ?? err) + http });
  process.exit(1);
}
