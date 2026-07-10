# e2e stack

A self-contained docker-compose stack for the PostGuard end-to-end harness
(EPIC issue #203). Unlike `postguard-website`'s dev compose, the **irma-server
here is wired for issuance** of Yivi's bundled test schemes, so a headless
holder (`../yivi-driver`) can issue itself a credential and disclose it — which
is what makes automated end-to-end tests (including decryption) possible.

## Services

| Service | Port | What |
|---|---|---|
| `irma-server` | 8088 | Yivi server with `test` + `irma-demo` schemes **and issuer private keys** (`--privkeys`), so it can *issue*. |
| `postguard-pkg` | 8087 | PKG, built from the sibling `../../postguard` working tree (tests current code). |
| `cryptify` | 8000 | Encrypted file host + email delivery, from `../../cryptify`. |
| `mailcrab` | 1080 (UI), 1025 (SMTP) | Mail sink — recipient notifications are captured, not sent. |
| `business-db` | (internal) | Postgres with a *minimal* business schema + one seeded API key, so the PKG can do API-key signing (`business-db/01-schema.sql` + `02-provision-api-key.sh`). |

Build contexts and bind-mounts point at sibling checkouts (`../../postguard`,
`../../cryptify`, `../../irmago`), so the stack exercises whatever you have
checked out — no published images, no submodules. The irma-server also bind-mounts
`../../postguard-website/docker/irma/jwt_privkey.pem` (read-only) as its JWT
signing key, so `postguard-website` must be checked out alongside too.

## Usage

```bash
docker compose up -d          # first run builds the Rust services (slow)
curl -s localhost:8087/health # PKG
curl -s localhost:8000/health # cryptify
open http://localhost:1080    # mailcrab UI

docker compose down           # stop (add -v to wipe volumes)
```

## How the headless flow reaches it

The irma-server's session pointers advertise `--url http://localhost:8088`, and
its ports are published to the host, so `../yivi-driver` (running on the host)
completes disclosures against the same server the PKG uses internally
(`http://irma-server:8088`). See `../yivi-driver/integration_test.go`.

## Notes

- The PKG gets `DATABASE_URL` pointing at `business-db`, enabling API-key auth.
  The init scripts provision one org (`sender@golden.test`) and one API key
  whose `key_hash` is derived at init as `sha256(PG_API_KEY)` — so the raw key
  and its hash stay out of source; set `PG_API_KEY` to enable API-key auth.
  `signing_attrs = {"email": true}` — this is a test fixture, **not** the real
  business schema. `business-db` has no persistent
  volume, so recreating it (`docker compose up -d --force-recreate business-db`,
  or any `down`+`up`) re-applies the init scripts.
- The irma-server runs `--no-auth` (dev only): requestors need no JWT auth.
- Issuer private keys come from `../../irmago/testdata/privatekeys`; these are
  Yivi's public *test* keys, safe to use — never production keys.
