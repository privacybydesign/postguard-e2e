// Seals ONE artifact with the new stack's wire producer, in the new stack's own
// sandbox. Copied into `.sandbox/new-stack/` and run there, so the bare
// `@e4a/pg-wasm` import resolves to the version being treated as "new".
//
// pg-wasm rather than pg-js because pg-js cannot seal into an existing key
// universe: it addresses recipients by email and stamps the policy with the
// current time, and the committed USK only opens the fixture set's own policy
// at the set's own timestamp. pg-wasm takes the policy as an argument, which is
// exactly what `fixtures/README.md` describes for sealing into a set.
//
// STREAM mode, because that is the container pg-js reads (and cryptify stores);
// its memory-mode counterpart is a different wire format that pg-js refuses by
// design (see fixtures/readers.mjs).
//
// Prints a single `__RESULT__ <json>` line, like every other flow here.

import { readFile, writeFile } from 'node:fs/promises';

const job = JSON.parse(process.env.PG_SEAL_JOB ?? '{}');

function emit(obj) {
  console.log('__RESULT__ ' + JSON.stringify(obj));
}

try {
  // The package's default entry is the bundler target, which imports the .wasm
  // as a module specifier plain Node cannot resolve. The web target takes the
  // module bytes as an argument instead, and the .wasm is not in `exports`, so
  // resolve the glue and read its sibling.
  const glue = '@e4a/pg-wasm/web';
  const wasm = await import(glue);
  await wasm.default({
    module_or_path: await readFile(new URL('index_bg.wasm', import.meta.resolve(glue))),
  });

  const plaintext = Buffer.from(job.plaintextB64, 'base64');
  const readable = new ReadableStream({
    start(controller) {
      controller.enqueue(new Uint8Array(plaintext));
      controller.close();
    },
  });
  const chunks = [];
  const writable = new WritableStream({
    write(chunk) {
      chunks.push(Buffer.from(chunk));
    },
  });

  await wasm.sealStream(
    job.mpk,
    { policy: job.policy, pubSignKey: job.pubSignKey },
    readable,
    writable
  );

  const ciphertext = Buffer.concat(chunks);
  if (ciphertext.length === 0) throw new Error('sealStream produced no bytes');
  await writeFile(job.out, ciphertext);
  emit({ ok: true, bytes: ciphertext.length });
} catch (err) {
  emit({ ok: false, error: String(err?.message ?? err) });
  process.exit(1);
}
