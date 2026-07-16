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
import * as pg from '@e4a/pg-wasm';

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
  } else {
    throw new Error(`unknown op: ${job.op}`);
  }
} catch (e) {
  // Exit only after stdout is flushed — otherwise exiting a pipe can truncate
  // the JSON and the Go caller sees "oracle produced no JSON" instead of this.
  process.stdout.write(JSON.stringify({ ok: false, error: String((e && e.stack) || e) }), () =>
    process.exit(1)
  );
}
