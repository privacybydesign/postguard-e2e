// Flow script for the "modern" @e4a/pg-js API (>=1.0.0). Copied into each
// sandbox as flow.mjs and run there, so the bare `@e4a/pg-js` import resolves
// to the version under test. Prints a single `__RESULT__ <json>` line.
//
// Exercises the non-interactive, server-facing path:
//   fetch params -> encrypt (api-key signing) -> upload -> open().inspect()
// Decryption is intentionally NOT attempted (it needs an interactive Yivi
// session). This is exactly the wire surface a prod server change can break.
import { PostGuard } from '@e4a/pg-js';

const pkgUrl = process.env.PG_PKG_URL;
const cryptifyUrl = process.env.PG_CRYPTIFY_URL;
const apiKey = process.env.PG_API_KEY;
const citizen = process.env.PG_CITIZEN_EMAIL || 'citizen@example.com';
const org = process.env.PG_ORGANISATION_EMAIL || 'noreply@example.org';
// The attribute type recipients are addressed with. A deployment issuing test
// credentials runs its PKG with a demo type (postguard#236) and the SDK has to
// match it; empty means the SDK's production defaults. Versions published
// before the option existed ignore it — the report says which version sent
// what, so that reads as a finding about the version rather than a harness bug.
const emailAttribute = process.env.PG_EMAIL_ATTRIBUTE || '';

// Record the X-POSTGUARD-CLIENT-VERSION the SDK actually sends (null for
// versions predating that feature) by wrapping fetch.
let sentClientVersion = null;
const realFetch = globalThis.fetch;
globalThis.fetch = (input, init) => {
  try {
    const v = new Headers(init?.headers).get('X-POSTGUARD-CLIENT-VERSION');
    if (v && !sentClientVersion) sentClientVersion = v;
  } catch {
    // ignore header inspection failures
  }
  return realFetch(input, init);
};

function emit(obj) {
  console.log('__RESULT__ ' + JSON.stringify(obj));
}

try {
  // Both recipient builders are used below, so both types have to move to the
  // same scheme: the domain attribute is the email credential's other attribute
  // (…email.email / …email.domain), so it is the same type with the last
  // segment swapped rather than a second knob to keep in sync.
  const emailAttributes = emailAttribute
    ? { email: emailAttribute, domain: emailAttribute.replace(/\.email$/, '.domain') }
    : null;
  const pg = new PostGuard({
    pkgUrl,
    cryptifyUrl,
    ...(emailAttributes ? { emailAttributes } : {}),
  });
  const file = new File([new TextEncoder().encode('version-matrix probe')], 'vm.txt', {
    type: 'text/plain',
  });
  const sealed = pg.encrypt({
    files: [file],
    recipients: [pg.recipient.email(citizen), pg.recipient.emailDomain(org)],
    sign: pg.sign.apiKey(apiKey),
  });
  const { uuid } = await sealed.upload();

  // Download + header inspect (no interactive decrypt).
  const opened = pg.open({ uuid });
  await opened.inspect();

  emit({ ok: true, uuid, sentClientVersion });
} catch (err) {
  emit({ ok: false, error: String(err?.message ?? err), sentClientVersion });
  process.exit(1);
}
