import { describe, expect, it, vi } from 'vitest';
import {
    bindPendingAnalysisTarget,
    clearPendingAnalysisTarget,
    clearPendingAnalysisTargetForTerminalState,
    readPendingAnalysisTargetForAutostart,
    readPendingAnalysisTargetForPreflight,
    signOutAndClearPendingAnalysisTarget,
    storePendingAnalysisTarget,
} from './pending-analysis-target';

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

    it('clears only after a real successful logout response', async () => {
        const successStorage = createStorage();
        storePendingAnalysisTarget(successStorage, 'safe_handle', NOW);
        const successRequest = vi.fn().mockResolvedValue({ ok: true });

        await expect(signOutAndClearPendingAnalysisTarget(successStorage, successRequest))
            .resolves.toBe(true);
        expect(successRequest).toHaveBeenCalledWith('/api/auth/signout', { method: 'POST' });
        expect(successStorage.getItem('pending_ig')).toBeNull();

        const failureStorage = createStorage();
        storePendingAnalysisTarget(failureStorage, 'safe_handle', NOW);
        const failureRequest = vi.fn().mockResolvedValue({ ok: false });
        await expect(signOutAndClearPendingAnalysisTarget(failureStorage, failureRequest))
            .resolves.toBe(false);
        expect(failureStorage.getItem('pending_ig')).not.toBeNull();
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
