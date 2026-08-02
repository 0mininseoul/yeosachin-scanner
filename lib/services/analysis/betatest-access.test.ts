import { describe, expect, it } from 'vitest';
import {
    betaTestFreePoolEnabled,
    hasBetaTestAccess,
} from './betatest-access';

describe('betatest access boundary', () => {
    it('fails closed unless the dedicated pool flag is exactly enabled', () => {
        expect(betaTestFreePoolEnabled({})).toBe(false);
        expect(betaTestFreePoolEnabled({ BETATEST_FREE_POOL_ENABLED: 'false' })).toBe(false);
        expect(betaTestFreePoolEnabled({ BETATEST_FREE_POOL_ENABLED: '1' })).toBe(false);
        expect(betaTestFreePoolEnabled({ BETATEST_FREE_POOL_ENABLED: 'true' })).toBe(true);
    });

    it('uses only the non-enumerable self-check and fails closed on malformed results', async () => {
        const calls: Array<{ name: string; params?: unknown }> = [];
        const allowed = await hasBetaTestAccess({
            rpc: async (name, params) => {
                calls.push({ name, params });
                return { data: true, error: null };
            },
        });

        expect(allowed).toBe(true);
        expect(calls).toEqual([{ name: 'analysis_beta_has_access', params: undefined }]);
        await expect(hasBetaTestAccess({
            rpc: async () => ({ data: { allowed: true }, error: null }),
        })).resolves.toBe(false);
        await expect(hasBetaTestAccess({
            rpc: async () => ({ data: false, error: null }),
        })).resolves.toBe(false);
        await expect(hasBetaTestAccess({
            rpc: async () => ({ data: null, error: { message: 'db' } }),
        })).resolves.toBe(false);
    });
});
