/**
 * Root secret for the mock database. The seed writes credential rows already encrypted
 * under the key derived from it, and the screenshot run exports it as APP_SECRET, so both
 * sides agree and the app never runs its plaintext-migration-and-VACUUM pass.
 *
 * Not a secret: it only ever protects the inert placeholder values in prisma/mock.db. The
 * real APP_SECRET comes from the environment and is never this value.
 */
export const MOCK_APP_SECRET = "YWRlLW1vY2stc2NyZWVuc2hvdC1jcmVkZW50aWFsLWs=";
