#!/bin/sh
# Provision the one business API key the golden-flow test uses.
#
# The PKG authenticates operators by SHA-256-hashing the raw bearer token and
# matching business_api_keys.key_hash = sha256_hex(PG_API_KEY). We derive that
# hash here, at DB init, from the PG_API_KEY passed into the container, so the
# raw key and its hash never live in committed source.
#
# No PG_API_KEY (e.g. a local `up` without credentials) => no key row, so
# API-key auth is simply unavailable — matching the golden-flow test, which
# skips when PG_API_KEY is unset.
set -eu

if [ -z "${PG_API_KEY:-}" ]; then
    echo "seed: PG_API_KEY not set; skipping business API key provisioning" >&2
    exit 0
fi

key_hash=$(printf %s "$PG_API_KEY" | sha256sum | cut -d ' ' -f 1)

psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname "$POSTGRES_DB" <<SQL
INSERT INTO business_api_keys (key_hash, org_id, signing_attrs, expires_at)
VALUES (
    '${key_hash}',
    '00000000-0000-0000-0000-0000000000a1',
    '{"email": true}'::jsonb,
    NOW() + INTERVAL '365 days'
);
SQL

echo "seed: provisioned business API key (hash derived from PG_API_KEY)" >&2
