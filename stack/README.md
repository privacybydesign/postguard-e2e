# e2e stack

A self-contained docker-compose stack for the PostGuard end-to-end harness
(EPIC issue #203). Unlike `postguard-website`'s dev compose, the **irma-server
here is wired for issuance** of the real, published `irma-demo` scheme, so a
headless holder (`../yivi-driver`) can issue itself a credential — including an
actual `sidn-pbdf.email` identity — and disclose it, which is what makes
automated end-to-end tests (including decryption via the real SDK) possible.

## Services

| Service | Port | What |
|---|---|---|
| `irma-server` | 8088 | Yivi server serving the pinned `irma-demo` scheme with **inline issuer private keys**, so it can *issue* (incl. `sidn-pbdf.email`). |
| `postguard-pkg` | 8087 | PKG, built from the sibling `../../postguard` working tree (tests current code). |
| `cryptify` | 8000 | Encrypted file host + email delivery, from `../../cryptify`. |
| `mailcrab` | 1080 (UI), 1025 (SMTP) | Mail sink — recipient notifications are captured, not sent. |
| `business-db` | (internal) | Postgres with a *minimal* business schema + one seeded API key, so the PKG can do API-key signing (`business-db/01-schema.sql` + `02-provision-api-key.sh`). |

Build contexts and bind-mounts point at sibling checkouts (`../../postguard`,
`../../cryptify`), so the stack exercises whatever you have checked out — no
published images, no submodules. The `irma-demo` scheme is fetched (pinned) by
`schemes/provision.sh` into `schemes/irma_configuration/` (gitignored). The
irma-server's JWT signing key is a throwaway you generate locally (see Usage);
it is gitignored, not a committed secret.

### The three email-attribute knobs (postguard#236)

This stack can only issue `irma-demo` credentials, so the sender's email
identity uses the **demo** attribute type. Three settings must agree, and all
default to the production `pbdf.*` type elsewhere:

- PKG: `PKG_EMAIL_ATTRIBUTE=irma-demo.sidn-pbdf.email.email`
- cryptify: `ROCKET_EMAIL_ATTRIBUTE=irma-demo.sidn-pbdf.email.email`
- SDK/tests: `IRMA_EMAIL_ATTRIBUTE` (Go) / `emailAttributes` (pg-js)

## Usage

```bash
./schemes/provision.sh        # once: fetch the pinned irma-demo scheme (gitignored)
openssl genrsa -out irma/jwt_privkey.pem 2048 && chmod 644 irma/jwt_privkey.pem   # once: throwaway irma-server JWT key (644: the container reads it as a non-root user)
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
  business schema. Postgres keeps its data in an *anonymous* volume (the image's
  built-in `VOLUME`), so `--force-recreate` alone does **not** re-run the init
  scripts — the seed only re-applies after the volume is dropped
  (`docker compose down -v`, or `docker compose rm -fsv business-db` then `up`).
- The irma-server runs `--no-auth` (dev only): requestors need no JWT auth.
- Issuer private keys are the ones bundled *inline* in the pinned `irma-demo`
  scheme; these are Yivi's public *demo* keys, safe to use — never production
  keys. No separate `--privkeys` directory is needed.
