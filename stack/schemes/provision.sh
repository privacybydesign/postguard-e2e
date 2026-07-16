#!/usr/bin/env bash
# Provision the real, published irma-demo scheme into
# schemes/irma_configuration/irma-demo (gitignored), pinned to a fixed commit.
#
# Why the REAL scheme and not irmago's bundled testdata: the testdata irma-demo
# lacks the sidn-pbdf.email credential, so the harness could never issue/disclose
# an actual email identity — the shape the PostGuard SDKs are built around
# (pg-js identifies recipients by pbdf.sidn-pbdf.email.email). The published
# irma-demo scheme mirrors sidn-pbdf.email WITH issuer private keys, letting the
# headless holder be issued and disclose a real email credential (postguard#236).
#
# PINNED (not a floating branch): the scheme is an external contract input, not a
# system under test. A silent upstream scheme change must not turn this harness
# red on an unrelated day. Bump SCHEME_REF deliberately.
#
# Idempotent: if the checkout already sits at SCHEME_REF, it's a no-op.
set -euo pipefail

SCHEME_REPO="https://github.com/privacybydesign/irma-demo-schememanager.git"
SCHEME_REF="97170db9608b705b42487d13db225f8d97c362e9"

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
dest="$here/irma_configuration/irma-demo"

if [ -f "$dest/.provisioned-ref" ] && [ "$(cat "$dest/.provisioned-ref")" = "$SCHEME_REF" ]; then
  echo "irma-demo scheme already at $SCHEME_REF — nothing to do"
  exit 0
fi

echo "provisioning irma-demo scheme @ $SCHEME_REF"
rm -rf "$dest"
mkdir -p "$dest"

# Fetch exactly the pinned commit (works for any SHA, shallow, no full history).
git -C "$dest" init -q
git -C "$dest" remote add origin "$SCHEME_REPO"
git -C "$dest" fetch -q --depth 1 origin "$SCHEME_REF"
git -C "$dest" checkout -q FETCH_HEAD
rm -rf "$dest/.git"
echo "$SCHEME_REF" > "$dest/.provisioned-ref"

echo "provisioned into $dest"
