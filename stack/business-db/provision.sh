#!/bin/sh
# Provision business-db: SCHEMA from postguard-business's real drizzle
# migrations, DATA from seed-data.sql, plus the one API key the golden flow
# uses.
#
# The schema is NOT written here. It used to be (a hand-rolled 01-schema.sql),
# which meant the harness checked the PKG against this repo's idea of the
# business schema instead of against the real one: postguard-business could
# rename a column the PKG reads and the golden flow stayed green. Now the
# migrations that ship to production are what this database gets, so that
# rename fails the flow.
#
# Runs as a one-shot container after business-db is healthy, not as a Postgres
# initdb script: initdb only fires on an empty data dir, and the image keeps an
# anonymous volume, so an init script silently stopped re-applying after the
# first `up`.
set -eu

migrations=${PGB_MIGRATIONS_DIR:-/src/postguard-business/drizzle/migrations}
journal="$migrations/meta/_journal.json"
seed=${PGB_SEED_FILE:-"$(dirname "$0")/seed-data.sql"}

if [ ! -f "$journal" ]; then
    echo "provision: no drizzle journal at $journal — did the fetch step run?" >&2
    exit 1
fi

# ON_ERROR_STOP so a migration that no longer applies stops the stack here,
# loudly, instead of leaving the PKG to fail later against half a schema.
run_psql() {
    psql -v ON_ERROR_STOP=1 --quiet "$@"
}

# Every `up` re-provisions from scratch: business-db keeps its data in the
# image's anonymous volume, so without this the second run would replay the
# migrations onto tables that already exist.
run_psql -c 'DROP SCHEMA IF EXISTS public CASCADE; CREATE SCHEMA public;'

# The journal is drizzle's own record of migration order; taking the order from
# it rather than from a filename sort keeps this honest if drizzle ever changes
# how it names files.
tags=$(sed -n 's/.*"tag"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' "$journal")
if [ -z "$tags" ]; then
    echo "provision: $journal lists no migrations" >&2
    exit 1
fi

applied=0
for tag in $tags; do
    file="$migrations/$tag.sql"
    if [ ! -f "$file" ]; then
        echo "provision: journal names $tag but $file is missing" >&2
        exit 1
    fi
    echo "provision: applying $tag.sql"
    # No --single-transaction: drizzle's migration-safety checker pushes new
    # migrations towards CREATE INDEX CONCURRENTLY, which cannot run inside a
    # transaction block. The DROP SCHEMA above is what makes a partial apply
    # recoverable instead of sticky.
    run_psql -f "$file"
    applied=$((applied + 1))
done

# A .sql file the journal does not list would have been skipped above without a
# word, and the schema would be quietly incomplete.
on_disk=$(find "$migrations" -maxdepth 1 -name '*.sql' | wc -l)
if [ "$on_disk" -ne "$applied" ]; then
    echo "provision: $migrations holds $on_disk .sql files but the journal lists $applied" >&2
    exit 1
fi

echo "provision: applied $applied migration(s); seeding data"
run_psql -f "$seed"

# The PKG authenticates operators by SHA-256-hashing the raw bearer token and
# matching business_api_keys.key_hash. Deriving the hash here, from the
# PG_API_KEY passed into the container, keeps the raw key and its hash out of
# committed source.
#
# No PG_API_KEY (e.g. a local `up` without credentials) => no key row, so
# API-key auth is simply unavailable — matching the golden-flow test, which
# skips when PG_API_KEY is unset.
if [ -z "${PG_API_KEY:-}" ]; then
    echo "provision: PG_API_KEY not set; skipping business API key provisioning" >&2
    exit 0
fi

key_hash=$(printf %s "$PG_API_KEY" | sha256sum | cut -d ' ' -f 1)
# postguard-business stores the first 10 characters as the display prefix
# (src/lib/server/services/api-keys.ts), so the seeded row looks like a real one.
key_prefix=$(printf %s "$PG_API_KEY" | cut -c 1-10)

run_psql <<SQL
INSERT INTO business_api_keys (key_hash, key_prefix, name, org_id, signing_attrs, expires_at)
VALUES (
    '${key_hash}',
    '${key_prefix}',
    'golden-flow',
    '00000000-0000-0000-0000-0000000000a1',
    '{"email": true}'::jsonb,
    NOW() + INTERVAL '365 days'
);
SQL

echo "provision: provisioned business API key (hash derived from PG_API_KEY)"
