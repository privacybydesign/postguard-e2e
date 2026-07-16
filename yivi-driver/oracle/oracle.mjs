// Stateless PostGuard crypto oracle: reads one JSON job from stdin, runs seal
// or unseal via @e4a/pg-wasm, writes one JSON result to stdout. All keys are
// supplied by the caller (the Go golden-flow test fetches them from the PKG);
// this process does no network I/O — it is pure crypto, so the test can drive
// the real Yivi disclosures itself.
//
// Uses the STREAMING format (sealStream / StreamUnsealer) because that is what
// cryptify stores and unseals (UnsealerStreamConfig). The memory-mode seal
// produces an incompatible container.
//
//   seal      in:  {op:"seal", mpk, policy, pubSignKey, privSignKey?, plaintextB64}
//             out: {ok:true, ciphertextB64}
//   unseal    in:  {op:"unseal", ciphertextB64, vk, recipientId, usk}
//             out: {ok:true, plaintextB64, recipients:[...], sender}
//   sealMem   / unsealMem — same shapes, but the MEMORY container format
//             (pg-js `toBytes()`), which differs on the wire from streaming.
//
// The *Sdk ops drive the real high-level @e4a/pg-js SDK instead of raw pg-wasm,
// so the harness tests the exact API surface websites/addons ship. The SDK
// talks to the PKG itself (params, signing keys, USK), so these ops take a
// pkgUrl and do real network I/O — the Go test only drives Yivi + cryptify.
//
//   sealSdk   in:  {op:"sealSdk", pkgUrl, apiKey, recipientEmail, emailAttribute, plaintextB64}
//             out: {ok:true, ciphertextB64}     (apiKey signing; data mode)
//   decryptSdk in: {op:"decryptSdk", pkgUrl, ciphertextB64, jwt, recipientEmail, emailAttribute}
//             out: {ok:true, plaintextB64, sender}  (session callback returns the pre-obtained JWT)
import * as pg from '@e4a/pg-wasm';
import { PostGuard } from '@e4a/pg-js';

const readStdin = () =>
  new Promise((resolve, reject) => {
    let d = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (c) => (d += c));
    process.stdin.on('end', () => resolve(d));
    process.stdin.on('error', reject);
  });

const b64ToU8 = (b64) => new Uint8Array(Buffer.from(b64, 'base64'));
const u8ToB64 = (u8) => Buffer.from(u8).toString('base64');

// A ReadableStream that emits the given bytes once, then closes.
const bytesReadable = (u8) =>
  new ReadableStream({
    start(c) {
      c.enqueue(u8);
      c.close();
    },
  });

// A WritableStream that accumulates chunks; read `.collected()` when done.
function collector() {
  const chunks = [];
  const stream = new WritableStream({
    write(chunk) {
      chunks.push(Buffer.from(chunk));
    },
  });
  return { stream, collected: () => Buffer.concat(chunks) };
}

try {
  const job = JSON.parse(await readStdin());

  if (job.op === 'seal') {
    const options = { policy: job.policy, pubSignKey: job.pubSignKey };
    if (job.privSignKey) options.privSignKey = job.privSignKey;
    const out = collector();
    await pg.sealStream(job.mpk, options, bytesReadable(b64ToU8(job.plaintextB64)), out.stream);
    process.stdout.write(JSON.stringify({ ok: true, ciphertextB64: u8ToB64(out.collected()) }));
  } else if (job.op === 'unseal') {
    const unsealer = await pg.StreamUnsealer.new(bytesReadable(b64ToU8(job.ciphertextB64)), job.vk);
    const recipients = Array.from(unsealer.inspect_header().keys());
    const out = collector();
    const sender = await unsealer.unseal(job.recipientId, job.usk, out.stream);
    process.stdout.write(
      JSON.stringify({ ok: true, plaintextB64: u8ToB64(out.collected()), recipients, sender })
    );
  } else if (job.op === 'sealMem') {
    const options = { policy: job.policy, pubSignKey: job.pubSignKey };
    if (job.privSignKey) options.privSignKey = job.privSignKey;
    const ct = await pg.seal(job.mpk, options, b64ToU8(job.plaintextB64));
    process.stdout.write(JSON.stringify({ ok: true, ciphertextB64: u8ToB64(ct) }));
  } else if (job.op === 'unsealMem') {
    const unsealer = await pg.Unsealer.new(b64ToU8(job.ciphertextB64), job.vk);
    const recipients = Array.from(unsealer.inspect_header().keys());
    const [plaintext, sender] = await unsealer.unseal(job.recipientId, job.usk);
    process.stdout.write(
      JSON.stringify({ ok: true, plaintextB64: u8ToB64(plaintext), recipients, sender })
    );
  } else if (job.op === 'sealSdk') {
    // Real SDK: encrypt raw data to a recipient addressed by email, signed with
    // a business API key. The SDK fetches MPK + signing keys from the PKG.
    const pgc = new PostGuard({
      pkgUrl: job.pkgUrl,
      emailAttributes: { email: job.emailAttribute },
    });
    const sealed = pgc.encrypt({
      data: b64ToU8(job.plaintextB64),
      recipients: [pgc.recipient.email(job.recipientEmail)],
      sign: pgc.sign.apiKey(job.apiKey),
    });
    const ct = await sealed.toBytes();
    process.stdout.write(JSON.stringify({ ok: true, ciphertextB64: u8ToB64(ct) }));
  } else if (job.op === 'decryptSdk') {
    // Real SDK: decrypt via a session callback that returns the JWT the Go
    // headless driver already obtained (the standard pg-js "host runs the
    // session" contract). The SDK fetches the USK and unseals.
    const pgc = new PostGuard({
      pkgUrl: job.pkgUrl,
      emailAttributes: { email: job.emailAttribute },
    });
    const opened = pgc.open({ data: b64ToU8(job.ciphertextB64) });
    const res = await opened.decrypt({
      session: async () => job.jwt,
      recipient: job.recipientEmail,
    });
    process.stdout.write(
      JSON.stringify({ ok: true, plaintextB64: u8ToB64(res.plaintext), sender: res.sender })
    );
  } else {
    throw new Error(`unknown op: ${job.op}`);
  }
} catch (e) {
  // Surface NetworkError HTTP status/body so PKG/cryptify rejections are
  // debuggable from the Go side (otherwise it's just a stack trace).
  let error = String((e && e.stack) || e);
  if (e && typeof e.status === 'number') error += `\n[http ${e.status}] ${e.body}`;
  // Exit only after stdout is flushed — otherwise exiting a pipe can truncate
  // the JSON and the Go caller sees "oracle produced no JSON" instead of this.
  process.stdout.write(JSON.stringify({ ok: false, error }), () => process.exit(1));
}
