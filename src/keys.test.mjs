// The decrypt legs stand on two things this file pins: a key universe that can
// actually be sealed into, and a PKG stub that serves exactly the routes a
// published SDK's decrypt path asks for. A stub that answered everything would
// hide the day an SDK starts asking for a third endpoint, and a universe picked
// from a set with no signing keys would fail at seal time with a message about
// crypto rather than about fixtures.
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { pickUniverse, sealableUniverses, startPkgStub } from './keys.mjs';

test('the sealable universes are the committed sets that carry signing keys', () => {
  const names = sealableUniverses().map((set) => set.name);
  assert.ok(names.length > 0, 'no fixture set can be sealed into');
  // The set generated from the live stack has no signkey.json — nothing can
  // sign as its sender any more — so it must not be offered as sealable.
  assert.ok(!names.includes('pg-wasm-0.6.1'), names.join(', '));
  // Nor is the expected-failure set, whose key universe is the positive 0.6.4
  // set's byte for byte. Without this it would be the DEFAULT pick: it sorts
  // last among the sets sealed by the newest writer.
  assert.ok(!names.includes('pg-core-0.6.4-tampered'), names.join(', '));
});

test('the default universe is sealable and carries everything a seal needs', () => {
  const universe = pickUniverse('');
  assert.ok(universe.mpk, 'no master public key');
  assert.ok(universe.signKeys.pubSignKey?.key, 'no public signing key');
  assert.ok(universe.recipientId, 'no recipient');
  assert.ok(universe.senderEmail, 'no sender to verify against');

  // The policy must carry the SET's timestamp: the committed USK is derived
  // over the policy including it, so a clock here would seal something the
  // universe cannot open.
  const policy = universe.policy[universe.recipientId];
  assert.equal(typeof policy.ts, 'number');
  assert.ok(Array.isArray(policy.con) && policy.con.length > 0);
});

test('naming a set with no signing keys fails with a fixtures message', () => {
  assert.throws(() => pickUniverse('pg-wasm-0.6.1'), /no signkey\.json/);
});

test('the stub serves the verifying key and the USK, and nothing else', async () => {
  const universe = pickUniverse('');
  const stub = await startPkgStub(universe);
  try {
    const vk = await fetch(`${stub.url}/v2/sign/parameters`);
    assert.equal(vk.status, 200);
    assert.equal((await vk.json()).publicKey, JSON.parse(universe.verifyingKeyRaw).publicKey);

    const usk = await fetch(`${stub.url}/v2/irma/key/1704067200`);
    assert.equal(usk.status, 200);
    assert.equal((await usk.json()).key, JSON.parse(universe.uskRaw).key);

    const other = await fetch(`${stub.url}/v2/parameters`);
    assert.equal(other.status, 404);
    assert.match((await other.json()).error, /not \/v2\/parameters/);

    assert.deepEqual(stub.asked(), [
      '/v2/irma/key/1704067200',
      '/v2/parameters',
      '/v2/sign/parameters',
    ]);
  } finally {
    await stub.close();
  }
});
