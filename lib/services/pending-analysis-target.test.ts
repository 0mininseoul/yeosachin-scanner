import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
    bindPendingAnalysisTarget,
    clearPendingAnalysisTarget,
    clearPendingAnalysisTargetForTerminalState,
    clearPreflightDisplayTarget,
    clearPreflightDisplayTargetForTerminalState,
    readPendingAnalysisTargetForAutostart,
    readPendingAnalysisTargetForPreflight,
    readPreflightDisplayTarget,
    signOutAndClearPendingAnalysisTarget,
    storePendingAnalysisTarget,
    storePreflightDisplayTarget,
} from './pending-analysis-target';

const analyticsMocks = vi.hoisted(() => ({
    initAmplitude: vi.fn(),
    markAnalyticsIdentityPending: vi.fn(),
    markAnalyticsIdentityReady: vi.fn(),
}));
const browserAuthMocks = vi.hoisted(() => ({
    createClient: vi.fn(),
    signOut: vi.fn(),
}));

vi.mock('./analytics', () => analyticsMocks);
vi.mock('@/lib/supabase/client', () => ({ createClient: browserAuthMocks.createClient }));

const NOW = 1_750_000_000_000;
const OWNER_A = '550e8400-e29b-41d4-a716-446655440000';
const OWNER_B = '7c9e6679-7425-40de-944b-e07fc1f90ae7';
const PREFLIGHT_A = '123e4567-e89b-42d3-a456-426614174000';
const PREFLIGHT_B = '123e4567-e89b-42d3-a456-426614174001';

function createStorage() {
    const values = new Map<string, string>();
    return {
        getItem: vi.fn((key: string) => values.get(key) ?? null),
        removeItem: vi.fn((key: string) => values.delete(key)),
        setItem: vi.fn((key: string, value: string) => values.set(key, value)),
    };
}

describe('pending analysis target ownership', () => {
    beforeEach(() => {
        analyticsMocks.initAmplitude.mockReset().mockResolvedValue(true);
        analyticsMocks.markAnalyticsIdentityPending.mockReset();
        analyticsMocks.markAnalyticsIdentityReady.mockReset();
        browserAuthMocks.signOut.mockReset().mockResolvedValue({ error: null });
        browserAuthMocks.createClient.mockReset().mockReturnValue({
            auth: { signOut: browserAuthMocks.signOut },
        });
    });

    it('stores an unbound target only for the immediate autostart handoff', () => {
        const storage = createStorage();

        expect(storePendingAnalysisTarget(storage, '  @safe.handle_1  ', NOW)).toBe(true);
        expect(readPendingAnalysisTargetForAutostart(storage, NOW + 60_000))
            .toBe('safe.handle_1');
        expect(JSON.parse(storage.setItem.mock.calls[0][1])).toEqual({
            stored_at: NOW,
            target: 'safe.handle_1',
        });
    });

    it('atomically binds a canonical target to its preflight and owner', () => {
        const storage = createStorage();

        expect(bindPendingAnalysisTarget(storage, {
            now: NOW,
            ownerId: OWNER_A,
            preflightId: PREFLIGHT_A,
            target: '@safe.handle_1',
        })).toBe(true);
        expect(JSON.parse(storage.setItem.mock.calls[0][1])).toEqual({
            owner_id: OWNER_A,
            preflight_id: PREFLIGHT_A,
            stored_at: NOW,
            target: 'safe.handle_1',
        });
        expect(readPendingAnalysisTargetForPreflight(storage, {
            now: NOW + 60_000,
            ownerId: OWNER_A,
            preflightId: PREFLIGHT_A,
        })).toBe('safe.handle_1');
    });

    it.each([
        ['wrong owner', PREFLIGHT_A, OWNER_B],
        ['wrong preflight', PREFLIGHT_B, OWNER_A],
    ])('clears a bound target for %s', (_label, preflightId, ownerId) => {
        const storage = createStorage();
        bindPendingAnalysisTarget(storage, {
            now: NOW,
            ownerId: OWNER_A,
            preflightId: PREFLIGHT_A,
            target: 'safe_handle',
        });
        storage.removeItem.mockClear();

        expect(readPendingAnalysisTargetForPreflight(storage, {
            now: NOW + 1,
            ownerId,
            preflightId,
        })).toBeNull();
        expect(storage.removeItem).toHaveBeenCalledWith('pending_ig');
    });

    it('stores and reads one normalized display target bound to a preflight', () => {
        const storage = createStorage();

        expect(storePreflightDisplayTarget(storage, {
            now: NOW,
            preflightId: PREFLIGHT_A,
            target: '  @Target.Name  ',
        })).toBe(true);
        expect(JSON.parse(storage.setItem.mock.calls[0][1])).toEqual({
            preflight_id: PREFLIGHT_A,
            stored_at: NOW,
            target: 'target.name',
        });
        expect(readPreflightDisplayTarget(storage, {
            now: NOW + 60_000,
            preflightId: PREFLIGHT_A,
        })).toBe('target.name');
    });

    const invalidDisplayInputs: Array<[string, string, number]> = [
        ['not-a-uuid', 'safe_target', NOW],
        [PREFLIGHT_A, 'has spaces', NOW],
        [PREFLIGHT_A, '.leading_dot', NOW],
        [PREFLIGHT_A, 'trailing_dot.', NOW],
        [PREFLIGHT_A, 'double..dot', NOW],
        [PREFLIGHT_A, 'a'.repeat(31), NOW],
        [PREFLIGHT_A, 'safe_target', Number.MAX_SAFE_INTEGER + 1],
    ];
    it.each(invalidDisplayInputs)('rejects invalid display record input %j', (preflightId, target, now) => {
        const storage = createStorage();

        expect(storePreflightDisplayTarget(storage, {
            now,
            preflightId,
            target,
        })).toBe(false);
        expect(storage.setItem).not.toHaveBeenCalled();
    });

    it.each([
        ['future', { preflight_id: PREFLIGHT_A, stored_at: NOW + 1, target: 'safe_target' }, NOW],
        ['expired', { preflight_id: PREFLIGHT_A, stored_at: NOW, target: 'safe_target' }, NOW + 30 * 60_000 + 1],
        ['malformed', '{"preflight_id":', NOW],
        ['mismatched', { preflight_id: PREFLIGHT_B, stored_at: NOW, target: 'safe_target' }, NOW],
    ])('removes and ignores a %s display record', (_label, raw, now) => {
        const storage = createStorage();
        storage.setItem('preflight_display_target_v1', typeof raw === 'string' ? raw : JSON.stringify(raw));
        storage.removeItem.mockClear();

        expect(readPreflightDisplayTarget(storage, {
            now,
            preflightId: PREFLIGHT_A,
        })).toBeNull();
        expect(storage.removeItem).toHaveBeenCalledWith('preflight_display_target_v1');
    });

    it('fences explicit cleanup to the stored preflight id', () => {
        const storage = createStorage();
        storePreflightDisplayTarget(storage, {
            now: NOW,
            preflightId: PREFLIGHT_A,
            target: 'safe_target',
        });

        expect(clearPreflightDisplayTarget(storage, PREFLIGHT_B)).toBe(false);
        expect(readPreflightDisplayTarget(storage, {
            now: NOW,
            preflightId: PREFLIGHT_A,
        })).toBe('safe_target');
        expect(clearPreflightDisplayTarget(storage, PREFLIGHT_A)).toBe(true);
        expect(readPreflightDisplayTarget(storage, {
            now: NOW,
            preflightId: PREFLIGHT_A,
        })).toBeNull();
    });

    it.each(['ready', 'blocked', 'expired', 'consumed', 'completed', 'failed']) (
        'clears a matching display record for terminal state %s',
        status => {
            const storage = createStorage();
            storePreflightDisplayTarget(storage, {
                now: NOW,
                preflightId: PREFLIGHT_A,
                target: 'safe_target',
            });

            expect(clearPreflightDisplayTargetForTerminalState(storage, {
                preflightId: PREFLIGHT_A,
                status,
            })).toBe(true);
            expect(readPreflightDisplayTarget(storage, {
                now: NOW,
                preflightId: PREFLIGHT_A,
            })).toBeNull();
        },
    );

    it('retains a matching display record while pending and fails open when storage throws', () => {
        const storage = createStorage();
        storePreflightDisplayTarget(storage, {
            now: NOW,
            preflightId: PREFLIGHT_A,
            target: 'safe_target',
        });
        expect(clearPreflightDisplayTargetForTerminalState(storage, {
            preflightId: PREFLIGHT_A,
            status: 'pending',
        })).toBe(false);

        const unavailable = {
            getItem: vi.fn(() => { throw new Error('unavailable'); }),
            removeItem: vi.fn(() => { throw new Error('unavailable'); }),
            setItem: vi.fn(() => { throw new Error('unavailable'); }),
        };
        expect(storePreflightDisplayTarget(unavailable, {
            now: NOW,
            preflightId: PREFLIGHT_A,
            target: 'safe_target',
        })).toBe(false);
        expect(readPreflightDisplayTarget(unavailable, {
            now: NOW,
            preflightId: PREFLIGHT_A,
        })).toBeNull();
        expect(() => clearPreflightDisplayTarget(unavailable, PREFLIGHT_A)).not.toThrow();
    });

    it('never uses an arbitrary unbound target to resume a URL preflight', () => {
        const storage = createStorage();
        storePendingAnalysisTarget(storage, 'unbound_target', NOW);
        storage.removeItem.mockClear();

        expect(readPendingAnalysisTargetForPreflight(storage, {
            now: NOW + 1,
            ownerId: OWNER_A,
            preflightId: PREFLIGHT_A,
        })).toBeNull();
        expect(storage.removeItem).toHaveBeenCalledWith('pending_ig');
    });

    it('does not reuse a bound target as a fresh autostart handoff', () => {
        const storage = createStorage();
        bindPendingAnalysisTarget(storage, {
            now: NOW,
            ownerId: OWNER_A,
            preflightId: PREFLIGHT_A,
            target: 'bound_target',
        });
        storage.removeItem.mockClear();

        expect(readPendingAnalysisTargetForAutostart(storage, NOW + 1)).toBeNull();
        expect(storage.removeItem).toHaveBeenCalledWith('pending_ig');
    });

    it.each([
        '',
        '@',
        'a'.repeat(31),
        'has spaces',
        'https://example.com',
        'person@example.com',
    ])('rejects unsafe or unbounded target %j', (target) => {
        const storage = createStorage();

        expect(storePendingAnalysisTarget(storage, target, NOW)).toBe(false);
        expect(storage.setItem).not.toHaveBeenCalled();
    });

    it('rejects non-canonical binding identities', () => {
        const storage = createStorage();

        expect(bindPendingAnalysisTarget(storage, {
            now: NOW,
            ownerId: 'person@example.com',
            preflightId: PREFLIGHT_A,
            target: 'safe_handle',
        })).toBe(false);
        expect(bindPendingAnalysisTarget(storage, {
            now: NOW,
            ownerId: OWNER_A,
            preflightId: 'not-a-uuid',
            target: 'safe_handle',
        })).toBe(false);
        expect(storage.setItem).not.toHaveBeenCalled();
    });

    it('expires and removes stale, malformed, or partially bound records', () => {
        const storage = createStorage();
        storePendingAnalysisTarget(storage, 'safe_handle', NOW);

        expect(readPendingAnalysisTargetForAutostart(storage, NOW + 30 * 60_000 + 1))
            .toBeNull();
        expect(storage.removeItem).toHaveBeenCalledWith('pending_ig');

        storage.setItem('pending_ig', JSON.stringify({
            owner_id: OWNER_A,
            stored_at: NOW,
            target: 'safe_handle',
        }));
        expect(readPendingAnalysisTargetForAutostart(storage, NOW)).toBeNull();
    });

    it.each(['ready', 'blocked', 'expired', 'consumed', 'completed', 'failed']) (
        'clears the handoff at terminal state %s',
        (status) => {
            const storage = createStorage();
            storePendingAnalysisTarget(storage, 'safe_handle', NOW);

            expect(clearPendingAnalysisTargetForTerminalState(storage, status)).toBe(true);
            expect(storage.getItem('pending_ig')).toBeNull();
        },
    );

    it('retains a bound handoff while its preflight is pending', () => {
        const storage = createStorage();
        storePendingAnalysisTarget(storage, 'safe_handle', NOW);

        expect(clearPendingAnalysisTargetForTerminalState(storage, 'pending')).toBe(false);
        expect(storage.getItem('pending_ig')).not.toBeNull();
    });

    it('uses browser auth and anonymizes analytics before clearing a successful logout', async () => {
        const successStorage = createStorage();
        storePendingAnalysisTarget(successStorage, 'safe_handle', NOW);
        successStorage.removeItem.mockClear();

        await expect(signOutAndClearPendingAnalysisTarget(successStorage))
            .resolves.toBe(true);
        expect(browserAuthMocks.createClient).toHaveBeenCalledTimes(1);
        expect(browserAuthMocks.signOut).toHaveBeenCalledTimes(1);
        expect(analyticsMocks.markAnalyticsIdentityPending).toHaveBeenCalledTimes(1);
        expect(analyticsMocks.initAmplitude).toHaveBeenCalledWith(null);
        expect(analyticsMocks.markAnalyticsIdentityReady).toHaveBeenCalledTimes(1);
        expect(successStorage.getItem('pending_ig')).toBeNull();

        expect(browserAuthMocks.signOut.mock.invocationCallOrder[0])
            .toBeLessThan(analyticsMocks.markAnalyticsIdentityPending.mock.invocationCallOrder[0]);
        expect(analyticsMocks.markAnalyticsIdentityPending.mock.invocationCallOrder[0])
            .toBeLessThan(analyticsMocks.initAmplitude.mock.invocationCallOrder[0]);
        expect(analyticsMocks.initAmplitude.mock.invocationCallOrder[0])
            .toBeLessThan(analyticsMocks.markAnalyticsIdentityReady.mock.invocationCallOrder[0]);
        expect(analyticsMocks.markAnalyticsIdentityReady.mock.invocationCallOrder[0])
            .toBeLessThan(successStorage.removeItem.mock.invocationCallOrder[0]);
    });

    it('leaves target and analytics identity untouched when browser sign out fails', async () => {
        const failureStorage = createStorage();
        storePendingAnalysisTarget(failureStorage, 'safe_handle', NOW);
        failureStorage.removeItem.mockClear();
        const signOut = vi.fn().mockResolvedValue({
            error: new Error('private provider detail'),
        });

        await expect(signOutAndClearPendingAnalysisTarget(failureStorage, signOut))
            .resolves.toBe(false);
        expect(signOut).toHaveBeenCalledWith();
        expect(failureStorage.getItem('pending_ig')).not.toBeNull();
        expect(failureStorage.removeItem).not.toHaveBeenCalled();
        expect(analyticsMocks.markAnalyticsIdentityPending).not.toHaveBeenCalled();
        expect(analyticsMocks.initAmplitude).not.toHaveBeenCalled();
        expect(analyticsMocks.markAnalyticsIdentityReady).not.toHaveBeenCalled();
    });

    it('clears without throwing when storage is unavailable', () => {
        const storage = {
            getItem: vi.fn(() => {
                throw new Error('unavailable');
            }),
            removeItem: vi.fn(() => {
                throw new Error('unavailable');
            }),
            setItem: vi.fn(() => {
                throw new Error('unavailable');
            }),
        };

        expect(() => clearPendingAnalysisTarget(storage)).not.toThrow();
        expect(readPendingAnalysisTargetForAutostart(storage, NOW)).toBeNull();
        expect(storePendingAnalysisTarget(storage, 'safe_handle', NOW)).toBe(false);
    });
});
