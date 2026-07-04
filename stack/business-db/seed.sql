-- Minimal postguard-business schema + a seeded API key, just enough for the
-- PKG's API-key lookup (pg-pkg/src/middleware/auth.rs):
--
--   SELECT o.id::text, o.signing_email, o.name, u.phone, o.kvk_number, k.signing_attrs
--   FROM business_api_keys k
--   JOIN organizations o ON o.id = k.org_id
--   LEFT JOIN users u ON u.id = o.contact_user_id
--   WHERE k.key_hash = $1 AND k.expires_at > NOW() AND k.revoked_at IS NULL
--
-- This is NOT the real business schema (owned by postguard-business); it is a
-- test fixture. `signing_attrs = {"email": true}` makes the signing identity
-- carry pbdf.sidn-pbdf.email.email = signing_email, which cryptify requires as
-- the sender's email. The PKG SHA-256 hashes the full bearer token (incl. the
-- "PG-" prefix) and looks up the hash.

CREATE TABLE organizations (
    id              uuid PRIMARY KEY,
    signing_email   text NOT NULL,
    name            text NOT NULL,
    kvk_number      text,
    contact_user_id uuid
);

CREATE TABLE users (
    id    uuid PRIMARY KEY,
    phone text
);

CREATE TABLE business_api_keys (
    key_hash      text PRIMARY KEY,
    org_id        uuid NOT NULL REFERENCES organizations (id),
    signing_attrs jsonb NOT NULL DEFAULT '{}'::jsonb,
    expires_at    timestamptz NOT NULL,
    revoked_at    timestamptz,
    last_used_at  timestamptz
);

INSERT INTO organizations (id, signing_email, name)
VALUES ('00000000-0000-0000-0000-0000000000a1', 'sender@golden.test', 'Golden Flow Test Org');

-- key_hash = sha256_hex(PG_API_KEY)
-- PLACEHOLDER: the value below is a non-functional all-zeros sentinel, NOT a real hash.
-- Operators must supply the real SHA-256 hash via the PG_API_KEY environment variable at
-- deploy time; the raw key and its hash must never be committed to source.
INSERT INTO business_api_keys (key_hash, org_id, signing_attrs, expires_at)
VALUES (
    '0000000000000000000000000000000000000000000000000000000000000000',
    '00000000-0000-0000-0000-0000000000a1',
    '{"email": true}'::jsonb,
    NOW() + INTERVAL '365 days'
);
