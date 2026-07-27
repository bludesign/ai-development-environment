/**
 * Encryption key for the mock database's credential rows. The seed writes credentials already
 * encrypted under this key and the screenshot run exports it as CREDENTIAL_ENCRYPTION_KEY, so
 * both sides agree and the app never runs its plaintext-migration-and-VACUUM pass.
 *
 * Not a secret: it only ever protects the inert placeholder values in prisma/mock.db. The real
 * key comes from the environment and is never this value.
 */
export const MOCK_CREDENTIAL_ENCRYPTION_KEY =
  "YWRlLW1vY2stc2NyZWVuc2hvdC1jcmVkZW50aWFsLWs=";
