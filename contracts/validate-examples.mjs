// L1 contract check, stack-free half (EPIC issue #212): the PKG's canonical
// condiscon examples must agree with its JSON Schema — every valid/ example
// schema-valid, every invalid/ example schema-INvalid. The PKG's own test
// suite (pg-pkg/tests/contract_examples.rs) holds the examples against the
// PARSER; this holds them against the SCHEMA. Together they pin
// schema ↔ examples ↔ parser; the live half (yivi-driver contract test)
// closes the loop against the running server.
//
//   npm ci && npm run validate
//
// Reads from the sibling postguard checkout (override with POSTGUARD_ROOT).
import Ajv2020 from 'ajv/dist/2020.js';
import { readdirSync, readFileSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(fileURLToPath(import.meta.url));
const pgRoot = resolve(root, process.env.POSTGUARD_ROOT ?? '../../postguard');
const schemasDir = join(pgRoot, 'pg-pkg/schemas');

const schema = JSON.parse(readFileSync(join(schemasDir, 'irma-auth-request.schema.json'), 'utf8'));
const ajv = new Ajv2020({ allErrors: true });
const validate = ajv.compile(schema);

function examples(kind) {
  const dir = join(schemasDir, 'examples', kind);
  const files = readdirSync(dir).filter((f) => f.endsWith('.json')).sort();
  if (files.length === 0) throw new Error(`no ${kind} examples in ${dir}`);
  return files.map((f) => [f, JSON.parse(readFileSync(join(dir, f), 'utf8'))]);
}

let failed = false;

for (const [name, body] of examples('valid')) {
  if (validate(body)) {
    console.log(`ok  valid/${name}`);
  } else {
    failed = true;
    console.error(`FAIL valid/${name} — schema rejects a canonical valid example:`);
    console.error(ajv.errorsText(validate.errors, { separator: '\n  ' }));
  }
}

for (const [name, body] of examples('invalid')) {
  if (!validate(body)) {
    console.log(`ok  invalid/${name}`);
  } else {
    failed = true;
    console.error(
      `FAIL invalid/${name} — schema ACCEPTS a canonical invalid example (schema laxer than the parser)`
    );
  }
}

if (failed) {
  console.error('\nschema ↔ examples disagreement — fix the schema or the example, deliberately');
  process.exit(1);
}
console.log('\nOK: schema and canonical examples agree');
