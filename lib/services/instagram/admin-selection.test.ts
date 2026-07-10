import { describe, expect, it } from 'vitest';
import { hasValidAdminAuthorization } from './admin-selection';

describe('scraper provider override admin authorization', () => {
    it('accepts only the exact configured bearer token', () => {
        const env = { ADMIN_API_KEY: 'secret-key' };
        expect(hasValidAdminAuthorization('Bearer secret-key', env)).toBe(true);
        expect(hasValidAdminAuthorization('Bearer wrong', env)).toBe(false);
        expect(hasValidAdminAuthorization(null, env)).toBe(false);
    });

    it('fails closed when ADMIN_API_KEY is not configured', () => {
        expect(hasValidAdminAuthorization('Bearer secret-key', {})).toBe(false);
    });
});
