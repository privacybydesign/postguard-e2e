// Verifies every committed crypto-compat fixture set with the PINNED
// published @e4a/pg-wasm (EPIC issue #206): each ciphertext must still
// unseal to the recorded plaintext with the recorded sender. If this fails,
// client-side wire-format compatibility broke — ciphertexts in the wild
// (old encrypted emails/files) would fail the same way.
//
//   npm ci && npm run verify
//
// The sibling `fixtures-verify/` crate runs the same check against the
// CURRENT working-tree pg-core (the server/library side of the contract).
import * as pg from '@e4a/pg-wasm';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(fileURLToPath(import.meta.url));

const bytesReadable = (u8) =>
  new ReadableStream({
    start(c) {
      c.enqueue(u8);
      c.close();
    },
  });

function collector() {
  const chunks = [];
  const stream = new WritableStream({
    write(chunk) {
      chunks.push(Buffer.from(chunk));
    },
  });
  return { stream, collected: () => Buffer.concat(chunks) };
}

function assertSender(sender, wantEmail, label) {
  const con = sender?.public?.con ?? [];
  const ok = con.some((a) => a.t === 'pbdf.sidn-pbdf.email.email' && a.v === wantEmail);
  if (!ok) {
    throw new Error(`${label}: verified sender missing email=${wantEmail}: ${JSON.stringify(sender)}`);
  }
}

let sets = 0;
for (const entry of readdirSync(root)) {
  const dir = join(root, entry);
  if (!statSync(dir).isDirectory() || entry === 'node_modules') continue;

  const meta = JSON.parse(readFileSync(join(dir, 'meta.json'), 'utf8'));
  const vk = JSON.parse(readFileSync(join(dir, 'vk.json'), 'utf8')).publicKey;
  const usk = JSON.parse(readFileSync(join(dir, 'usk.json'), 'utf8')).key;
  const want = Buffer.from(meta.plaintextB64, 'base64');

  // Streaming container.
  {
    const ct = new Uint8Array(readFileSync(join(dir, 'stream.bin')));
    const unsealer = await pg.StreamUnsealer.new(bytesReadable(ct), vk);
    const out = collector();
    const sender = await unsealer.unseal(meta.recipientId, usk, out.stream);
    if (!out.collected().equals(want)) throw new Error(`${entry}/stream.bin: plaintext mismatch`);
    assertSender(sender, meta.senderEmail, `${entry}/stream.bin`);
  }

  // In-memory container.
  {
    const ct = new Uint8Array(readFileSync(join(dir, 'mem.bin')));
    const unsealer = await pg.Unsealer.new(ct, vk);
    const [plaintext, sender] = await unsealer.unseal(meta.recipientId, usk);
    if (!Buffer.from(plaintext).equals(want)) throw new Error(`${entry}/mem.bin: plaintext mismatch`);
    assertSender(sender, meta.senderEmail, `${entry}/mem.bin`);
  }

  console.log(`ok  ${entry} (sealed by ${meta.sealedBy}, ${meta.generatedAt}) — stream + mem unseal, sender verified`);
  sets++;
}

if (sets === 0) {
  console.error('no fixture sets found — that itself is a failure');
  process.exit(1);
}
console.log(`\nOK: ${sets} fixture set(s) verified with published @e4a/pg-wasm`);
