-- Test DATA for the e2e business-db. No DDL: the schema comes from
-- postguard-business's drizzle migrations, applied by provision.sh.
--
-- One organisation and its contact user, which together supply everything the
-- PKG's API-key lookup reads (pg-pkg/src/middleware/auth.rs):
--
--   SELECT o.id::text, o.signing_email, o.name, u.phone, o.kvk_number, k.signing_attrs
--   FROM business_api_keys k
--   JOIN organizations o ON o.id = k.org_id
--   LEFT JOIN users u ON u.id = o.contact_user_id
--   WHERE k.key_hash = $1 AND k.expires_at > NOW() AND k.revoked_at IS NULL
--
-- The matching business_api_keys row is inserted by provision.sh, which
-- derives key_hash from PG_API_KEY so neither the raw key nor its hash is
-- committed.
--
-- signing_attrs = {"email": true} on that row is what makes the signing
-- identity carry sidn-pbdf.email.email = signing_email, which cryptify
-- requires as the sender's email and TestGoldenFlow asserts on.

INSERT INTO organizations (id, name, domain, signing_email, kvk_number, status)
VALUES (
    '00000000-0000-0000-0000-0000000000a1',
    'Golden Flow Test Org',
    'golden.test',
    'sender@golden.test',
    '12345678',
    'active'
);

-- phone lives on users since the 0001 migration; seeding it keeps the LEFT
-- JOIN in the lookup above carrying a real value rather than always NULL.
INSERT INTO users (id, email, full_name, phone, org_id)
VALUES (
    '00000000-0000-0000-0000-0000000000b1',
    'sender@golden.test',
    'Golden Flow Sender',
    '+31600000000',
    '00000000-0000-0000-0000-0000000000a1'
);

UPDATE organizations
SET contact_user_id = '00000000-0000-0000-0000-0000000000b1'
WHERE id = '00000000-0000-0000-0000-0000000000a1';
