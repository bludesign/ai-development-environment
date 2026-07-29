-- Connection settings now live in the configured credential backend. This migration
-- intentionally does not copy existing values; affected connections must be re-entered.
ALTER TABLE "IosDeviceSettings" DROP COLUMN "appStoreConnectIssuerId";
ALTER TABLE "IosDeviceSettings" DROP COLUMN "appStoreConnectKeyId";

ALTER TABLE "PushNotificationSettings" DROP COLUMN "tokenTeamId";
ALTER TABLE "PushNotificationSettings" DROP COLUMN "tokenKeyId";

DROP INDEX IF EXISTS "ApnsCertificateCredential_name_key";
DROP INDEX IF EXISTS "ApnsCertificateCredential_topic_environment_idx";
ALTER TABLE "ApnsCertificateCredential" DROP COLUMN "name";
ALTER TABLE "ApnsCertificateCredential" DROP COLUMN "topic";
ALTER TABLE "ApnsCertificateCredential" DROP COLUMN "environment";

ALTER TABLE "JiraSettings" DROP COLUMN "siteUrl";
ALTER TABLE "JiraSettings" DROP COLUMN "email";
ALTER TABLE "JiraSettings" DROP COLUMN "webhookUrl";
ALTER TABLE "JiraSettings" DROP COLUMN "webhookJql";

ALTER TABLE "GitHubAppSettings" DROP COLUMN "appId";
ALTER TABLE "GitHubAppSettings" DROP COLUMN "installationId";
ALTER TABLE "GitHubAppSettings" DROP COLUMN "apiBaseUrl";
ALTER TABLE "GitHubAppSettings" DROP COLUMN "graphqlUrl";
ALTER TABLE "GitHubAppSettings" DROP COLUMN "webhookUrl";

DROP TABLE "CacheServerSettings";
