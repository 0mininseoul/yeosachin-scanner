import { describe, expect, it } from 'vitest';
import {
    betaTestFreePoolEnabled,
    ensureBetaTestAccess,
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

    it('uses the service-only enrollment boundary with the server-authenticated user id', async () => {
        const userId = '223e4567-e89b-42d3-a456-426614174000';
        const calls: Array<{ name: string; params?: unknown }> = [];
        await expect(ensureBetaTestAccess({
            rpc: async (name, params) => {
                calls.push({ name, params });
                return { data: true, error: null };
            },
        }, userId)).resolves.toBe(true);
        expect(calls).toEqual([
            { name: 'enroll_analysis_beta_user', params: { p_user_id: userId } },
        ]);

        await expect(ensureBetaTestAccess({
            rpc: async () => ({ data: false, error: null }),
        }, userId)).resolves.toBe(false);
        await expect(ensureBetaTestAccess({
            rpc: async () => ({ data: { allowed: true }, error: null }),
        }, userId)).resolves.toBe(false);
        await expect(ensureBetaTestAccess({
            rpc: async () => { throw new Error('transport'); },
        }, userId)).resolves.toBe(false);
    });
});
