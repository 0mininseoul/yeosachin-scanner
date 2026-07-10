import { describe, expect, it } from 'vitest';
import { getLegacyRunAccess } from './legacy-run-access';

describe('legacy analysis run access', () => {
    it('is disabled by default even for an admin bearer token', () => {
        expect(getLegacyRunAccess('Bearer secret', { ADMIN_API_KEY: 'secret' }))
            .toBe('disabled');
    });

    it('requires both the explicit switch and exact admin authorization', () => {
        const env = {
            ENABLE_LEGACY_ANALYSIS_RUN: 'true',
            ADMIN_API_KEY: 'secret',
        };
        expect(getLegacyRunAccess(null, env)).toBe('forbidden');
        expect(getLegacyRunAccess('Bearer wrong', env)).toBe('forbidden');
        expect(getLegacyRunAccess('Bearer secret', env)).toBe('allowed');
    });
});
