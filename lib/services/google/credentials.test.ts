import { describe, expect, it, vi } from 'vitest';
import { prepareGoogleApplicationCredentials } from './credentials';

function encodedCredentials() {
    return Buffer.from(JSON.stringify({
        client_email: 'worker@example-project.iam.gserviceaccount.com',
        private_key: '-----BEGIN PRIVATE KEY-----\ntest\n-----END PRIVATE KEY-----\n',
        project_id: 'example-project',
    })).toString('base64');
}

describe('Google application credentials', () => {
    it('materializes the base64 deployment credential with owner-only permissions', () => {
        const env: Record<string, string | undefined> = {
            GOOGLE_SERVICE_ACCOUNT_KEY_BASE64: encodedCredentials(),
        };
        const writeCredentials = vi.fn();

        expect(prepareGoogleApplicationCredentials(env, writeCredentials))
            .toBe('/tmp/google-service-account.json');
        expect(env.GOOGLE_APPLICATION_CREDENTIALS)
            .toBe('/tmp/google-service-account.json');
        expect(writeCredentials).toHaveBeenCalledWith(
            '/tmp/google-service-account.json',
            expect.stringContaining('worker@example-project.iam.gserviceaccount.com'),
            { mode: 0o600 }
        );
    });

    it('preserves an existing ADC path and rejects malformed service-account data', () => {
        const writer = vi.fn();
        expect(prepareGoogleApplicationCredentials({
            GOOGLE_APPLICATION_CREDENTIALS: '/secure/adc.json',
            GOOGLE_SERVICE_ACCOUNT_KEY_BASE64: encodedCredentials(),
        }, writer)).toBe('/secure/adc.json');
        expect(writer).not.toHaveBeenCalled();

        expect(() => prepareGoogleApplicationCredentials({
            GOOGLE_SERVICE_ACCOUNT_KEY_BASE64: Buffer.from('{}').toString('base64'),
        }, writer)).toThrow('GOOGLE_CREDENTIALS_ERROR');
    });
});
