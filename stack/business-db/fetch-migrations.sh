#!/bin/sh
# Fetch postguard-business's drizzle migrations into the shared volume that
# provision.sh reads.
#
# postguard-business is the OWNER of the business schema; this stack only
# consumes it. Fetching it here (rather than committing a copy) is what makes a
# schema change over there able to fail the golden flow over here.
#
# Unpinned by default, for the same reason ../../postguard is: it is a system
# under test, and drift is exactly what the harness exists to catch. PGB_REF
# pins it when you need a reproducible local run: a branch, a tag, or a FULL
# commit sha (an abbreviated one is not a ref the remote can serve).
set -eu

repo=${PGB_REPO:-https://github.com/encryption4all/postguard-business.git}
ref=${PGB_REF:-main}
dest=${PGB_DEST:-/src/postguard-business}

# Re-fetched on every `up`: a stale checkout in the volume would silently
# provision yesterday's schema.
rm -rf "$dest"
mkdir -p "$dest"
cd "$dest"

# init + fetch rather than `clone --branch`, so PGB_REF can be a commit sha
# (GitHub allows fetching one directly) and not just a branch or tag.
git init -q .
git remote add origin "$repo"
git fetch -q --depth 1 origin "$ref"
git checkout -q FETCH_HEAD

echo "business schema source: $repo @ $ref ($(git rev-parse HEAD))"
