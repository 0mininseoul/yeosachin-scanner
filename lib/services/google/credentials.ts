import { writeFileSync } from 'node:fs';
import { join } from 'node:path';

interface ServiceAccountJson {
    client_email: string;
    private_key: string;
    project_id: string;
}

function parseServiceAccountJson(value: string): ServiceAccountJson {
    const parsed: unknown = JSON.parse(value);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
        throw new Error('GOOGLE_CREDENTIALS_ERROR: service account JSON must be an object.');
    }
    const record = parsed as Record<string, unknown>;
    if (
        typeof record.client_email !== 'string'
        || typeof record.private_key !== 'string'
        || typeof record.project_id !== 'string'
        || !record.client_email.endsWith('.iam.gserviceaccount.com')
        || !record.private_key.includes('PRIVATE KEY')
        || record.project_id.length === 0
    ) {
        throw new Error('GOOGLE_CREDENTIALS_ERROR: service account JSON is incomplete.');
    }
    return {
        client_email: record.client_email,
        private_key: record.private_key,
        project_id: record.project_id,
    };
}

export function prepareGoogleApplicationCredentials(
    env: Record<string, string | undefined> = process.env,
    writeCredentials: typeof writeFileSync = writeFileSync
): string | undefined {
    if (env.GOOGLE_APPLICATION_CREDENTIALS) return env.GOOGLE_APPLICATION_CREDENTIALS;
    const encoded = env.GOOGLE_SERVICE_ACCOUNT_KEY_BASE64;
    if (!encoded) return undefined;

    const credentialsJson = Buffer.from(encoded, 'base64').toString('utf8');
    parseServiceAccountJson(credentialsJson);

    const credentialsPath = join('/tmp', 'google-service-account.json');
    writeCredentials(credentialsPath, credentialsJson, { mode: 0o600 });
    env.GOOGLE_APPLICATION_CREDENTIALS = credentialsPath;
    return credentialsPath;
}
